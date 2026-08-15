import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  VerifiedPayment,
  VerifyPaymentInput,
  WebhookEvent,
} from './payment.types.js'

/**
 * Development provider — lets the whole checkout flow run without gateway
 * credentials.
 *
 * It is deliberately NOT a rubber stamp: it signs with the same HMAC shape
 * Razorpay uses and verifies that signature properly, so the server-side
 * verification path is genuinely exercised rather than bypassed. What it cannot
 * do is take money.
 *
 * It refuses to run in production.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock'

  private get secret(): string {
    return env.JWT_ACCESS_SECRET // dev-only signing material
  }

  isConfigured(): boolean {
    return env.NODE_ENV !== 'production'
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    return {
      providerOrderId: `mock_order_${crypto.randomBytes(10).toString('hex')}`,
      amount: input.amount,
      currency: input.currency,
      publicKey: 'mock_key',
    }
  }

  /** Same construction as Razorpay: HMAC over "<order_id>|<payment_id>". */
  sign(providerOrderId: string, providerPaymentId: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest('hex')
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const expected = this.sign(input.providerOrderId, input.providerPaymentId)
    const a = Buffer.from(expected)
    const b = Buffer.from(input.signature ?? '')

    const valid = a.length === b.length && crypto.timingSafeEqual(a, b)

    return {
      valid,
      providerPaymentId: input.providerPaymentId,
      reason: valid ? undefined : 'Signature verification failed',
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent | null {
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature ?? '')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    const body = JSON.parse(rawBody.toString('utf-8')) as {
      id?: string
      event?: string
      providerOrderId?: string
      providerPaymentId?: string
      amount?: number
    }

    return {
      eventId: body.id ?? `mock-${Date.now()}`,
      eventType: body.event ?? 'payment.captured',
      providerOrderId: body.providerOrderId,
      providerPaymentId: body.providerPaymentId,
      amount: body.amount,
      outcome: body.event === 'payment.failed' ? 'failed' : 'paid',
      payload: body,
    }
  }
}
