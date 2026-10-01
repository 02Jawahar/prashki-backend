import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getWhatsAppProvider } from '../../integrations/notifications/index.js'
import { normalizePhone } from '../../utils/phone.js'
import { ValidationError } from '../../utils/errors.js'

/**
 * Talking to a customer on WhatsApp (M28).
 *
 * A consultation is a conversation — somebody commissioning a piece has
 * questions, and the studio has questions back. Until now the number could
 * only announce things: everything it sent was a template, and everything a
 * customer replied went to Twilio and was dropped, because no inbound webhook
 * existed. The studio could not see that anyone had written.
 *
 * Threads are keyed by phone rather than by booking. One person who books
 * twice is one conversation, and a message arriving before any booking still
 * has somewhere to live.
 */

/**
 * WhatsApp's rule, not ours: a business may send free-form text only within
 * 24 hours of the customer's last message. Outside that window Meta accepts
 * the send and silently drops it, which is the worst possible failure — the
 * studio believes it replied and the customer never hears anything.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000

export interface Thread {
  messages: Array<{
    id: string
    direction: 'INBOUND' | 'OUTBOUND'
    body: string
    status: string | null
    createdAt: Date
    sentBy: { name: string | null } | null
  }>
  /** When the free-form window shuts. Null when it was never open. */
  windowClosesAt: Date | null
  /** Whether a reply typed right now would actually arrive. */
  canReply: boolean
}

export async function getThread(rawPhone: string): Promise<Thread> {
  const phone = normalizePhone(rawPhone)
  if (!phone) return { messages: [], windowClosesAt: null, canReply: false }

  const messages = await prisma.whatsAppMessage.findMany({
    where: { phone },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: {
      id: true,
      direction: true,
      body: true,
      status: true,
      createdAt: true,
      sentBy: { select: { name: true } },
    },
  })

  const lastInbound = [...messages].reverse().find((m) => m.direction === 'INBOUND')
  const windowClosesAt = lastInbound ? new Date(lastInbound.createdAt.getTime() + WINDOW_MS) : null

  return {
    messages,
    windowClosesAt,
    canReply: windowClosesAt !== null && windowClosesAt.getTime() > Date.now(),
  }
}

/**
 * Stores something a customer sent us.
 *
 * Idempotent on the provider's message id, because Twilio retries any delivery
 * it does not get a prompt 200 for — and a retried message would otherwise
 * appear in the thread twice.
 */
export async function recordInbound(input: {
  from: string
  body: string
  providerSid: string
}): Promise<{ stored: boolean; phone: string | null }> {
  const phone = normalizePhone(input.from)
  if (!phone) {
    logger.warn({ from: input.from }, 'Inbound WhatsApp from an unreadable number, ignored')
    return { stored: false, phone: null }
  }

  const existing = await prisma.whatsAppMessage.findUnique({
    where: { providerSid: input.providerSid },
    select: { id: true },
  })
  if (existing) return { stored: false, phone }

  await prisma.whatsAppMessage.create({
    data: {
      phone,
      direction: 'INBOUND',
      body: input.body,
      providerSid: input.providerSid,
    },
  })

  return { stored: true, phone }
}

/**
 * Sends a reply the studio typed.
 *
 * Refuses outside the 24-hour window rather than handing it to Twilio, which
 * would accept it and let WhatsApp drop it. A refusal the sender can see beats
 * a message that silently never arrives.
 */
export async function sendReply(input: {
  rawPhone: string
  body: string
  actorId: string
}): Promise<{ id: string }> {
  const phone = normalizePhone(input.rawPhone)
  if (!phone) throw new ValidationError('That is not a phone number we can message')

  const body = input.body.trim()
  if (!body) throw new ValidationError('Write something to send')

  const { canReply, windowClosesAt } = await getThread(phone)
  if (!canReply) {
    throw new ValidationError(
      windowClosesAt
        ? 'WhatsApp only allows a free reply within 24 hours of the customer’s last message, ' +
          'and that window has closed. Call or email them instead.'
        : 'This customer has never messaged the WhatsApp number, so WhatsApp will not deliver ' +
          'a free reply. Call or email them instead.',
    )
  }

  const result = await getWhatsAppProvider().send({
    to: phone,
    // Free-form, which is exactly what the window permits. No Content SID:
    // a template would send approved wording instead of what was typed.
    template: 'conversation.reply',
    data: {},
    body,
  })

  if (!result.transmitted) {
    throw new ValidationError(result.reason ?? 'WhatsApp would not take that message')
  }

  const message = await prisma.whatsAppMessage.create({
    data: {
      phone,
      direction: 'OUTBOUND',
      body,
      providerSid: result.providerMessageId ?? null,
      status: 'sent',
      sentById: input.actorId,
    },
    select: { id: true },
  })

  return message
}
