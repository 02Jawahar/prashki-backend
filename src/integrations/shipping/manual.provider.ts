import crypto from 'node:crypto'
import type { ShipmentStatus } from '@prisma/client'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { IntegrationError } from '../../utils/errors.js'
import type {
  CarrierEvent,
  CreateProviderShipmentInput,
  ProviderShipment,
  ServiceabilityResult,
  ShippingProvider,
} from './shipping.types.js'

/**
 * Manual fulfilment — the default, and a legitimate way to run a studio.
 *
 * Parcels are booked with the courier by hand and an operator enters the AWB.
 * `createShipment` therefore refuses rather than inventing a reference: a
 * provider that silently returns a fake id would let the order workflow believe
 * a parcel exists when nothing was booked.
 *
 * What it *does* implement fully is the inbound half. Most Indian couriers and
 * 3PLs can POST a status webhook without any bespoke integration, so this
 * adapter accepts a documented canonical payload signed with a shared secret:
 *
 *   POST /api/v1/webhooks/shipping
 *   x-shipping-signature: <hex HMAC-SHA256 of the raw body, keyed by
 *                          SHIPPING_WEBHOOK_SECRET>
 *
 *   {
 *     "id":            "evt_8891",                 // required, idempotency key
 *     "trackingNumber":"SMOKE1234567",             // or providerShipmentId
 *     "status":        "out_for_delivery",         // see STATUS_MAP below
 *     "message":       "Out with the rider",
 *     "location":      "New Delhi",
 *     "occurredAt":    "2026-08-16T09:30:00Z"
 *   }
 *
 * A carrier with its own payload shape gets its own adapter implementing the
 * same interface — that is a class, not a redesign.
 */

/**
 * Carrier vocabulary → our canonical states.
 *
 * Deliberately generous: couriers use different words for the same thing, and
 * an unmapped status must not be guessed at. Anything unrecognised is rejected
 * so it surfaces as a mapping gap rather than silently becoming "in transit".
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  pending: 'PENDING',
  created: 'PENDING',
  manifested: 'READY_TO_SHIP',
  ready_to_ship: 'READY_TO_SHIP',
  picked_up: 'IN_TRANSIT',
  pickup_complete: 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  shipped: 'IN_TRANSIT',
  dispatched: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  ofd: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  exception: 'EXCEPTION',
  undelivered: 'EXCEPTION',
  delayed: 'EXCEPTION',
  address_issue: 'EXCEPTION',
  failed: 'FAILED',
  delivery_failed: 'FAILED',
  rto: 'RETURNED_TO_ORIGIN',
  rto_delivered: 'RETURNED_TO_ORIGIN',
  returned: 'RETURNED_TO_ORIGIN',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
}

export function mapCarrierStatus(raw: string): ShipmentStatus | null {
  return STATUS_MAP[raw.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null
}

interface CanonicalWebhookBody {
  id?: string
  eventId?: string
  providerShipmentId?: string
  trackingNumber?: string
  awb?: string
  status?: string
  message?: string
  location?: string
  occurredAt?: string
}

export class ManualShippingProvider implements ShippingProvider {
  readonly name = 'manual'
  readonly canCreateShipments = false

  isConfigured(): boolean {
    return true
  }

  async createShipment(_input: CreateProviderShipmentInput): Promise<ProviderShipment> {
    throw new IntegrationError(
      'This delivery method is booked by hand. Create the parcel with the courier, then record the tracking number here.',
      'SHIPPING_PROVIDER_MANUAL',
    )
  }

  async cancelShipment(): Promise<void> {
    // Nothing was booked with a provider, so there is nothing to cancel.
  }

  /**
   * Without a carrier API there is no authoritative serviceability lookup, so
   * this defers to the zone configuration rather than inventing an answer.
   * `quoteShipping` is what actually decides; this reports "no opinion".
   */
  async checkServiceability(): Promise<ServiceabilityResult> {
    return { serviceable: true, codAvailable: true }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): CarrierEvent | null {
    if (!env.SHIPPING_WEBHOOK_SECRET) {
      throw new IntegrationError(
        'SHIPPING_WEBHOOK_SECRET is not set, so carrier callbacks cannot be verified',
        'WEBHOOK_NOT_CONFIGURED',
      )
    }
    if (!signature) return null

    const expected = crypto
      .createHmac('sha256', env.SHIPPING_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')

    if (!timingSafeEqual(expected, signature)) {
      logger.warn('Carrier webhook signature mismatch')
      return null
    }

    let body: CanonicalWebhookBody
    try {
      body = JSON.parse(rawBody.toString('utf-8')) as CanonicalWebhookBody
    } catch {
      throw new IntegrationError('Carrier webhook body is not valid JSON', 'WEBHOOK_MALFORMED')
    }

    return this.normalizeWebhook(body)
  }

  /** Signature-free half of `parseWebhook`. See the interface for when it applies. */
  normalizeWebhook(payload: unknown): CarrierEvent {
    const body = (payload ?? {}) as CanonicalWebhookBody
    const eventId = body.id ?? body.eventId
    const rawStatus = body.status
    if (!eventId || !rawStatus) {
      throw new IntegrationError(
        'Carrier webhook is missing an event id or status',
        'WEBHOOK_MALFORMED',
      )
    }

    const status = mapCarrierStatus(rawStatus)
    if (!status) {
      // A status we do not understand is a mapping gap, not a reason to guess.
      throw new IntegrationError(
        `Unrecognised carrier status "${rawStatus}"`,
        'WEBHOOK_UNKNOWN_STATUS',
      )
    }

    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date()

    return {
      eventId,
      providerShipmentId: body.providerShipmentId ?? null,
      trackingNumber: body.trackingNumber ?? body.awb ?? null,
      status,
      providerStatus: rawStatus,
      message: body.message ?? null,
      location: body.location ?? null,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      payload: body,
    }
  }
}

/** Constant-time compare so a signature cannot be timed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
