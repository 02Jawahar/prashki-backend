import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { sendMessage } from '../messaging/message.service.js'

/**
 * A copy of what the customer was just told, sent to the studio's own phone.
 *
 * The admin bell already records a new order, but a bell only works for
 * somebody already looking at the screen — and the studio is often at a
 * cutting table. This puts the same message on a phone.
 *
 * Deliberately the customer's own template rather than a studio-worded one.
 * WhatsApp refuses any business-initiated message that is not an approved
 * template, and `order.placed` is already approved; a studio variant would
 * mean another submission and another wait in Meta's queue for wording only
 * one person reads. The side effect is useful: the studio sees the message
 * exactly as the customer received it, which is the thing you want in front of
 * you when they ring up confused about it.
 */

export const STUDIO_WHATSAPP_KEY = 'notifications.studio_whatsapp'

/** Blank until somebody sets it, and blank means no copies are sent. */
export async function studioNumber(): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: STUDIO_WHATSAPP_KEY },
    select: { value: true },
  })
  const value = setting?.value?.trim()
  return value ? value : null
}

export async function copyToStudio(input: {
  key: string
  variables: Record<string, unknown>
  entityType?: string
  entityId?: string
}): Promise<void> {
  const recipient = await studioNumber()
  if (!recipient) return

  /**
   * No `userId`. That field is what consults a customer's notification
   * preferences, and the studio is not a customer — somebody unsubscribing
   * from order mail must not switch off the shop's own alerts.
   */
  const result = await sendMessage({
    channel: 'WHATSAPP',
    key: input.key,
    recipient,
    variables: input.variables,
    entityType: input.entityType,
    entityId: input.entityId,
  })

  if (!result.sent) {
    logger.warn(
      { key: input.key, reason: result.reason },
      'Could not copy the order alert to the studio',
    )
  }
}
