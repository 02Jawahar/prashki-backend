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

/**
 * What a provider reports back.
 *
 * `transmitted` is the field that matters. A seam that logs instead of sending
 * returns false, and the delivery log records that rather than "SENT" — a
 * suppressed message that reads as sent is worse than an obvious failure,
 * because the one screen an operator checks says the customer was told.
 */
export interface ProviderSendResult {
  /** Which adapter handled it, recorded against the log row. */
  provider: string
  /** The provider's own id, where it has one, for reconciliation. */
  providerMessageId?: string
  /** False when nothing left this server. */
  transmitted: boolean
  /** Why nothing was transmitted, when that is the case. */
  reason?: string
}

export interface EmailMessage {
  to: string
  subject: string
  /** Template identifier, so a real provider can map it to its own template. */
  template: 'welcome' | 'order-confirmation' | 'payment-confirmation' | 'password-reset'
  data: Record<string, unknown>
}

export interface EmailProvider {
  readonly name: string
  send(message: EmailMessage): Promise<ProviderSendResult>
}

export interface SmsMessage {
  to: string
  template: string
  data: Record<string, unknown>
  /** Rendered text. Used when no approved provider template applies. */
  body?: string
  /**
   * The provider's approved template id — Twilio calls it a Content SID.
   * WhatsApp forbids free-form business-initiated messages outside a 24-hour
   * reply window, so for most sends this, not `body`, is what goes out.
   */
  contentSid?: string | null
  /**
   * The placeholders the template declares, in order. Providers that number
   * their variables — Twilio's {{1}}, {{2}} — map positionally off this, so
   * the declared order is the contract rather than object key order.
   */
  variableOrder?: string[]
}

export interface SmsProvider {
  readonly name: string
  send(message: SmsMessage): Promise<ProviderSendResult>
}

export interface WhatsAppProvider {
  readonly name: string
  send(message: SmsMessage): Promise<ProviderSendResult>
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
  async send(message: EmailMessage): Promise<ProviderSendResult> {
    const body = typeof message.data?.body === 'string' ? message.data.body : ''

    logger.info(
      { to: message.to, template: message.template },
      `\n──────── email (not sent — EMAIL_PROVIDER=console) ────────\n` +
        `To:      ${message.to}\n` +
        `Subject: ${message.subject}\n\n` +
        `${body}\n` +
        `───────────────────────────────────────────────────────────`,
    )

    /**
     * Counted as transmitted, unlike the noop seams below, because printing
     * the message is this transport's whole purpose rather than a failure to
     * have one — a developer reads the reset link out of the log and it has
     * arrived. Using it in production is the real hazard, and
     * `assertConsoleEmailIsSafe` already says so at boot.
     */
    return { provider: this.name, transmitted: true }
  }
}

class NoopSmsProvider implements SmsProvider {
  readonly name = 'noop'
  async send(message: SmsMessage): Promise<ProviderSendResult> {
    logger.debug({ to: message.to, template: message.template }, '[sms] suppressed')
    return {
      provider: this.name,
      transmitted: false,
      reason: 'SMS_PROVIDER=noop — nothing was sent',
    }
  }
}

class NoopWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'noop'
  async send(message: SmsMessage): Promise<ProviderSendResult> {
    logger.debug({ to: message.to, template: message.template }, '[whatsapp] suppressed')
    return {
      provider: this.name,
      transmitted: false,
      reason: 'WHATSAPP_PROVIDER=noop — nothing was sent',
    }
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

  async send(message: EmailMessage): Promise<ProviderSendResult> {
    const body = typeof message.data?.body === 'string' ? message.data.body : ''

    const receipt = await this.transport.sendMail({
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

    return { provider: this.name, providerMessageId: receipt.messageId, transmitted: true }
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
  async send(): Promise<ProviderSendResult> {
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

/**
 * WhatsApp over Twilio's REST API.
 *
 * `fetch` rather than the Twilio SDK, for the reason SMTP was chosen over a
 * vendor SDK for email: this is one authenticated POST, and a dependency that
 * carries its own HTTP stack, retry policy and release cadence is a poor trade
 * for a form encoder.
 *
 * Two ways a message goes out, and the difference is not ours to choose.
 * WhatsApp only permits a free-form business-initiated message inside the
 * 24-hour window that opens when the customer last wrote to us. Outside it —
 * which is every order confirmation — the message must be a template Meta has
 * already approved. So when the template row carries a Content SID we send
 * that, and `body` is used only when it does not.
 */
class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'twilio'

  async send(message: SmsMessage): Promise<ProviderSendResult> {
    const to = toWhatsAppAddress(message.to)
    if (!to) {
      return {
        provider: this.name,
        transmitted: false,
        reason: `"${message.to}" is not a usable phone number`,
      }
    }

    const form = new URLSearchParams({
      From: toWhatsAppAddress(env.TWILIO_WHATSAPP_FROM!)!,
      To: to,
    })

    if (message.contentSid) {
      form.set('ContentSid', message.contentSid)
      const variables = positionalVariables(message.data, message.variableOrder)
      if (variables) form.set('ContentVariables', variables)
    } else {
      /**
       * Only reaches the customer inside the 24-hour window; outside it
       * Twilio accepts the request and WhatsApp drops the message. Logged so
       * the silence is explainable — set the template's providerTemplateId to
       * an approved Content SID to fix it properly.
       */
      logger.warn(
        { template: message.template },
        'Sending WhatsApp free-form: no Content SID on this template, so it will only ' +
          'arrive if the customer messaged us in the last 24 hours',
      )
      form.set('Body', message.body ?? String(message.data?.body ?? ''))
    }

    if (env.TWILIO_STATUS_CALLBACK_URL) {
      form.set('StatusCallback', env.TWILIO_STATUS_CALLBACK_URL)
    }

    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')

    const response = await fetch(
      `${env.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        // Twilio is a side effect on an order; it must not hold a request open.
        signal: AbortSignal.timeout(15_000),
      },
    )

    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string
      status?: string
      message?: string
      code?: number
    }

    if (!response.ok) {
      /**
       * Thrown, not returned: a rejected send is a failure the caller should
       * log with its error, where `transmitted: false` means "we chose not to
       * send". Twilio's own message is kept — code 63016 (no template outside
       * the window) and 21211 (bad number) each need a different fix, and
       * flattening them into "send failed" hides which.
       */
      throw new Error(
        `Twilio rejected the message (${response.status}` +
          `${payload.code ? `, code ${payload.code}` : ''}): ${payload.message ?? 'no detail'}`,
      )
    }

    logger.info({ sid: payload.sid, status: payload.status }, 'WhatsApp message accepted by Twilio')

    return {
      provider: this.name,
      providerMessageId: payload.sid,
      /**
       * Accepted by Twilio, which is not the same as delivered to the handset.
       * The status callback is what moves the row on to delivered or read.
       */
      transmitted: true,
    }
  }
}

/**
 * Normalises to Twilio's `whatsapp:+E164` address.
 *
 * Checkout collects whatever the customer types — spaces, brackets, a leading
 * zero, sometimes the country code and sometimes not. Sending that verbatim
 * fails with Twilio 21211 and reads, in the log, as though the customer gave a
 * bad number.
 */
function toWhatsAppAddress(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const hadPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  if (!hadPlus) {
    // A single leading zero is trunk notation for a domestic call, not part
    // of the number.
    digits = digits.replace(/^0+/, '')
    // Ten digits in India means the country code was left off, which is how
    // most people write their own mobile number.
    if (digits.length <= 10) digits = `${env.WHATSAPP_DEFAULT_COUNTRY_CODE}${digits}`
  }

  // E.164 allows at most fifteen digits, and a country code is at least one.
  if (digits.length < 8 || digits.length > 15) return null

  return `whatsapp:+${digits}`
}

/**
 * Maps named variables onto Twilio's numbered ones.
 *
 * Twilio content templates address variables positionally — {{1}}, {{2}} — so
 * something has to fix the order. `MessageTemplate.variables` already declares
 * it, and using that keeps the mapping a stated contract rather than a
 * dependency on JavaScript object key order.
 */
function positionalVariables(
  data: Record<string, unknown>,
  order: string[] | undefined,
): string | null {
  const names = order?.length ? order : Object.keys(data).filter((k) => k !== 'body')
  if (names.length === 0) return null

  const mapped: Record<string, string> = {}
  names.forEach((name, index) => {
    const value = data[name]
    mapped[String(index + 1)] = value === undefined || value === null ? '' : String(value)
  })

  return JSON.stringify(mapped)
}

/**
 * Named but unimplemented, on the same principle as the email seam: a channel
 * the operator has switched on must not quietly drop messages.
 */
class UnimplementedProvider implements SmsProvider, WhatsAppProvider {
  constructor(
    readonly name: string,
    private readonly variable: string,
  ) {}
  async send(): Promise<ProviderSendResult> {
    throw new Error(
      `${this.variable}=${this.name} is declared but not implemented. ` +
        `Implement the interface, or set ${this.variable}=noop.`,
    )
  }
}

export function getSmsProvider(): SmsProvider {
  if (env.SMS_PROVIDER === 'noop') return new NoopSmsProvider()
  return new UnimplementedProvider(env.SMS_PROVIDER, 'SMS_PROVIDER')
}

export function getWhatsAppProvider(): WhatsAppProvider {
  switch (env.WHATSAPP_PROVIDER) {
    case 'twilio':
      return new TwilioWhatsAppProvider()
    case 'noop':
      return new NoopWhatsAppProvider()
    default:
      return new UnimplementedProvider(env.WHATSAPP_PROVIDER, 'WHATSAPP_PROVIDER')
  }
}
