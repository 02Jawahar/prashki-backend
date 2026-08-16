import type { MessageChannel } from '@prisma/client'

/**
 * The events the store can message about.
 *
 * This is the list an admin picks channels from, so it has to match what the
 * code actually emits — a key here that no handler sends would let someone
 * enable a channel and wait forever for a message that is never triggered.
 * Handlers reference these keys, so adding an event means adding it here.
 *
 * IN_APP is deliberately absent from every entry. In-app notices are written
 * straight to the notification table by the handlers with their own wording
 * and severity; they are not template-driven, and offering them here would
 * imply an editor that does not exist.
 */
export interface MessageEvent {
  key: string
  label: string
  /** What triggers it, in the admin's words. */
  description: string
  /** Channels this event can meaningfully use. */
  channels: MessageChannel[]
  /**
   * Transactional messages ignore marketing preferences — a receipt is part of
   * the purchase, not something to opt out of. Flagged so the UI can say so
   * rather than implying a customer can turn a receipt off.
   */
  transactional: boolean
}

/** Everything except IN_APP, which is not template-driven. */
const ALL: MessageChannel[] = ['EMAIL', 'WHATSAPP', 'SMS']

export const MESSAGE_EVENTS: MessageEvent[] = [
  {
    key: 'account.welcome',
    label: 'Welcome',
    description: 'Someone creates an account.',
    channels: ALL,
    transactional: false,
  },
  {
    key: 'account.password_reset',
    label: 'Password reset',
    description: 'A customer asks to reset their password.',
    // Deliberately email only. A reset link is a credential — sending it over
    // a channel the customer may read on a shared or borrowed phone widens the
    // blast radius of a lost handset for no real gain.
    channels: ['EMAIL'],
    transactional: true,
  },
  {
    key: 'account.staff_invite',
    label: 'Staff invitation',
    description: 'An admin invites a colleague.',
    channels: ['EMAIL'],
    transactional: true,
  },
  {
    key: 'order.placed',
    label: 'Order placed',
    description: 'An order is created, before payment.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'order.paid',
    label: 'Payment received',
    description: 'Payment is confirmed.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'order.shipped',
    label: 'Order shipped',
    description: 'A parcel is dispatched.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'order.delivered',
    label: 'Order delivered',
    description: 'A parcel is marked delivered.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'order.cancelled',
    label: 'Order cancelled',
    description: 'An order is cancelled, by the customer or by staff.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'return.updated',
    label: 'Return progress',
    description: 'A return is approved, rejected, received or completed.',
    channels: ALL,
    transactional: true,
  },
  {
    key: 'refund.issued',
    label: 'Refund issued',
    description: 'Money is sent back.',
    channels: ALL,
    transactional: true,
  },
]

export const EVENT_KEYS = new Set(MESSAGE_EVENTS.map((event) => event.key))

export function findEvent(key: string): MessageEvent | undefined {
  return MESSAGE_EVENTS.find((event) => event.key === key)
}
