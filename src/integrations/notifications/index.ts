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

/** Logs instead of sending. The default in development. */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console'
  async send(message: EmailMessage): Promise<void> {
    logger.info({ to: message.to, template: message.template }, `[email] ${message.subject}`)
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
