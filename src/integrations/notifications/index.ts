import nodemailer from 'nodemailer'
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
 * Real delivery over SMTP.
 *
 * SMTP rather than a vendor SDK because every service speaks it — Brevo,
 * Resend, Mailtrap, Gmail, SES — so switching provider is four environment
 * variables instead of a new adapter and a deploy. A vendor SDK buys webhooks
 * and analytics that this store does not use yet.
 *
 * The transport is created once and reused: nodemailer pools connections, and
 * building one per message means a TLS handshake per email.
 */
class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp'

  private transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // True only for implicit TLS on 465; 587 negotiates STARTTLS instead.
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASSWORD! },
  })

  async send(message: EmailMessage): Promise<void> {
    const body = typeof message.data?.body === 'string' ? message.data.body : ''

    await this.transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      /**
       * Plain text only. The templates are written as plain text, and
       * generating HTML by wrapping them in <pre> would look worse than
       * letting the client render text — HTML templates are a design job, not
       * a transport one.
       */
      text: body,
    })

    logger.info({ to: message.to, template: message.template }, 'Email sent')
  }

  /** Proves the credentials before a customer's order depends on them. */
  async verify(): Promise<void> {
    await this.transport.verify()
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
  if (emailProvider) return emailProvider

  emailProvider =
    env.EMAIL_PROVIDER === 'console'
      ? new ConsoleEmailProvider()
      : env.EMAIL_PROVIDER === 'smtp'
        ? new SmtpEmailProvider()
        : new UnimplementedEmailProvider(env.EMAIL_PROVIDER)

  return emailProvider
}

/**
 * Checks the SMTP credentials at boot.
 *
 * Deliberately not fatal. Mail is a side effect: a mail server that is down,
 * or a password that expired overnight, must not stop the store taking orders.
 * But it should be in the log the moment it happens rather than discovered
 * from a customer who never got their confirmation.
 */
export async function verifyEmailProvider(): Promise<void> {
  const provider = getEmailProvider()
  if (!(provider instanceof SmtpEmailProvider)) return

  /**
   * Gmail rewrites the From header to the authenticated account unless the
   * address is a verified "Send mail as" alias. Configure orders@yourdomain
   * and customers still see a personal Gmail address — with nothing in any log
   * to say why, because the send genuinely succeeded.
   */
  const host = (env.SMTP_HOST ?? '').toLowerCase()
  const isGmail = host.endsWith('gmail.com') || host.endsWith('googlemail.com')

  if (isGmail && env.SMTP_USER && env.EMAIL_FROM.toLowerCase() !== env.SMTP_USER.toLowerCase()) {
    logger.warn(
      { from: env.EMAIL_FROM, account: env.SMTP_USER },
      `Gmail will replace the From address with ${env.SMTP_USER} unless "${env.EMAIL_FROM}" ` +
        'is a verified alias on that account. Customers will see the Gmail address.',
    )
  }

  try {
    await provider.verify()
    logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.EMAIL_FROM }, 'SMTP ready')
  } catch (err) {
    logger.error(
      { err, host: env.SMTP_HOST, port: env.SMTP_PORT },
      'SMTP credentials rejected — no email will be delivered until this is fixed',
    )
  }
}

export function getSmsProvider(): SmsProvider {
  return new NoopSmsProvider()
}

export function getWhatsAppProvider(): WhatsAppProvider {
  return new NoopWhatsAppProvider()
}
