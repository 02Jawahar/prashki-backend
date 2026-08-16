import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { unreadCount } from './notification.service.js'

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

notificationRouter.post('/read-all', writeLimiter, async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null },
    data: { readAt: new Date() },
  })
  return ok(res, { markedRead: result.count, unread: 0 })
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
