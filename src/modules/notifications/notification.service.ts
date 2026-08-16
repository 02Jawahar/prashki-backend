import type { MessageChannel, NotificationSeverity } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'

/**
 * In-app notifications (M16).
 *
 * Two audiences share one table:
 *
 *   userId set   — for that person (your order has shipped)
 *   broadcast    — one row per active admin (new order, low stock)
 *
 * A broadcast fans out into a row each rather than a single shared row,
 * because "read" is per-person: one manager opening the alert must not clear
 * the badge for the whole team.
 */

export interface NotifyInput {
  userId?: string | null
  type: string
  title: string
  body?: string | null
  severity?: NotificationSeverity
  link?: string | null
  data?: Record<string, unknown>
}

/**
 * Fire-and-forget, like the audit log: a notification must never be the reason
 * an order fails.
 */
export function notify(input: NotifyInput): void {
  void prisma.notification
    .create({
      data: {
        userId: input.userId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity ?? 'INFO',
        link: input.link ?? null,
        data: (input.data ?? undefined) as never,
      },
    })
    .catch((err) => logger.error({ err, type: input.type }, 'Notification write failed'))
}

/** Same, but delivered to every active admin. */
export function notifyAdmins(input: Omit<NotifyInput, 'userId'>): void {
  void prisma.user
    .findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } })
    .then((admins) =>
      admins.length === 0
        ? undefined
        : prisma.notification.createMany({
            data: admins.map((admin) => ({
              userId: admin.id,
              type: input.type,
              title: input.title,
              body: input.body ?? null,
              severity: input.severity ?? 'INFO',
              link: input.link ?? null,
              data: (input.data ?? undefined) as never,
            })),
          }),
    )
    .catch((err) => logger.error({ err, type: input.type }, 'Admin notification write failed'))
}

/**
 * Whether a customer wants a particular message on a particular channel.
 *
 * Defaults to yes: preferences are opt-*out*, and a missing row means the
 * customer has never expressed one. Transactional messages (order placed, order
 * shipped) are not suppressible — a receipt is not marketing.
 */
const ALWAYS_SEND = new Set([
  'order.placed',
  'order.paid',
  'order.shipped',
  'order.delivered',
  'order.cancelled',
  'return.updated',
  'refund.issued',
  'account.password_reset',
])

export async function wantsMessage(
  userId: string,
  channel: MessageChannel,
  type: string,
): Promise<boolean> {
  if (ALWAYS_SEND.has(type)) return true

  const rows = await prisma.notificationPreference.findMany({
    where: { userId, channel, type: { in: [type, '*'] } },
  })

  // The specific rule wins over the channel-wide one.
  const specific = rows.find((r) => r.type === type)
  if (specific) return specific.enabled

  const wildcard = rows.find((r) => r.type === '*')
  return wildcard ? wildcard.enabled : true
}

/** Unread count for the bell. Always the caller's own rows, never anyone else's. */
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } })
}
