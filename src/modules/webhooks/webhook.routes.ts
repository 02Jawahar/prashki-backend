import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getPaymentProvider } from '../../integrations/payment/index.js'
import { getShippingProvider, type CarrierEvent } from '../../integrations/shipping/index.js'
import { processCarrierEvent, processPaymentEvent } from './webhook.service.js'
import { AppError } from '../../utils/errors.js'

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
  void processPaymentEvent(event, provider.name).then(
    (outcome) => {
      if (outcome.status === 'FAILED') {
        // The row is now visible in the admin failure queue, where it can be
        // retried — this log is the pointer to it, not the only record.
        logger.error(
          { eventId: event.eventId, error: outcome.error },
          'Webhook processing failed — queued for retry',
        )
      }
    },
    (err) => logger.error({ err, eventId: event.eventId }, 'Webhook processing threw'),
  )
})

// ------------------------------------------------------------------ carrier

/**
 * Carrier status callbacks (FR-21.5).
 *
 * Same four rules as the payment webhook, for the same reasons: the signature
 * is the authentication, the raw bytes are what gets verified, `(provider,
 * eventId)` makes redelivery a no-op, and we acknowledge before doing the work
 * so the carrier does not retry on our latency.
 *
 * The one addition is ordering. Couriers deliver events late and out of
 * sequence routinely; `applyCarrierEvent` records those but refuses to walk a
 * delivered parcel backwards, flagging it for review instead.
 */
webhookRouter.post('/shipping', async (req, res) => {
  const provider = getShippingProvider()

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
  const signature =
    (req.get('x-shipping-signature') as string | undefined) ??
    (req.get('x-webhook-signature') as string | undefined)

  let event: CarrierEvent | null
  try {
    event = provider.parseWebhook(rawBody, signature)
  } catch (err) {
    logger.error({ err }, 'Carrier webhook parsing failed')
    /**
     * The specific code is passed through rather than flattened into one
     * generic failure. "We are not configured", "that status is not in the
     * mapping" and "that body is not JSON" need different responses from
     * whoever is looking, and collapsing them hides a misconfiguration behind
     * what looks like a bad request.
     */
    return res.status(400).json({
      success: false,
      error: {
        code: err instanceof AppError ? err.code : 'WEBHOOK_INVALID',
        message: err instanceof Error ? err.message : 'Could not process the callback',
      },
    })
  }

  if (!event) {
    logger.warn('Rejected a carrier webhook with an invalid signature')
    return res.status(400).json({
      success: false,
      error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' },
    })
  }

  // ---- idempotency gate ----
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: `shipping:${provider.name}`,
        eventId: event.eventId,
        eventType: event.providerStatus,
        status: 'RECEIVED',
        payload: event.payload as Prisma.InputJsonValue,
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      logger.info({ eventId: event.eventId }, 'Duplicate carrier webhook ignored')
      return res.status(200).json({ success: true, data: { received: true, duplicate: true } })
    }
    throw err
  }

  res.status(200).json({ success: true, data: { received: true } })

  void processCarrierEvent(event, `shipping:${provider.name}`).catch((err) =>
    logger.error({ err, eventId: event.eventId }, 'Carrier webhook processing failed'),
  )
})
