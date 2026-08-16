import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { unreadCount } from './notification.service.js'
import { render, sendMessage } from '../messaging/message.service.js'
import { env } from '../../config/env.js'

/**
 * The bell (M16). Every query is scoped to `req.user.id` — there is no path
 * through this router that reads another account's notifications.
 */
export const notificationRouter: Router = Router()

notificationRouter.use(requireAuth)

const listQuery = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

notificationRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const q = req.validated!.query as z.infer<typeof listQuery>

  const where = {
    userId: req.user!.id,
    ...(q.unreadOnly ? { readAt: null } : {}),
  }

  const [total, notifications, unread] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
    }),
    unreadCount(req.user!.id),
  ])

  return ok(res, { notifications, unread }, { pagination: pageMeta(q.page, q.perPage, total) })
})

notificationRouter.post('/:id/read', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }

  // updateMany with the user in the WHERE, so an id from another account
  // simply matches nothing rather than being readable.
  const result = await prisma.notification.updateMany({
    where: { id, userId: req.user!.id, readAt: null },
    data: { readAt: new Date() },
  })
  if (result.count === 0) {
    const exists = await prisma.notification.findFirst({
      where: { id, userId: req.user!.id },
      select: { id: true },
    })
    if (!exists) throw new NotFoundError('Notification', 'NOTIFICATION_NOT_FOUND')
  }

  return ok(res, { read: true, unread: await unreadCount(req.user!.id) })
})

/** Undo, for a notification opened by accident (FR-16.3). */
notificationRouter.post('/:id/unread', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }

  const result = await prisma.notification.updateMany({
    where: { id, userId: req.user!.id },
    data: { readAt: null },
  })
  if (result.count === 0) throw new NotFoundError('Notification', 'NOTIFICATION_NOT_FOUND')

  return ok(res, { read: false, unread: await unreadCount(req.user!.id) })
})

notificationRouter.post('/read-all', writeLimiter, async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null },
    data: { readAt: new Date() },
  })
  return ok(res, { markedRead: result.count, unread: 0 })
})

/**
 * Clearing a notification (FR-16.3).
 *
 * A real delete rather than a hidden flag: the record has no value once the
 * recipient has dismissed it, and the audit log is where lasting history
 * belongs. Scoped by userId, so an id from another account matches nothing.
 */
notificationRouter.delete('/:id', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }

  const result = await prisma.notification.deleteMany({ where: { id, userId: req.user!.id } })
  if (result.count === 0) throw new NotFoundError('Notification', 'NOTIFICATION_NOT_FOUND')

  return ok(res, { cleared: true, unread: await unreadCount(req.user!.id) })
})

/** Clears everything already read, leaving anything unseen alone. */
notificationRouter.delete('/', writeLimiter, async (req, res) => {
  const result = await prisma.notification.deleteMany({
    where: { userId: req.user!.id, readAt: { not: null } },
  })
  return ok(res, { cleared: result.count, unread: await unreadCount(req.user!.id) })
})

// -------------------------------------------------------------- preferences

const CHANNELS = ['EMAIL', 'WHATSAPP', 'SMS', 'IN_APP'] as const

export const preferenceRouter: Router = Router()

preferenceRouter.use(requireAuth)

preferenceRouter.get('/', async (req, res) => {
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ channel: 'asc' }, { type: 'asc' }],
  })
  return ok(res, { preferences })
})

const preferenceSchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: z.enum(CHANNELS),
        /** "*" covers the whole channel; a specific key overrides it. */
        type: z.string().trim().min(1).max(80),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(60),
})

preferenceRouter.put('/', writeLimiter, validate({ body: preferenceSchema }), async (req, res) => {
  const { preferences } = req.validated!.body as z.infer<typeof preferenceSchema>
  const userId = req.user!.id

  await prisma.$transaction(
    preferences.map((p) =>
      prisma.notificationPreference.upsert({
        where: { userId_channel_type: { userId, channel: p.channel, type: p.type } },
        create: { userId, channel: p.channel, type: p.type, enabled: p.enabled },
        update: { enabled: p.enabled },
      }),
    ),
  )

  return ok(res, {
    preferences: await prisma.notificationPreference.findMany({
      where: { userId },
      orderBy: [{ channel: 'asc' }, { type: 'asc' }],
    }),
  })
})

// ------------------------------------------------------- admin: templates

export const adminMessageRouter: Router = Router()

adminMessageRouter.get('/templates', requirePermission('message.manage'), async (_req, res) => {
  const templates = await prisma.messageTemplate.findMany({
    orderBy: [{ channel: 'asc' }, { key: 'asc' }],
  })
  return ok(res, { templates })
})

const templateSchema = z.object({
  key: z.string().trim().min(2).max(80),
  channel: z.enum(CHANNELS),
  name: z.string().trim().min(2).max(120),
  subject: z.string().trim().max(300).optional().nullable(),
  body: z.string().trim().min(1).max(20_000),
  providerTemplateId: z.string().trim().max(160).optional().nullable(),
  variables: z.array(z.string().trim().max(60)).max(40).default([]),
  isActive: z.boolean().default(true),
})

adminMessageRouter.put(
  '/templates',
  writeLimiter,
  requirePermission('message.manage'),
  validate({ body: templateSchema }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof templateSchema>

    const template = await prisma.messageTemplate.upsert({
      where: { key_channel: { key: body.key, channel: body.channel } },
      create: {
        ...body,
        subject: body.subject ?? null,
        providerTemplateId: body.providerTemplateId ?? null,
      },
      update: {
        name: body.name,
        subject: body.subject ?? null,
        body: body.body,
        providerTemplateId: body.providerTemplateId ?? null,
        variables: body.variables,
        isActive: body.isActive,
      },
    })

    recordAudit({
      action: 'MESSAGE_TEMPLATE_SAVED',
      entityType: 'MessageTemplate',
      entityId: template.id,
      metadata: { key: body.key, channel: body.channel },
      req,
    })

    return created(res, { template })
  },
)

