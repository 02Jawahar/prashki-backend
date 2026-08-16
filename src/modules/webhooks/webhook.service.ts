import type { Prisma, WebhookEvent as WebhookEventRow } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getPaymentProvider, type WebhookEvent } from '../../integrations/payment/index.js'
import { getShippingProvider, type CarrierEvent } from '../../integrations/shipping/index.js'
import { announcePaid, markOrderPaid, markPaymentFailed } from '../payments/payment.service.js'
import { applyCarrierEvent } from '../shipments/shipment.service.js'

/**
 * Processing for provider callbacks, kept out of the route so a retry runs the
 * same code the original delivery ran.
 *
 * The alternative — a second, retry-only implementation — is how a queue ends
 * up quietly succeeding on replay while the live path keeps failing.
 */

type Outcome = { status: 'PROCESSED' | 'FAILED' | 'SKIPPED'; error?: string }

/** Writes the outcome back onto the stored row. */
async function finish(
  provider: string,
  eventId: string,
  outcome: Outcome,
): Promise<Outcome> {
  await prisma.webhookEvent
    .update({
      where: { provider_eventId: { provider, eventId } },
      data: { status: outcome.status, error: outcome.error ?? null, processedAt: new Date() },
    })
    .catch((err) => logger.error({ err, eventId }, 'Could not record webhook outcome'))

  return outcome
}

/**
 * Payment callback → order state.
 *
 * Returns the outcome rather than throwing, so a caller replaying from the
 * admin queue can show what happened instead of a 500.
 */
export async function processPaymentEvent(
  event: WebhookEvent,
  providerName: string,
): Promise<Outcome> {
  const record = (outcome: Outcome) => finish(providerName, event.eventId, outcome)

  try {
    if (event.outcome === 'ignored') return await record({ status: 'SKIPPED' })

    if (!event.providerOrderId) {
      return await record({ status: 'SKIPPED', error: 'No provider order id on the event' })
    }

    // Match the event back to our order through the payment record.
    const payment = await prisma.payment.findFirst({
      where: { providerOrderId: event.providerOrderId },
      orderBy: { createdAt: 'desc' },
      include: { order: true },
    })

    if (!payment) {
      return await record({
        status: 'FAILED',
        error: `No payment found for provider order ${event.providerOrderId}`,
      })
    }

    if (event.outcome === 'failed') {
      await markPaymentFailed({
        orderId: payment.orderId,
        providerPaymentId: event.providerPaymentId,
        reason: `Provider reported ${event.eventType}`,
        source: 'webhook',
      })
      return await record({ status: 'PROCESSED' })
    }

    // Guard against a webhook claiming a different amount than we billed.
    if (typeof event.amount === 'number' && event.amount !== payment.amount) {
      logger.error(
        { eventId: event.eventId, expected: payment.amount, received: event.amount },
        'Webhook amount mismatch — not marking as paid',
      )
      return await record({
        status: 'FAILED',
        error: `Amount mismatch: event ${event.amount} vs payment ${payment.amount}`,
      })
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

    return await record({ status: 'PROCESSED' })
  } catch (err) {
    return await record({
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Carrier callback → shipment state. */
export async function processCarrierEvent(
  event: CarrierEvent,
  providerKey: string,
): Promise<Outcome> {
  const record = (outcome: Outcome) => finish(providerKey, event.eventId, outcome)

  try {
    const result = await applyCarrierEvent(event)

    if (!result) {
      // An event for a parcel we do not know about is not a failure on our
      // side — it is recorded so it can be reconciled by hand.
      return await record({
        status: 'SKIPPED',
        error: `No shipment matched ${event.providerShipmentId ?? event.trackingNumber ?? 'the event'}`,
      })
    }

    return await record({ status: 'PROCESSED' })
  } catch (err) {
    return await record({
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Re-runs a stored callback (FR-04, "permanent failures enter a visible
 * operational queue").
 *
 * The stored payload is re-processed rather than re-fetched: the provider will
 * not send it again, and the payload is exactly what we verified at the time.
 * Signature checking is therefore skipped — it already happened, and there is
 * no signature stored to check against. What is being retried is our
 * processing, not their delivery.
 *
 * Both handlers are idempotent (`markOrderPaid` no-ops on an already-paid
 * order; `applyCarrierEvent` refuses to walk a shipment backwards), so a retry
 * of something that half-succeeded is safe.
 */
export async function replayWebhookEvent(row: WebhookEventRow): Promise<Outcome> {
  const payload = row.payload as Prisma.JsonValue

  if (payload === null || typeof payload !== 'object') {
    return finish(row.provider, row.eventId, {
      status: 'FAILED',
      error: 'The stored payload is empty, so there is nothing to replay',
    })
  }

  try {
    if (row.provider.startsWith('shipping:')) {
      const event = getShippingProvider().normalizeWebhook(payload)
      // The stored id wins — a provider that falls back to a generated id would
      // otherwise mint a new one on replay and update nothing.
      return await processCarrierEvent({ ...event, eventId: row.eventId }, row.provider)
    }

    const event = getPaymentProvider().normalizeWebhook(payload)
    return await processPaymentEvent({ ...event, eventId: row.eventId }, row.provider)
  } catch (err) {
    // A payload the current provider can no longer parse — a mapping gap, or a
    // provider switched since the event arrived.
    return finish(row.provider, row.eventId, {
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
