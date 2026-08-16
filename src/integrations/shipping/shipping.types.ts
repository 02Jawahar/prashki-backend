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

  /** Verifies a callback against its signature, using the RAW body bytes. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): CarrierEvent | null
}
