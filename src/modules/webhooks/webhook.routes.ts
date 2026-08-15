import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getPaymentProvider } from '../../integrations/payment/index.js'
import { announcePaid, markOrderPaid, markPaymentFailed } from '../payments/payment.service.js'

/**
 * Provider webhooks (spec §32).
 *
 * Four rules, all of which this route depends on:
 *
 *   1. Signature is verified against the RAW body bytes. `express.raw` is
 *      mounted for this path in app.ts, before the JSON parser, because
 *      re-serialised JSON produces a different digest.
 *   2. Every event is stored by its provider event id, and the unique
 *      constraint on (provider, eventId) makes redelivery a no-op.
 *   3. We return 200 quickly. A provider that gets a slow or failing response
 *      retries, which is how duplicate processing starts.
 *   4. An unverified request gets 400 and is never acted on.
 *
 * Note: this endpoint is deliberately NOT behind auth — the signature is the
 * authentication.
 */
export const webhookRouter: Router = Router()

webhookRouter.post('/razorpay', async (req, res) => {
  const provider = getPaymentProvider()

  // app.ts mounts express.raw for /api/v1/webhooks, so this is a Buffer.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
  const signature =
    (req.get('x-razorpay-signature') as string | undefined) ??
    (req.get('x-webhook-signature') as string | undefined)

  let event
  try {
    event = provider.parseWebhook(rawBody, signature)
  } catch (err) {
    logger.error({ err }, 'Webhook parsing failed')
    return res.status(400).json({
      success: false,
      error: { code: 'WEBHOOK_INVALID', message: 'Could not process the webhook' },
    })
  }

  if (!event) {
    logger.warn('Rejected a webhook with an invalid signature')
    return res.status(400).json({
      success: false,
      error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' },
    })
  }

  // ---- idempotency gate ----
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: provider.name,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'RECEIVED',
        payload: event.payload as Prisma.InputJsonValue,
      },
    })
  } catch (err) {
    // Unique violation => we have seen this event before. Acknowledge and stop.
    if ((err as { code?: string }).code === 'P2002') {
      logger.info({ eventId: event.eventId }, 'Duplicate webhook ignored')
      return res.status(200).json({ success: true, data: { received: true, duplicate: true } })
    }
    throw err
  }

  // Acknowledge before doing the work — the provider must not wait on us.
  res.status(200).json({ success: true, data: { received: true } })

  // ---- process (after responding) ----
  void processEvent(event, provider.name).catch((err) =>
    logger.error({ err, eventId: event.eventId }, 'Webhook processing failed'),
  )
})

async function processEvent(
  event: NonNullable<ReturnType<ReturnType<typeof getPaymentProvider>['parseWebhook']>>,
  providerName: string,
) {
  const finish = async (status: 'PROCESSED' | 'FAILED' | 'SKIPPED', error?: string) => {
    await prisma.webhookEvent.update({
      where: { provider_eventId: { provider: providerName, eventId: event.eventId } },
      data: { status, error: error ?? null, processedAt: new Date() },
    })
  }

  try {
    if (event.outcome === 'ignored') {
      await finish('SKIPPED')
      return
    }

    if (!event.providerOrderId) {
      await finish('SKIPPED', 'No provider order id on the event')
      return
    }

    // Match the event back to our order through the payment record.
    const payment = await prisma.payment.findFirst({
      where: { providerOrderId: event.providerOrderId },
      orderBy: { createdAt: 'desc' },
      include: { order: true },
    })

    if (!payment) {
      await finish('FAILED', `No payment found for provider order ${event.providerOrderId}`)
      return
    }

    if (event.outcome === 'failed') {
      await markPaymentFailed({
        orderId: payment.orderId,
        providerPaymentId: event.providerPaymentId,
        reason: `Provider reported ${event.eventType}`,
        source: 'webhook',
      })
      await finish('PROCESSED')
      return
    }

    // Guard against a webhook claiming a different amount than we billed.
    if (typeof event.amount === 'number' && event.amount !== payment.amount) {
      await finish('FAILED', `Amount mismatch: event ${event.amount} vs payment ${payment.amount}`)
      logger.error(
        { eventId: event.eventId, expected: payment.amount, received: event.amount },
        'Webhook amount mismatch — not marking as paid',
      )
      return
    }

    const outcome = await markOrderPaid({
      orderId: payment.orderId,
      providerPaymentId: event.providerPaymentId ?? 'unknown',
      providerOrderId: event.providerOrderId,
      source: 'webhook',
    })

    if (outcome.changed && outcome.order) {
      announcePaid({
        id: outcome.order.id,
        orderNumber: outcome.order.orderNumber,
        userId: outcome.order.userId,
        total: outcome.order.total,
      })
    }

    await finish('PROCESSED')
  } catch (err) {
    await finish('FAILED', err instanceof Error ? err.message : String(err)).catch(() => undefined)
    throw err
  }
}
