import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'

/**
 * Notification providers (spec §41–42).
 *
 * Interfaces plus a console implementation, deliberately. Shipping a
 * half-tested SendGrid or Twilio integration would be worse than a clear seam:
 * the order system emits business events, these adapters subscribe, and adding
 * a real provider means implementing one interface — no changes to order logic.
 */

export interface EmailMessage {
  to: string
  subject: string
  /** Template identifier, so a real provider can map it to its own template. */
  template: 'welcome' | 'order-confirmation' | 'payment-confirmation' | 'password-reset'
  data: Record<string, unknown>
}

export interface EmailProvider {
  readonly name: string
  send(message: EmailMessage): Promise<void>
}

export interface SmsMessage {
  to: string
  template: string
  data: Record<string, unknown>
}

export interface SmsProvider {
  readonly name: string
  send(message: SmsMessage): Promise<void>
}

export interface WhatsAppProvider {
  readonly name: string
  send(message: SmsMessage): Promise<void>
}

/**
 * Logs instead of sending. The default in development.
 *
 * The body is printed, not just the subject. Half the messages this system
 * sends exist only to carry a single-use link — an invitation, a password
 * reset — and the raw token is never stored anywhere: the database keeps only
 * its SHA-256 hash. Logging "an email was sent" and dropping the body means
 * that link is destroyed at the moment of sending, and the invited person can
 * never be let in.
 *
 * That makes this a development and staging affordance, and a bad idea in
 * production: anyone who can read the logs can read a password-reset link and
 * take over the account it belongs to. `assertConsoleEmailIsSafe` below says
 * so at boot rather than leaving it to be discovered.
 */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console'
  async send(message: EmailMessage): Promise<void> {
    const body = typeof message.data?.body === 'string' ? message.data.body : ''

    logger.info(
      { to: message.to, template: message.template },
      `\n──────── email (not sent — EMAIL_PROVIDER=console) ────────\n` +
        `To:      ${message.to}\n` +
        `Subject: ${message.subject}\n\n` +
        `${body}\n` +
        `───────────────────────────────────────────────────────────`,
    )
  }
}

class NoopSmsProvider implements SmsProvider {
  readonly name = 'noop'
  async send(message: SmsMessage): Promise<void> {
    logger.debug({ to: message.to, template: message.template }, '[sms] suppressed')
  }
}

class NoopWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'noop'
  async send(message: SmsMessage): Promise<void> {
    logger.debug({ to: message.to, template: message.template }, '[whatsapp] suppressed')
  }
}

/**
 * Named but unimplemented providers fail loudly rather than silently dropping
 * a customer's order confirmation.
 */
class UnimplementedEmailProvider implements EmailProvider {
  constructor(readonly name: string) {}
  async send(): Promise<void> {
    throw new Error(
      `EMAIL_PROVIDER=${this.name} is declared but not implemented. ` +
        `Implement the EmailProvider interface, or set EMAIL_PROVIDER=console.`,
    )
  }
}

/**
 * Warns, once at boot, that production is not sending mail.
 *
 * Not a hard failure: a store can legitimately go live before its mail
 * provider is approved, and refusing to start would be worse than the silence.
 * But nothing arrives — no order confirmations, no password resets — and
 * every reset link is written to the log in plain text, so this should not be
 * discovered from a customer complaint.
 */
export function assertConsoleEmailIsSafe(): void {
  if (env.EMAIL_PROVIDER !== 'console' || env.NODE_ENV !== 'production') return

  logger.warn(
    '\n' +
      '  EMAIL_PROVIDER=console in production — no email is being delivered.\n' +
      '\n' +
      '  Order confirmations, staff invitations and password resets are written\n' +
      '  to this log instead of being sent. Anyone who can read these logs can\n' +
      '  use a reset link to take over an account.\n' +
      '\n' +
      '  Configure a real provider before taking orders.\n',
  )
}

let emailProvider: EmailProvider | null = null

export function getEmailProvider(): EmailProvider {
  emailProvider ??=
    env.EMAIL_PROVIDER === 'console'
      ? new ConsoleEmailProvider()
      : new UnimplementedEmailProvider(env.EMAIL_PROVIDER)
  return emailProvider
}

export function getSmsProvider(): SmsProvider {
  return new NoopSmsProvider()
}

export function getWhatsAppProvider(): WhatsAppProvider {
  return new NoopWhatsAppProvider()
}
