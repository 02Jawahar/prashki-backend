import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { env, isProduction } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { IntegrationError, PaymentError } from '../../utils/errors.js'
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  ProviderRefund,
  RefundInput,
  VerifiedPayment,
  VerifyPaymentInput,
  WebhookEvent,
  ProviderPaymentStatus,
} from './payment.types.js'

/**
 * Razorpay (spec §30–32).
 *
 * Three rules this implementation exists to enforce:
 *
 *   1. The order is created server-side, so the amount is ours, not the
 *      browser's.
 *   2. The client callback is only believed after its HMAC signature verifies
 *      against the key secret — a "success" from the frontend proves nothing.
 *   3. The webhook is verified against the RAW request body. Re-serialised JSON
 *      produces a different digest and would fail (or worse, be skipped).
 *
 * Only the publishable key id ever reaches the browser.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay'
  private client: Razorpay | null = null

  isConfigured(): boolean {
    return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
  }

  private get sdk(): Razorpay {
    if (!this.isConfigured()) {
      throw new IntegrationError(
        'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
        'PAYMENT_NOT_CONFIGURED',
      )
    }

    /**
     * A test key in production takes no money, and nothing about that looks
     * wrong from either side: the payment window opens, the payment
     * "succeeds", the order is marked PAID and the confirmation goes out.
     * Razorpay settles nothing. The customer believes they have bought
     * something and the studio believes it has been paid.
     *
     * Refused here rather than at boot, because this is the only part of the
     * store that is actually affected. The catalogue, the admin screens and
     * the carrier callbacks keep working on a test key; only taking money
     * stops, which is the thing that cannot be allowed to half-work.
     */
    if (isProduction && env.RAZORPAY_KEY_ID!.startsWith('rzp_test_')) {
      throw new IntegrationError(
        'This store is configured with a Razorpay test key, so no payment can be taken. ' +
          'Set RAZORPAY_KEY_ID to the live key (rzp_live_…) before accepting orders.',
        'PAYMENT_TEST_KEY_IN_PRODUCTION',
      )
    }
    this.client ??= new Razorpay({
      key_id: env.RAZORPAY_KEY_ID!,
      key_secret: env.RAZORPAY_KEY_SECRET!,
    })
    return this.client
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    try {
      // Razorpay also works in the smallest currency unit, so our paise map
      // across directly with no conversion.
      const order = await this.sdk.orders.create({
        amount: input.amount,
        currency: input.currency,
        receipt: input.orderNumber,
        notes: { orderId: input.orderId, orderNumber: input.orderNumber },
      })

      return {
        providerOrderId: order.id,
        amount: Number(order.amount),
        currency: order.currency,
        publicKey: env.RAZORPAY_KEY_ID,
      }
    } catch (err) {
      logger.error({ err }, 'Razorpay order creation failed')
      throw new IntegrationError('Could not start the payment', 'PAYMENT_CREATE_FAILED')
    }
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    if (!env.RAZORPAY_KEY_SECRET) {
      throw new IntegrationError('Razorpay is not configured', 'PAYMENT_NOT_CONFIGURED')
    }

    // Razorpay signs "<order_id>|<payment_id>" with the key secret.
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest('hex')

    const valid = timingSafeEqual(expected, input.signature)

    if (!valid) {
      logger.warn({ providerOrderId: input.providerOrderId }, 'Razorpay signature mismatch')
    }

    return {
      valid,
      providerPaymentId: input.providerPaymentId,
      reason: valid ? undefined : 'Signature verification failed',
    }
  }

  /**
   * Razorpay refunds are asynchronous: the call returns immediately with a
   * refund id and a status that may still be `pending`. The final outcome
   * arrives by webhook, which is why the refund id is what we store and key on.
   */
  async refund(input: RefundInput): Promise<ProviderRefund> {
    try {
      const refund = await this.sdk.payments.refund(input.providerPaymentId, {
        amount: input.amount,
        speed: 'normal',
        notes: { reference: input.reference, reason: input.reason ?? '' },
      })

      return {
        providerRefundId: refund.id,
        amount: Number(refund.amount),
        status: refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending',
        raw: refund,
      }
    } catch (err) {
      logger.error({ err, providerPaymentId: input.providerPaymentId }, 'Razorpay refund failed')
      throw new IntegrationError('The refund could not be sent to the gateway', 'REFUND_FAILED')
    }
  }

  /**
   * What Razorpay says became of an order's payment.
   *
   * An order can hold several attempts — a failed card, then a UPI that
   * worked — so this looks for a captured one first, then an authorised one,
   * and only reports failure when every attempt failed. Reporting the newest
   * attempt instead would call an order unpaid because the customer's last
   * tap happened to be the one that bounced.
   *
   * `authorized` is called out rather than treated as paid. The money is held
   * and not taken, and an authorisation that is never captured releases itself
   * after a few days — so an order shipped against one is a dress given away.
   */
  async lookupOrderPayment(providerOrderId: string): Promise<ProviderPaymentStatus> {
    try {
      const response = await this.sdk.orders.fetchPayments(providerOrderId)
      const payments = (response?.items ?? []) as Array<{
        id?: string
        status?: string
        amount?: number | string
        method?: string
        error_description?: string | null
      }>

      if (payments.length === 0) {
        return { status: 'none', providerPaymentId: null, amount: null, method: null, detail: null }
      }

      const pick =
        payments.find((p) => p.status === 'captured') ??
        payments.find((p) => p.status === 'authorized') ??
        payments[payments.length - 1]!

      const status: ProviderPaymentStatus['status'] =
        pick.status === 'captured'
          ? 'captured'
          : pick.status === 'authorized'
            ? 'authorized'
            : 'failed'

      return {
        status,
        providerPaymentId: pick.id ?? null,
        amount: pick.amount == null ? null : Number(pick.amount),
        method: pick.method ?? null,
        detail: pick.error_description ?? null,
      }
    } catch (err) {
      logger.error({ err, providerOrderId }, 'Razorpay order lookup failed')
      throw new IntegrationError(
        'Razorpay could not be asked about this order',
        'PAYMENT_LOOKUP_FAILED',
      )
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent | null {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      throw new IntegrationError('RAZORPAY_WEBHOOK_SECRET is not set', 'WEBHOOK_NOT_CONFIGURED')
    }
    if (!signature) return null

    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')

    if (!timingSafeEqual(expected, signature)) {
      logger.warn('Razorpay webhook signature mismatch')
      return null
    }

    let body: RazorpayWebhookBody
    try {
      body = JSON.parse(rawBody.toString('utf-8')) as RazorpayWebhookBody
    } catch {
      throw new PaymentError('Webhook body is not valid JSON', 'WEBHOOK_MALFORMED')
    }

    return this.normalizeWebhook(body)
  }

  /** Signature-free half of `parseWebhook`. See the interface for when it applies. */
  normalizeWebhook(payload: unknown): WebhookEvent {
    const body = (payload ?? {}) as RazorpayWebhookBody
    const payment = body.payload?.payment?.entity
    const eventType = body.event ?? 'unknown'

    const outcome: WebhookEvent['outcome'] =
      eventType === 'payment.captured' || eventType === 'order.paid'
        ? 'paid'
        : eventType === 'payment.failed'
          ? 'failed'
          : 'ignored'

    return {
      // Razorpay sends x-razorpay-event-id; fall back to the payment id so the
      // idempotency key is never empty.
      eventId: body.id ?? payment?.id ?? `${eventType}-${Date.now()}`,
      eventType,
      providerOrderId: payment?.order_id,
      providerPaymentId: payment?.id,
      amount: payment?.amount,
      outcome,
      payload: body,
    }
  }
}

interface RazorpayWebhookBody {
  id?: string
  event?: string
  payload?: {
    payment?: {
      entity?: { id?: string; order_id?: string; amount?: number; status?: string }
    }
  }
}

/** Constant-time compare so a signature check can't be timed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
