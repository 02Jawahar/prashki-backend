import type { ShipmentStatus } from '@prisma/client'

/**
 * Shipping provider contract (FR-21.3, FR-21.5).
 *
 * Fulfilment logic only ever sees this interface. Swapping a carrier — or
 * adding a second one alongside the first — means implementing it again; the
 * shipment service, the order workflow and the customer's tracking page do not
 * change, because none of them know a carrier exists.
 *
 * The same shape as the payment provider, for the same reason: provider
 * payloads must not leak into the domain model.
 */

export interface ShipmentAddress {
  name: string
  phone: string
  addressLine1: string
  addressLine2?: string | null
  city: string
  state: string
  postalCode: string
  country: string
}

export interface ShipmentLine {
  name: string
  sku: string
  quantity: number
  /** integer paise — carriers need a declared value for insurance and customs. */
  unitPrice: number
}

export interface CreateProviderShipmentInput {
  /** Our own reference, e.g. "PK-2026-00042-S1". */
  shipmentNumber: string
  orderNumber: string
  to: ShipmentAddress
  items: ShipmentLine[]
  weightGrams: number
  lengthMm?: number | null
  widthMm?: number | null
  heightMm?: number | null
  /** Paise to collect on delivery. Zero or absent for a prepaid parcel. */
  codAmount?: number
}

/**
 * Inbound webhook headers, lower-cased by Node.
 *
 * The whole set rather than one pre-extracted signature, because carriers do
 * not agree on how a callback proves itself: an HMAC in `x-shipping-signature`,
 * a shared key in `x-api-key`, a bearer token, a pair of headers hashed
 * together. Handing the adapter everything means adding a carrier never means
 * editing the webhook route.
 */
export type WebhookHeaders = Record<string, string | undefined>

export interface ProviderShipment {
  /** The carrier's own id. Stored unique, so a callback can find us by it. */
  providerShipmentId: string
  trackingNumber?: string | null
  carrier?: string | null
  /** A URL the operator can print. Never proxied through our own domain. */
  labelUrl?: string | null
  estimatedAt?: Date | null
  raw?: unknown
}

export interface ServiceabilityResult {
  serviceable: boolean
  /** False when the destination is prepaid-only. */
  codAvailable: boolean
  /** Carrier's own estimate, when it offers one. */
  estimatedDays?: number | null
  reason?: string
}

/**
 * A carrier status update, already mapped onto our canonical states.
 *
 * `eventId` is the idempotency key. A carrier that redelivers the same event —
 * which they all do — must not produce a second row or a second notification.
 */
export interface CarrierEvent {
  eventId: string
  providerShipmentId?: string | null
  trackingNumber?: string | null
  status: ShipmentStatus
  /** The carrier's own wording, kept so a bad mapping stays debuggable. */
  providerStatus: string
  message?: string | null
  location?: string | null
  occurredAt: Date
  payload: unknown
}

/** A carrier's own quote for one parcel, in the store's own units. */
export interface CarrierRate {
  /** Which rule produced it, and how the same courier is found again at booking. */
  rule: 'cheapest' | 'fastest'
  courierId: string
  courierName: string
  /** integer paise — what the carrier charges, converted from their decimal. */
  amount: number
  estimatedDays: number | null
}

export interface ShippingProvider {
  readonly name: string
  /** True when the adapter has everything it needs to actually book a parcel. */
  isConfigured(): boolean
  /** True when this adapter can create shipments; false for manual booking. */
  readonly canCreateShipments: boolean

  createShipment(input: CreateProviderShipmentInput): Promise<ProviderShipment>
  cancelShipment(providerShipmentId: string): Promise<void>
  checkServiceability(
    postalCode: string,
    options?: { country?: string; cod?: boolean; weightGrams?: number },
  ): Promise<ServiceabilityResult>

  /**
   * Verifies a callback against its signature, using the RAW body bytes.
   *
   * Returns null when the request is not authentic, which the route turns into
   * a 400. Throwing is for a callback that is authentic but unusable — an
   * unmapped status, a body that is not JSON — because those need a different
   * answer from whoever is looking at them.
   */
  /**
   * Live prices for one parcel, when the carrier quotes them.
   *
   * Optional: a provider that cannot quote — manual booking — simply does not
   * implement it, and the method's own flat rate stands. Returning an empty
   * array means "nobody serves this"; throwing means "could not ask", and the
   * two must not be confused, because the first should stop a sale and the
   * second must not.
   */
  /**
   * The printable label for a parcel already booked.
   *
   * Separate from booking because the two fail independently: a carrier can
   * assign an AWB and not have the label ready for a minute, and a booking
   * must not be thrown away over a PDF. Without this, a parcel that booked
   * but whose label failed has no way back — you cannot book it twice.
   */
  fetchLabel?(providerShipmentId: string): Promise<string | null>

  quoteRates?(
    postalCode: string,
    options: { weightGrams: number; cod?: boolean; country?: string },
  ): Promise<CarrierRate[]>

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): CarrierEvent | null
  /**
   * Turns an already-verified body into an event, without checking a signature.
   *
   * Only for replaying a stored payload from the failure queue — the signature
   * was checked on arrival and the carrier will not send it again. Never call
   * this on anything that came off the wire.
   */
  normalizeWebhook(payload: unknown): CarrierEvent
}
