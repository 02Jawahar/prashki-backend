import type { Prisma, ShippingMethod } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * Shipping rates (M21).
 *
 * A destination resolves to exactly one zone, and the zone's methods are what
 * the customer may choose from. The chosen method's price is recomputed at
 * checkout from the same rows — the client picks an id, never an amount.
 *
 * Zone matching, most specific first:
 *
 *   1. a zone whose `regions` names the state, or whose PIN prefix matches
 *   2. a zone that covers the country with no region restriction
 *   3. the zone flagged `isDefault`
 *
 * Falling through to the default is what stops an unusual address becoming an
 * un-shippable one.
 */

export interface Destination {
  country: string
  state?: string | null
  postalCode?: string | null
}

const zoneWithMethods = {
  methods: { where: { isActive: true }, orderBy: [{ position: 'asc' }, { rate: 'asc' }] },
} satisfies Prisma.ShippingZoneInclude

type ZoneWithMethods = Prisma.ShippingZoneGetPayload<{ include: typeof zoneWithMethods }>

function matchesRegion(zone: ZoneWithMethods, destination: Destination): boolean {
  if (zone.regions.length === 0) return false

  const state = destination.state?.trim().toLowerCase()
  const pin = destination.postalCode?.replace(/\s/g, '') ?? ''

  return zone.regions.some((region) => {
    const value = region.trim().toLowerCase()
    if (state && value === state) return true
    // A numeric entry is a PIN prefix: "56" covers 560001–569999.
    if (/^\d+$/.test(value) && pin.startsWith(value)) return true
    return false
  })
}

export async function resolveZone(destination: Destination): Promise<ZoneWithMethods | null> {
  const country = destination.country.trim().toUpperCase()

  const candidates = await prisma.shippingZone.findMany({
    where: { isActive: true, OR: [{ countries: { has: country } }, { isDefault: true }] },
    orderBy: { position: 'asc' },
    include: zoneWithMethods,
  })

  const inCountry = candidates.filter((z) => z.countries.includes(country))

  return (
    inCountry.find((z) => matchesRegion(z, destination)) ??
    inCountry.find((z) => z.regions.length === 0) ??
    candidates.find((z) => z.isDefault) ??
    null
  )
}

export interface ShippingQuote {
  id: string
  name: string
  description: string | null
  /** Paise the customer will actually be charged, after free-shipping rules. */
  cost: number
  /** The list price, so the UI can show "Free" against a struck-through rate. */
  rate: number
  isFree: boolean
  isCod: boolean
  codFee: number
  minDays: number | null
  maxDays: number | null
}

/** Applies the method's own free-shipping threshold and any coupon waiver. */
export function priceMethod(
  method: ShippingMethod,
  subtotal: number,
  freeShippingCoupon = false,
): ShippingQuote {
  const meetsThreshold = method.freeAbove !== null && subtotal >= method.freeAbove
  const cost = freeShippingCoupon || meetsThreshold ? 0 : method.rate

  return {
    id: method.id,
    name: method.name,
    description: method.description,
    cost,
    rate: method.rate,
    isFree: cost === 0,
    isCod: method.isCod,
    codFee: method.codFee,
    minDays: method.minDays,
    maxDays: method.maxDays,
  }
}

export interface QuoteInput extends Destination {
  /** Cart subtotal after any coupon discount, in paise. */
  subtotal: number
  freeShippingCoupon?: boolean
}

/**
 * Every method the customer may pick for this destination and basket. An empty
 * list means we do not deliver there — the caller must not silently fall back
 * to a zero-cost delivery.
 */
export async function quoteShipping(input: QuoteInput): Promise<{
  zone: { id: string; name: string } | null
  methods: ShippingQuote[]
}> {
  const zone = await resolveZone(input)
  if (!zone) return { zone: null, methods: [] }

  const methods = zone.methods
    .filter((m) => {
      if (m.minSubtotal !== null && input.subtotal < m.minSubtotal) return false
      if (m.maxSubtotal !== null && input.subtotal > m.maxSubtotal) return false
      return true
    })
    .map((m) => priceMethod(m, input.subtotal, input.freeShippingCoupon ?? false))

  return { zone: { id: zone.id, name: zone.name }, methods }
}

/**
 * Re-prices a specific method at checkout and refuses one the customer was
 * never offered — otherwise a hand-edited request could pick the ₹0 method for
 * an address that does not qualify.
 */
export async function priceChosenMethod(
  methodId: string,
  input: QuoteInput,
): Promise<ShippingQuote> {
  const method = await prisma.shippingMethod.findUnique({
    where: { id: methodId },
    include: { zone: true },
  })
  if (!method || !method.isActive || !method.zone.isActive) {
    throw new NotFoundError('Shipping method', 'SHIPPING_METHOD_NOT_FOUND')
  }

  const zone = await resolveZone(input)
  if (!zone || zone.id !== method.zoneId) {
    throw new ValidationError('That delivery option is not available for this address')
  }

  if (method.minSubtotal !== null && input.subtotal < method.minSubtotal) {
    throw new ValidationError('That delivery option is not available for this order')
  }
  if (method.maxSubtotal !== null && input.subtotal > method.maxSubtotal) {
    throw new ValidationError('That delivery option is not available for this order')
  }

  return priceMethod(method, input.subtotal, input.freeShippingCoupon ?? false)
}