/**
 * Sample values for a preview.
 *
 * Deliberately obvious placeholders rather than realistic-looking data: the
 * point of a preview is to check the wording and spot an unsubstituted
 * `{{variable}}`, and a preview full of plausible names invites reading it as
 * a real message.
 */
const SAMPLES: Record<string, string> = {
  name: 'Priya Sharma',
  orderNumber: 'ORD-2026-00042',
  total: '₹12,500.00',
  amount: '₹12,500.00',
  itemCount: '2',
  items: '1 × Amaira Halterneck Column Dress, 1 × Kiran Silk Scarf',
  trackingNumber: 'TRK123456789',
  trackingUrl: 'https://example.com/track/TRK123456789',
  carrier: 'Demo Logistics',
  url: 'https://example.com/reset/sample-token',
  expiresInMinutes: '30',
  returnNumber: 'RET-2026-00007',
  status: 'Approved',
  note: 'Refund will follow within 5 working days.',
  reason: 'Card declined',
  role: 'Support',
  inviteUrl: 'https://example.com/invite/sample-token',
}

function sampleFor(variables: string[], overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {}
  for (const key of variables) {
    // An unknown placeholder shows its own name, so a typo in the template is
    // visible in the preview rather than rendering as a blank.
    values[key] = overrides[key] ?? SAMPLES[key] ?? `«${key}»`
  }
  return { ...values, ...overrides }
}

const previewSchema = z.object({
  key: z.string().trim().min(2).max(80),
  channel: z.enum(CHANNELS),
  /** Unsaved edits — preview what is on screen, not what is stored. */
  subject: z.string().max(300).optional().nullable(),
  body: z.string().max(20_000).optional(),
  variables: z.record(z.string(), z.string().max(300)).optional(),
})

/**
 * Renders a template without sending it (FR-15.4).
 *
 * Takes the subject and body from the request when supplied so an admin can
 * preview an edit before saving it — previewing only what is already stored
 * would mean saving to find out, which is how a broken template reaches a
 * customer.
 */
adminMessageRouter.post(
  '/templates/preview',
  requirePermission('message.manage'),
  validate({ body: previewSchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof previewSchema>

    const template = await prisma.messageTemplate.findUnique({
      where: { key_channel: { key: input.key, channel: input.channel } },
    })
    if (!template) throw new NotFoundError('Template', 'TEMPLATE_NOT_FOUND')

    const subjectSource = input.subject !== undefined ? input.subject : template.subject
    const bodySource = input.body ?? template.body

    const values = sampleFor(template.variables, input.variables)

    // Placeholders in the template that the template does not declare — the
    // usual cause of a blank in a live message.
    const used = [...bodySource.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])
    const undeclared = [...new Set(used)].filter((name) => !template.variables.includes(name))

    return ok(res, {
      subject: subjectSource ? render(subjectSource, values) : null,
      body: render(bodySource, values),
      usedVariables: values,
      undeclared,
    })
  },
)

const testSendSchema = z.object({
  key: z.string().trim().min(2).max(80),
  channel: z.enum(CHANNELS),
})

/**
 * Sends a real message through the real pipeline, to the admin themselves.
 *
 * The recipient is taken from the session and is not a parameter. An endpoint
 * that sends templated mail to an arbitrary address is an open relay with a
 * login, and it would be found: the whole value here is proving the provider
 * and the template work, which sending to yourself does just as well.
 *
 * `userId` is deliberately omitted from the send so a test is not silently
 * swallowed by the admin's own marketing preferences.
 */
adminMessageRouter.post(
  '/templates/test-send',
  writeLimiter,
  requirePermission('message.manage'),
  validate({ body: testSendSchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof testSendSchema>

    const template = await prisma.messageTemplate.findUnique({
      where: { key_channel: { key: input.key, channel: input.channel } },
    })
    if (!template) throw new NotFoundError('Template', 'TEMPLATE_NOT_FOUND')

    const me = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { email: true, phone: true },
    })

    const recipient = input.channel === 'EMAIL' ? me.email : me.phone
    if (!recipient) {
      throw new ValidationError(
        `Add a phone number to your own account before testing ${input.channel.toLowerCase()}`,
        { code: 'NO_TEST_RECIPIENT' },
      )
    }

    const result = await sendMessage({
      channel: input.channel,
      key: input.key,
      recipient,
      variables: sampleFor(template.variables),
      entityType: 'MessageTemplate',
      entityId: template.id,
    })

    recordAudit({
      action: 'MESSAGE_TEST_SENT',
      entityType: 'MessageTemplate',
      entityId: template.id,
      metadata: { key: input.key, channel: input.channel, sent: result.sent },
      req,
    })

    return ok(res, {
      sent: result.sent,
      reason: result.reason ?? null,
      recipient,
      // Which provider actually handled it, so "sent" is not mistaken for
      // "arrived" when the console provider is still configured.
      provider: input.channel === 'EMAIL' ? env.EMAIL_PROVIDER : env.SMS_PROVIDER,
    })
  },
)

const logQuery = z.object({
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
})

/** The answer to "did that customer ever get their confirmation?". */
adminMessageRouter.get(
  '/logs',
  requirePermission('message.manage'),
  validate({ query: logQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof logQuery>

    const where = {
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
    }

    const [total, logs] = await Promise.all([
      prisma.messageLog.count({ where }),
      prisma.messageLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: { template: { select: { key: true, name: true } } },
      }),
    ])

    return ok(res, { logs }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)
