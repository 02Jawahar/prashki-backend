import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { IntegrationError, PaymentError } from '../../utils/errors.js'
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  VerifiedPayment,
  VerifyPaymentInput,
  WebhookEvent,
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
