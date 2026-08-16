import type { MessageChannel } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import {
  getEmailProvider,
  getSmsProvider,
  getWhatsAppProvider,
} from '../../integrations/notifications/index.js'
import { maskEmail, maskPhone } from '../../utils/pii.js'
import { wantsMessage } from '../notifications/notification.service.js'

/**
 * Outbound messaging (M14, M15).
 *
 * Everything the store sends goes through here, which buys three things:
 *
 *   1. copy lives in editable templates, so wording changes need no deploy
 *   2. every send is logged, so "did the customer get it?" has an answer
 *   3. preferences and channel availability are checked in one place
 *
 * Delivery failures are logged and swallowed. A confirmation email that cannot
 * be sent must not roll back the order it was confirming.
 */

/** `{{name}}` and `{{ order.number }}` both work; unknown keys render empty. */
export function render(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = path
      .split('.')
      .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), variables)
    return value === undefined || value === null ? '' : String(value)
  })
}

export interface SendInput {
  channel: MessageChannel
  /** Template key, e.g. "order.placed". Also the preference key. */
  key: string
  recipient: string
  variables?: Record<string, unknown>
  /** Skips the preference check for a customer who has none (guest checkout). */
  userId?: string | null
  /** Links the log row back to what caused the message. */
  entityType?: string
  entityId?: string
}

export interface SendResult {
  sent: boolean
  reason?: 'NO_TEMPLATE' | 'OPTED_OUT' | 'NO_RECIPIENT' | 'PROVIDER_ERROR' | 'IN_APP'
  logId?: string
}

export async function sendMessage(input: SendInput): Promise<SendResult> {
  if (!input.recipient?.trim()) return { sent: false, reason: 'NO_RECIPIENT' }

  if (input.userId) {
    const wanted = await wantsMessage(input.userId, input.channel, input.key)
    if (!wanted) return { sent: false, reason: 'OPTED_OUT' }
  }

  const template = await prisma.messageTemplate.findUnique({
    where: { key_channel: { key: input.key, channel: input.channel } },
  })

  // A missing template is a configuration gap, not a silent no-op — it is
  // logged loudly so it surfaces before a customer notices the silence.
  if (!template || !template.isActive) {
    logger.warn({ key: input.key, channel: input.channel }, 'No active message template')
    return { sent: false, reason: 'NO_TEMPLATE' }
  }

  const variables = input.variables ?? {}
  const subject = template.subject ? render(template.subject, variables) : null
  const body = render(template.body, variables)

  const log = await prisma.messageLog.create({
    data: {
      templateId: template.id,
      channel: input.channel,
      recipient: input.recipient,
      subject,
      status: 'QUEUED',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    },
  })

  try {
    await dispatch(input.channel, {
      recipient: input.recipient,
      subject: subject ?? '',
      body,
      key: input.key,
      providerTemplateId: template.providerTemplateId,
      variables,
    })

    await prisma.messageLog.update({
      where: { id: log.id },
      data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
    })

    return { sent: true, logId: log.id }
  } catch (err) {
    logger.error(
      {
        err,
        key: input.key,
        channel: input.channel,
        // The log row keeps the real address; the log stream does not need it.
        recipient: input.channel === 'EMAIL' ? maskEmail(input.recipient) : maskPhone(input.recipient),
      },
      'Message send failed',
    )

    await prisma.messageLog
      .update({
        where: { id: log.id },
        data: {
          status: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 500) : 'Unknown error',
          attempts: { increment: 1 },
        },
      })
      .catch(() => undefined)

    return { sent: false, reason: 'PROVIDER_ERROR', logId: log.id }
  }
}

export interface FanOutInput {
  /** Template key, e.g. "order.placed". */
  key: string
  /** Where the customer can be reached. A missing one skips its channels. */
  contact: { email?: string | null; phone?: string | null }
  variables?: Record<string, unknown>
  userId?: string | null
  entityType?: string
  entityId?: string
}

/** Which contact detail a channel needs. */
function recipientFor(channel: MessageChannel, contact: FanOutInput['contact']): string | null {
  return channel === 'EMAIL' ? (contact.email ?? null) : (contact.phone ?? null)
}

/**
 * Sends one event on every channel an admin has switched on.
 *
 * The active templates *are* the routing table. There is no second table of
 * channel settings to fall out of step with the copy: a template that exists
 * and is active means "send this event this way", and turning it off in the
 * admin turns the channel off. That is the whole answer to "how do I choose
 * the channel" — add or activate a template for it.
 *
 * Handlers used to enumerate channels themselves, which meant enabling
 * WhatsApp for an event was a code change, and a template created for a
 * channel no handler mentioned would sit there never firing.
 *
 * Returns a result per channel so a caller — or a test — can tell the
 * difference between "not configured", "customer opted out" and "no phone
 * number on file".
 */
export async function sendToAllChannels(
  input: FanOutInput,
): Promise<Record<string, SendResult>> {
  const templates = await prisma.messageTemplate.findMany({
    where: { key: input.key, isActive: true },
    select: { channel: true },
  })

  if (templates.length === 0) {
    logger.warn({ key: input.key }, 'Event fired with no active template on any channel')
    return {}
  }

  const results: Record<string, SendResult> = {}

  for (const { channel } of templates) {
    // In-app notices are written by the handler, not sent through a provider.
    if (channel === 'IN_APP') continue

    const recipient = recipientFor(channel, input.contact)
    if (!recipient) {
      results[channel] = { sent: false, reason: 'NO_RECIPIENT' }
      continue
    }

    results[channel] = await sendMessage({
      channel,
      key: input.key,
      recipient,
      variables: input.variables,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
    })
  }

  return results
}

interface DispatchInput {
  recipient: string
  subject: string
  body: string
  key: string
  providerTemplateId: string | null
  variables: Record<string, unknown>
}

/** The only place that knows which provider a channel maps to. */
async function dispatch(channel: MessageChannel, message: DispatchInput): Promise<void> {
  switch (channel) {
    case 'EMAIL':
      await getEmailProvider().send({
        to: message.recipient,
        subject: message.subject,
        // The provider contract predates editable templates; the rendered body
        // rides along in data so a console provider can print it and a real one
        // can use either the body or its own template id.
        template: templateIdFor(message.key),
        data: { ...message.variables, body: message.body },
      })
      return

    case 'SMS':
      await getSmsProvider().send({
        to: message.recipient,
        template: message.providerTemplateId ?? message.key,
        data: { ...message.variables, body: message.body },
      })
      return

    case 'WHATSAPP':
      await getWhatsAppProvider().send({
        to: message.recipient,
        template: message.providerTemplateId ?? message.key,
        data: { ...message.variables, body: message.body },
      })
      return

    case 'IN_APP':
      // Handled by the notification table, not by a provider.
      return
  }
}

/** Maps our template keys onto the provider contract's narrower union. */
function templateIdFor(key: string): 'welcome' | 'order-confirmation' | 'payment-confirmation' | 'password-reset' {
  if (key.startsWith('account.password')) return 'password-reset'
  if (key === 'order.paid') return 'payment-confirmation'
  if (key.startsWith('order.')) return 'order-confirmation'
  return 'welcome'
}
