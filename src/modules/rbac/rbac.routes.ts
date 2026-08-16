import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { maskContact } from '../../utils/pii.js'
import { generateOpaqueToken } from '../../utils/tokens.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { sendMessage } from '../messaging/message.service.js'
import { replayWebhookEvent } from '../webhooks/webhook.service.js'
import {
  LOCKED_ROLE_KEY,
  assertCanGrant,
  assertNotSelf,
  assertRecoveryPathSurvives,
  permissionCatalogue,
  permissionsOfRoles,
  resolveRoles,
  roleInclude,
  serializeRole,
} from './rbac.service.js'

// ─────────────────────────────────────────────────────────── permissions

/**
 * The permission catalogue (FR-24.1).
 *
 * Read-only on purpose. Permissions are the vocabulary the code is written
 * against — `requirePermission('refund.create')` is in the source — so an
 * admin inventing a new key at runtime would create one that nothing checks.
 * Roles are the configurable layer; permissions are the fixed one.
 */
export const adminPermissionRouter: Router = Router()

adminPermissionRouter.get('/', requirePermission('role.manage'), async (_req, res) =>
  ok(res, await permissionCatalogue()),
)

// ────────────────────────────────────────────────────────────────── roles

export const adminRoleRouter: Router = Router()

const roleBody = z.object({
  name: z.string().trim().min(2, 'Give the role a name').max(80),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.string().trim().min(1)).max(200).default([]),
})

adminRoleRouter.get('/', requirePermission('role.manage'), async (_req, res) => {
  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    include: roleInclude,
  })
  return ok(res, { roles: roles.map(serializeRole) })
})

adminRoleRouter.get('/:id', requirePermission('role.manage'), async (req, res) => {
  const { id } = req.params as { id: string }
  const role = await prisma.role.findUnique({ where: { id }, include: roleInclude })
  if (!role) throw new NotFoundError('Role', 'ROLE_NOT_FOUND')
  return ok(res, { role: serializeRole(role) })
})

/** Turns a name into a stable, unique key. Keys never change after creation. */
async function uniqueRoleKey(name: string): Promise<string> {
  const base =
    name
      .toUpperCase()
      .normalize('NFKD')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'ROLE'

  let candidate = base
  for (let i = 2; i < 100; i++) {
    const clash = await prisma.role.findUnique({ where: { key: candidate }, select: { id: true } })
    if (!clash) return candidate
    candidate = `${base}_${i}`
  }
  return `${base}_${Date.now()}`
}

/** Rejects any permission key that is not in the catalogue. */
async function assertPermissionsExist(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []

  const found = await prisma.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true },
  })
  if (found.length !== new Set(keys).size) {
    const known = new Set(found.map((p) => p.key))
    throw new ValidationError('Unknown permission', {
      permissions: keys.filter((k) => !known.has(k)),
    })
  }
  return found.map((p) => p.id)
}

adminRoleRouter.post(
  '/',
  writeLimiter,
  requirePermission('role.manage'),
  validate({ body: roleBody }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof roleBody>

    // No granting what you do not hold — see the service for why.
    /**
     * Existence before authorisation. A typo'd permission key is a bad
     * request, and answering it with "you cannot grant that" sends whoever
     * wrote the typo looking for a permissions problem they do not have.
     */
    const permissionIds = await assertPermissionsExist(body.permissions)
    assertCanGrant(body.permissions, req.user!.permissions)

    const role = await prisma.role.create({
      data: {
        key: await uniqueRoleKey(body.name),
        name: body.name,
        description: body.description ?? null,
        isSystem: false,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
      include: roleInclude,
    })

    recordAudit({
      action: 'ROLE_CREATED',
      entityType: 'Role',
      entityId: role.id,
      metadata: { key: role.key, permissions: body.permissions.sort() },
      req,
    })

    return created(res, { role: serializeRole(role) })
  },
)

adminRoleRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('role.manage'),
  validate({ body: roleBody }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof roleBody>

    const existing = await prisma.role.findUnique({ where: { id }, include: roleInclude })
    if (!existing) throw new NotFoundError('Role', 'ROLE_NOT_FOUND')

    if (existing.key === LOCKED_ROLE_KEY) {
      throw new ConflictError(
        'Super Admin always holds every permission. Create a narrower role instead.',
        'ROLE_LOCKED',
      )
    }

    /**
     * Existence before authorisation. A typo'd permission key is a bad
     * request, and answering it with "you cannot grant that" sends whoever
     * wrote the typo looking for a permissions problem they do not have.
     */
    const permissionIds = await assertPermissionsExist(body.permissions)
    assertCanGrant(body.permissions, req.user!.permissions)

    const before = existing.permissions.map((rp) => rp.permission.key).sort()

    const role = await prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description ?? null,
          // Grants are replaced wholesale — the matrix always sends the full set.
          permissions: {
            deleteMany: {},
            create: permissionIds.map((permissionId) => ({ permissionId })),
          },
        },
        include: roleInclude,
      })

      // Checked after the change, inside the transaction, so a grant that
      // removes the last route back in is rolled back rather than applied.
      await assertRecoveryPathSurvives(tx)

      return updated
    })

    recordAudit({
      action: 'ROLE_UPDATED',
      entityType: 'Role',
      entityId: id,
      metadata: { key: role.key, before, after: body.permissions.sort() },
      req,
    })

    return ok(res, { role: serializeRole(role) })
  },
)

adminRoleRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('role.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const role = await prisma.role.findUnique({ where: { id }, include: roleInclude })
    if (!role) throw new NotFoundError('Role', 'ROLE_NOT_FOUND')

    if (role.isSystem) {
      throw new ConflictError(
        'Built-in roles cannot be deleted. Remove its permissions instead, or unassign it.',
        'ROLE_IS_SYSTEM',
      )
    }
    if (role._count.users > 0) {
      throw new ConflictError(
        `${role._count.users} ${role._count.users === 1 ? 'person holds' : 'people hold'} this role. Move them to another role first.`,
        'ROLE_IN_USE',
      )
    }

    await prisma.role.delete({ where: { id } })
    recordAudit({
      action: 'ROLE_DELETED',
      entityType: 'Role',
      entityId: id,
      metadata: { key: role.key },
      req,
    })

    return ok(res, { deleted: true })
  },
)

// ────────────────────────────────────────────────────────────────── staff

export const adminStaffRouter: Router = Router()

const staffSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  emailVerified: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { include: { role: { select: { id: true, key: true, name: true } } } },
} satisfies Prisma.UserSelect

type StaffRow = Prisma.UserGetPayload<{ select: typeof staffSelect }>

function serializeStaff(user: StaffRow, actorPermissions: Set<string> | undefined) {
  return {
    ...maskContact(user, actorPermissions),
    roles: user.roles.map((assignment) => assignment.role),
    /** True until they first sign in — the invitation is still outstanding. */
    pendingInvite: user.lastLoginAt === null,
  }
}

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminStaffRouter.get(
  '/',
  requirePermission('user.manage'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>

    const where: Prisma.UserWhereInput = {
      role: 'ADMIN',
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { email: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [total, staff] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        select: staffSelect,
      }),
    ])

    return ok(
      res,
      { staff: staff.map((member) => serializeStaff(member, req.user?.permissions)) },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

const inviteBody = z.object({
  name: z.string().trim().min(2, 'Enter their name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  roleIds: z.array(z.string().trim().min(1)).min(1, 'Give them at least one role').max(10),
})

/**
 * Sends the invitation. Reuses the password-reset token, so the new member
 * chooses their own password and nobody — including whoever invited them —
 * ever knows it.
 */
async function sendInvite(user: { id: string; name: string; email: string }, inviterName: string) {
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { token, hash } = generateOpaqueToken()
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      // Longer than a password reset: an invitation may sit over a weekend.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    },
  })

  const url = `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=${token}`

  await sendMessage({
    channel: 'EMAIL',
    key: 'account.staff_invite',
    recipient: user.email,
    variables: { name: user.name, url, invitedBy: inviterName, expiresInDays: 7 },
    entityType: 'User',
    entityId: user.id,
  }).catch((err) => logger.error({ err, userId: user.id }, 'Staff invitation email failed'))
}

adminStaffRouter.post(
  '/',
  writeLimiter,
  requirePermission('user.manage'),
  validate({ body: inviteBody }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof inviteBody>

    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) {
      throw new ConflictError('An account with that email already exists', 'EMAIL_TAKEN')
    }

    const roles = await resolveRoles(body.roleIds)
    // Inviting someone into a role you could not grant is the same escalation
    // by another route, so it is refused the same way.
    assertCanGrant(permissionsOfRoles(roles), req.user!.permissions)

    /**
     * No password is set here. The account exists but cannot be signed into
     * until the invitation link is used, so an invitation that goes to the
     * wrong address does not hand over a working account — and nobody has to
     * transmit a password.
     */
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        // Random and discarded: unusable, and never a guessable placeholder.
        passwordHash: generateOpaqueToken().hash,
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerified: false,
        roles: { create: roles.map((role) => ({ roleId: role.id })) },
      },
      select: staffSelect,
    })

    await sendInvite(user, req.user!.name)

    recordAudit({
      action: 'STAFF_INVITED',
      entityType: 'User',
      entityId: user.id,
      metadata: { roles: roles.map((r) => r.key) },
      req,
    })

    return created(res, {
      staff: serializeStaff(user, req.user?.permissions),
      message: `An invitation has been sent to ${body.email}.`,
    })
  },
)

const updateStaffBody = z.object({
  roleIds: z.array(z.string().trim().min(1)).max(10).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
})

adminStaffRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('user.manage'),
  validate({ body: updateStaffBody }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof updateStaffBody>

    const target = await prisma.user.findFirst({
      where: { id, role: 'ADMIN' },
      select: staffSelect,
    })
    if (!target) throw new NotFoundError('Staff member', 'STAFF_NOT_FOUND')

    if (body.status === 'SUSPENDED') assertNotSelf(req.user!.id, id, 'suspend')
    if (body.roleIds) assertNotSelf(req.user!.id, id, 'change the roles on')

    const roles = body.roleIds ? await resolveRoles(body.roleIds) : null
    if (roles) assertCanGrant(permissionsOfRoles(roles), req.user!.permissions)

    const staff = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(roles
            ? {
                roles: {
                  deleteMany: {},
                  create: roles.map((role) => ({ roleId: role.id })),
                },
              }
            : {}),
        },
        select: staffSelect,
      })

      await assertRecoveryPathSurvives(tx)
      return updated
    })

    // Suspending must end existing sessions, not just block the next sign-in.
    if (body.status === 'SUSPENDED') {
      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }

    recordAudit({
      action: 'STAFF_UPDATED',
      entityType: 'User',
      entityId: id,
      metadata: {
        ...(body.status ? { status: body.status } : {}),
        ...(roles ? { roles: roles.map((r) => r.key) } : {}),
      },
      req,
    })

    return ok(res, { staff: serializeStaff(staff, req.user?.permissions) })
  },
)

adminStaffRouter.post(
  '/:id/invite',
  writeLimiter,
  requirePermission('user.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const target = await prisma.user.findFirst({
      where: { id, role: 'ADMIN' },
      select: { id: true, name: true, email: true },
    })
    if (!target) throw new NotFoundError('Staff member', 'STAFF_NOT_FOUND')

    await sendInvite(target, req.user!.name)
    recordAudit({ action: 'STAFF_INVITE_RESENT', entityType: 'User', entityId: id, req })

    return ok(res, { sent: true, message: `A new invitation has been sent to ${target.email}.` })
  },
)

// ─────────────────────────────────────────────── operational failure queue

export const adminWebhookRouter: Router = Router()

const webhookQuery = z.object({
  status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'SKIPPED']).optional(),
  provider: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
})

/**
 * Provider callbacks that did not process (PRD §04: "permanent failures enter
 * a visible operational queue").
 *
 * Without this the rows exist and nobody can see them — which in practice
 * means a payment webhook that failed leaves an order paid at the gateway and
 * unpaid in the store, discovered by the customer rather than by us.
 *
 * The stuck count is returned alongside so a dashboard can show a badge
 * without a second query.
 */
adminWebhookRouter.get(
  '/',
  requirePermission('settings.read'),
  validate({ query: webhookQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof webhookQuery>

    const where: Prisma.WebhookEventWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.provider ? { provider: { contains: q.provider, mode: 'insensitive' } } : {}),
    }

    const [total, events, stuck] = await Promise.all([
      prisma.webhookEvent.count({ where }),
      prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      // RECEIVED but never processed counts as stuck too — the handler died
      // partway rather than failing cleanly.
      prisma.webhookEvent.count({ where: { status: { in: ['FAILED', 'RECEIVED'] } } }),
    ])

    return ok(res, { events, stuckCount: stuck }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

/**
 * Replays one failed callback.
 *
 * The stored payload is re-processed rather than re-fetched, because the
 * provider will not send it again and the payload is what we verified at the
 * time. Signature verification already happened on receipt — this is a retry
 * of *our* processing, not a re-acceptance of theirs.
 */
adminWebhookRouter.post(
  '/:id/retry',
  writeLimiter,
  requirePermission('settings.update'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const event = await prisma.webhookEvent.findUnique({ where: { id } })
    if (!event) throw new NotFoundError('Webhook event', 'WEBHOOK_EVENT_NOT_FOUND')

    if (event.status === 'PROCESSED') {
      throw new ConflictError('That callback already processed successfully', 'ALREADY_PROCESSED')
    }

    const outcome = await replayWebhookEvent(event)

    recordAudit({
      action: 'WEBHOOK_RETRIED',
      entityType: 'WebhookEvent',
      entityId: id,
      metadata: { provider: event.provider, eventType: event.eventType, outcome: outcome.status },
      req,
    })

    return ok(res, outcome)
  },
)

// ──────────────────────────────────────────────────────────────── audit

export const adminAuditRouter: Router = Router()

const auditQuery = z.object({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  userId: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
})

/**
 * The audit trail (FR-10.6, FR-24.6).
 *
 * Read-only — there is no endpoint that edits or deletes a row, which is what
 * "immutable" has to mean in practice. Behind `audit.read` because it records
 * who looked at what, and that is not for everyone.
 */
adminAuditRouter.get(
  '/',
  requirePermission('audit.read'),
  validate({ query: auditQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof auditQuery>

    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    }

    const [total, entries, actions] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      // The distinct action list drives the filter dropdown.
      prisma.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
        take: 100,
      }),
    ])

    return ok(
      res,
      {
        entries: entries.map((entry) => ({
          ...entry,
          actor: entry.user ? maskContact(entry.user, req.user?.permissions) : null,
          user: undefined,
        })),
        actions: actions.map((a) => a.action),
      },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)
