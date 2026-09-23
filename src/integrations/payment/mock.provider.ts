import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import type {
  ProviderPaymentStatus,
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  ProviderRefund,
  RefundInput,
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

  /**
   * A stand-in for asking the gateway, so the reconciliation path can be
   * exercised without a real payment.
   *
   * The answer is taken from the order id, because the branches that matter
   * are the ones that refuse: an authorisation that was never captured, and a
   * capture for the wrong amount. Both should leave the order alone, and a
   * test that can only produce the happy path proves the least important one.
   *
   *   …ending "auth"  -> authorized, not captured
   *   …ending "part"  -> captured, but short by a rupee
   *   …ending "none"  -> no payment at all
   *   anything else   -> captured in full
   */
  async lookupOrderPayment(providerOrderId: string): Promise<ProviderPaymentStatus> {
    const amount = Number(providerOrderId.match(/_(\d+)$/)?.[1] ?? 0) || null

    if (providerOrderId.endsWith('none')) {
      return { status: 'none', providerPaymentId: null, amount: null, method: null, detail: null }
    }
    if (providerOrderId.endsWith('auth')) {
      return {
        status: 'authorized',
        providerPaymentId: 'pay_mock_authorized',
        amount,
        method: 'card',
        detail: null,
      }
    }
    if (providerOrderId.endsWith('part')) {
      return {
        status: 'captured',
        providerPaymentId: 'pay_mock_partial',
        amount: amount === null ? 1 : amount - 100,
        method: 'upi',
        detail: null,
      }
    }
    return {
      status: 'captured',
      providerPaymentId: `pay_mock_${providerOrderId.slice(-8)}`,
      amount,
      method: 'upi',
      detail: null,
    }
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

  /** No money moves; the refund is recorded so the rest of the flow is real. */
  async refund(input: RefundInput): Promise<ProviderRefund> {
    return {
      providerRefundId: `mock_rfnd_${crypto.randomBytes(10).toString('hex')}`,
      amount: input.amount,
      status: 'processed',
      raw: { mock: true, providerPaymentId: input.providerPaymentId, reference: input.reference },
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent | null {
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature ?? '')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    return this.normalizeWebhook(JSON.parse(rawBody.toString('utf-8')))
  }

  /** Signature-free half of `parseWebhook`. See the interface for when it applies. */
  normalizeWebhook(payload: unknown): WebhookEvent {
    const body = (payload ?? {}) as {
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
