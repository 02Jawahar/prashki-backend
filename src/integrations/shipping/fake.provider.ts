import crypto from 'node:crypto'
import type { ShipmentStatus } from '@prisma/client'
import { env } from '../../config/env.js'
import type {
  CarrierEvent,
  CarrierRate,
  CreateProviderShipmentInput,
  ProviderShipment,
  ServiceabilityResult,
  ShippingProvider,
  WebhookHeaders,
} from './shipping.types.js'

/**
 * A carrier that always works, for proving the shop's own half (M21).
 *
 * Never registered in production — `isConfigured` refuses there, and the
 * registry will not hand it out.
 *
 * It exists because the real carrier's test environment cannot prove the
 * thing that matters most to an operator. Shiprocket's sandbox mints AWB
 * numbers and then produces no label behind them: `label_created: 0`,
 * "Failed to create label", with no reason given. Manifests and invoices fail
 * the same way. So the one path a person actually depends on — book a parcel,
 * print the label, stick it on the box — is untestable against it, and
 * testing against the live account debits the wallet on every booking and
 * leaves entries in the passbook.
 *
 * This stands in for a carrier that behaves: it books, it labels, it tracks,
 * and it refuses the things a carrier refuses. What it proves is ours — that
 * a booking is stored, a label reaches the screen, a status update moves the
 * parcel, and a redelivered event does not move it twice. What it cannot
 * prove is that Shiprocket's own payloads match what the adapter expects.
 * Those two questions are different and only one of them needs an account.
 *
 *   SHIPPING_PROVIDER=fake npm run dev
 */

const STATUS_MAP: Record<string, ShipmentStatus> = {
  booked: 'READY_TO_SHIP',
  picked_up: 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  failed: 'EXCEPTION',
  returned: 'RETURNED_TO_ORIGIN',
  cancelled: 'CANCELLED',
}

/** PIN codes this carrier refuses, so "we do not go there" is testable. */
const UNSERVED = new Set(['999999', '000000'])

export class FakeShippingProvider implements ShippingProvider {
  readonly name = 'fake'
  readonly canCreateShipments = true

  private cancelled = new Set<string>()

  isConfigured(): boolean {
    // A test carrier in production would book parcels nobody collects.
    return env.NODE_ENV !== 'production'
  }

  async checkServiceability(
    postalCode: string,
    options: { country?: string; cod?: boolean } = {},
  ): Promise<ServiceabilityResult> {
    if (options.country && options.country.toUpperCase() !== 'IN') {
      return { serviceable: false, codAvailable: false, reason: 'India only' }
    }
    if (UNSERVED.has(postalCode)) {
      return { serviceable: false, codAvailable: false, reason: 'No courier serves that PIN code' }
    }
    return { serviceable: true, codAvailable: true, estimatedDays: 3 }
  }

  async quoteRates(
    postalCode: string,
    options: { weightGrams: number },
  ): Promise<CarrierRate[]> {
    if (UNSERVED.has(postalCode)) return []

    // Priced off the weight so a heavier parcel visibly costs more, which is
    // what makes a weight bug show up in a test rather than in a passbook.
    const base = 4000 + Math.ceil(Math.max(options.weightGrams, 100) / 500) * 1500

    return [
      { rule: 'cheapest', courierId: 'fake-surface', courierName: 'Fake Surface', amount: base, estimatedDays: 4 },
      { rule: 'fastest', courierId: 'fake-air', courierName: 'Fake Air', amount: base * 2, estimatedDays: 2 },
    ]
  }

  async createShipment(input: CreateProviderShipmentInput): Promise<ProviderShipment> {
    if (UNSERVED.has(input.to.postalCode)) {
      throw new Error(`No courier serves ${input.to.postalCode}`)
    }

    const id = `fake_${crypto.randomBytes(6).toString('hex')}`

    return {
      providerShipmentId: id,
      trackingNumber: `FAKE${Date.now().toString().slice(-10)}`,
      carrier: 'Fake Surface',
      // The whole point: a label that exists, so the screen can be checked.
      labelUrl: `https://labels.example.invalid/${id}.pdf`,
      estimatedAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      raw: { fake: true, shipmentNumber: input.shipmentNumber },
    }
  }

  async fetchLabel(providerShipmentId: string): Promise<string | null> {
    if (this.cancelled.has(providerShipmentId)) return null
    return `https://labels.example.invalid/${providerShipmentId}.pdf`
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    this.cancelled.add(providerShipmentId)
  }

  /**
   * Signed the same way the manual adapter's is, so the webhook route and its
   * idempotency can be exercised without a carrier sending anything.
   */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): CarrierEvent | null {
    const secret = env.SHIPPING_WEBHOOK_SECRET
    if (!secret) return null

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const given = headers['x-shipping-signature'] ?? ''
    const a = Buffer.from(expected)
    const b = Buffer.from(given)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    return this.normalizeWebhook(JSON.parse(rawBody.toString('utf8')))
  }

  normalizeWebhook(payload: unknown): CarrierEvent {
    const body = payload as {
      id?: string
      trackingNumber?: string
      providerShipmentId?: string
      status?: string
      occurredAt?: string
    }

    const status = STATUS_MAP[String(body.status ?? '').toLowerCase()]
    if (!status) throw new Error(`Unmapped fake status: ${body.status}`)

    return {
      eventId: body.id ?? crypto.randomUUID(),
      providerShipmentId: body.providerShipmentId ?? null,
      trackingNumber: body.trackingNumber ?? null,
      status,
      providerStatus: String(body.status),
      message: null,
      location: 'Chennai',
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      payload,
    }
  }
}
