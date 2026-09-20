import type { Prisma, ShippingMethod, ShippingRate } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getShippingProvider } from '../../integrations/shipping/index.js'
import { env } from '../../config/env.js'
import { readParcelDefaults } from './parcel.config.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * Shipping rates and serviceability (M21).
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
 * un-shippable one. A zone with `isServiceable = false` is the deliberate
 * opposite: it matches in order to refuse (FR-21.1).
 */

export interface Destination {
  country: string
  state?: string | null
  postalCode?: string | null
}

const zoneWithMethods = {
  methods: {
    where: { isActive: true },
    orderBy: [{ position: 'asc' }, { rate: 'asc' }],
    include: { rates: { orderBy: { position: 'asc' } } },
  },
} satisfies Prisma.ShippingZoneInclude

type ZoneWithMethods = Prisma.ShippingZoneGetPayload<{ include: typeof zoneWithMethods }>
type MethodWithRates = ShippingMethod & { rates: ShippingRate[] }

function matchesRegion(zone: ZoneWithMethods, destination: Destination): boolean {
  if (zone.regions.length === 0) return false

  const state = destination.state?.trim().toLowerCase()
  const pin = destination.postalCode?.replace(/\s/g, '') ?? ''

  return zone.regions.some((region) => {
    const value = region.trim().toLowerCase()
    if (state && value === state) return true
    // A numeric entry is a PIN prefix: "56" covers 560001–569999.
    if (/^\d+$/.test(value) && pin.length > 0 && pin.startsWith(value)) return true
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

// ------------------------------------------------------------ package profile

/**
 * Parcel weight for the current basket (FR-21.2).
 *
 * A variant with no weight falls back to a store-wide default rather than
 * counting as zero — a missing weight must not make a heavy parcel look light
 * enough for the cheapest band.
 */
/**
 * What one line weighs, in grams.
 *
 * The chosen part wins over the size. A product sold in parts has one size
 * variant behind every option - a top and the full set are both "M" - so a
 * weight that lived only on the variant would quote the same parcel for a
 * blouse and for a blouse, skirt and dupatta together.
 *
 * Falling through to the store-wide default rather than refusing: a garment
 * nobody has weighed still has to be sellable, and the carrier reweighs at the
 * hub anyway. The default being wrong costs money quietly, which is why it is
 * worth setting these.
 */
export function lineWeightGrams(
  item: {
    quantity: number
    variant: { weightGrams: number | null }
    setOption?: { weightGrams: number | null } | null
  },
  /** What an unweighed garment is assumed to be — the studio's number, from settings. */
  fallbackGrams: number,
): number {
  const each = item.setOption?.weightGrams ?? item.variant.weightGrams ?? fallbackGrams

  return each * item.quantity
}

export async function cartWeightGrams(cartId: string): Promise<number> {
  const [items, defaults] = await Promise.all([
    prisma.cartItem.findMany({
      where: { cartId },
      include: {
        variant: { select: { weightGrams: true } },
        setOption: { select: { weightGrams: true } },
      },
    }),
    readParcelDefaults(),
  ])

  return items.reduce((total, item) => total + lineWeightGrams(item, defaults.weightGrams), 0)
}

/** Same calculation for an order that already exists, used when shipping it. */
export async function orderWeightGrams(orderId: string): Promise<number> {
  const [items, defaults] = await Promise.all([
    prisma.orderItem.findMany({
      where: { orderId },
      include: { variant: { select: { weightGrams: true } } },
    }),
    readParcelDefaults(),
  ])

  return items.reduce(
    (total, item) => total + (item.variant?.weightGrams ?? defaults.weightGrams) * item.quantity,
    0,
  )
}

/**
 * Picks the band that applies to this parcel and basket.
 *
 * Bounds are inclusive-lower, exclusive-upper so adjacent bands can share an
 * edge. The first match in `position` order wins, which lets an operator put a
 * specific band above a general one without rewriting either.
 */
export function resolveRate(
  method: MethodWithRates,
  weightGrams: number,
  subtotal: number,
): { amount: number; band: ShippingRate | null } {
  for (const band of method.rates) {
    if (band.minWeightGrams !== null && weightGrams < band.minWeightGrams) continue
    if (band.maxWeightGrams !== null && weightGrams >= band.maxWeightGrams) continue
    if (band.minSubtotal !== null && subtotal < band.minSubtotal) continue
    if (band.maxSubtotal !== null && subtotal >= band.maxSubtotal) continue
    return { amount: band.amount, band }
  }

  // No bands, or none matched — the method's flat rate is the fallback.
  return { amount: method.rate, band: null }
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
  /**
   * Whether the delivery was *given away* — a coupon, or an order over the
   * free-shipping threshold — as opposed to merely costing nothing.
   *
   * The difference matters once a carrier prices the method. A flat rate of
   * zero is a fallback that happens to be free; it is not a promise that this
   * delivery is free whatever the courier charges. Without the distinction, a
   * method configured "priced by the cheapest courier" with a zero fallback
   * quoted the courier's price and then charged nothing for it.
   */
  waived: boolean
  isCod: boolean
  codFee: number
  minDays: number | null
  maxDays: number | null
  /** Which band produced the price, for the admin's benefit. */
  rateBand: string | null
}

/** Applies the band, then the method's threshold, then any coupon waiver. */
export function priceMethod(
  method: MethodWithRates,
  subtotal: number,
  weightGrams: number,
  freeShippingCoupon = false,
): ShippingQuote {
  const { amount, band } = resolveRate(method, weightGrams, subtotal)

  const meetsThreshold = method.freeAbove !== null && subtotal >= method.freeAbove
  const waived = freeShippingCoupon || meetsThreshold
  const cost = waived ? 0 : amount

  return {
    id: method.id,
    name: method.name,
    description: method.description,
    cost,
    rate: amount,
    isFree: cost === 0,
    waived,
    isCod: method.isCod,
    codFee: method.codFee,
    minDays: method.minDays,
    maxDays: method.maxDays,
    rateBand: band?.label ?? null,
  }
}

/** Every reason a method might not be offered, so the caller can explain it. */
function methodApplies(
  method: MethodWithRates,
  subtotal: number,
  weightGrams: number,
): boolean {
  if (method.minSubtotal !== null && subtotal < method.minSubtotal) return false
  if (method.maxSubtotal !== null && subtotal > method.maxSubtotal) return false
  if (method.maxWeightGrams !== null && weightGrams > method.maxWeightGrams) return false
  return true
}

export interface QuoteInput extends Destination {
  /** Cart subtotal after any coupon discount, in paise. */
  subtotal: number
  /** Parcel weight in grams. */
  weightGrams: number
  freeShippingCoupon?: boolean
}

export interface QuoteResult {
  zone: { id: string; name: string } | null
  methods: ShippingQuote[]
  /** False when we do not deliver there at all. */
  serviceable: boolean
  /** Customer-safe explanation when `serviceable` is false or nothing fits. */
  reason: string | null
  weightGrams: number
}

/**
 * Replaces a method's flat rate with what the carrier actually charges.
 *
 * Only methods that ask for it — a `carrierRule` of cheapest or fastest — and
 * only when the active provider can quote. Everything else keeps the rate an
 * operator set, which is what a manually booked parcel should do.
 *
 * A carrier that cannot be reached leaves every rate exactly as it was. That
 * is the point of keeping the flat rate: a checkout that fails because an
 * aggregator is down is worse than one that occasionally under-charges by a
 * few rupees, and the difference is recoverable — a lost sale is not.
 *
 * Free-shipping rules are re-applied afterwards, so a live rate is still free
 * over the threshold rather than quietly charging for a delivery the shop
 * promised.
 */
type CarrierOutcome =
  /** Rates applied, or nothing to apply them to. */
  | 'priced'
  /** The carrier answered and no courier serves that address. */
  | 'unserved'
  /** The carrier could not be asked. Flat rates stand.  */
  | 'unavailable'

async function applyCarrierRates(
  rows: ZoneWithMethods['methods'],
  quotes: ShippingQuote[],
  input: QuoteInput,
): Promise<CarrierOutcome> {
  const wanted = rows.filter((m) => m.carrierRule)
  if (wanted.length === 0) return 'priced'

  let provider
  try {
    provider = getShippingProvider()
  } catch {
    return 'unavailable'
  }
  if (!provider.quoteRates || !provider.isConfigured()) return 'unavailable'
  if (!input.postalCode) return 'unavailable'

  let rates
  try {
    rates = await provider.quoteRates(input.postalCode, {
      weightGrams: input.weightGrams,
      country: input.country,
    })
  } catch (err) {
    logger.warn({ err, postalCode: input.postalCode }, 'Carrier rates unavailable; flat rates stand')
    return 'unavailable'
  }

  /**
   * An empty answer is not an outage. The carrier was reached and said no
   * courier goes there, which is the only check the shop has that an address
   * is real — a PIN code nobody delivers to is either a typo or invented, and
   * charging a flat rate for it books a parcel that can never be collected.
   */
  if (rates.length === 0) return 'unserved'

  for (const row of wanted) {
    const quote = quotes.find((q) => q.id === row.id)
    if (!quote) continue

    /**
     * The rule's own rate, or whatever the carrier did return.
     *
     * No rate for this rule means the same courier won both — on a short
     * route the cheapest and the quickest are usually the same van. The flat
     * rate used to stand in that case, which quietly turned a 55-rupee local
     * delivery into a 350-rupee one under the name "Express". A method asked
     * to be priced by the carrier is priced by the carrier; where the two
     * rules collapse into one courier, both options show that courier's
     * price.
     */
    const rate = rates.find((r) => r.rule === row.carrierRule) ?? rates[0]
    if (!rate) continue

    quote.rate = rate.amount
    /**
     * The carrier's price is the price. A zero flat rate is a fallback that
     * happens to cost nothing, not a promise to absorb whatever the courier
     * charges — only a coupon or the free-shipping threshold does that.
     */
    quote.cost = quote.waived ? 0 : rate.amount
    quote.isFree = quote.cost === 0
    quote.minDays = rate.estimatedDays ?? quote.minDays
    quote.maxDays = rate.estimatedDays ?? quote.maxDays
    quote.rateBand = `${rate.courierName} (${rate.rule})`
  }

  return 'priced'
}

/**
 * Every method the customer may pick for this destination and basket.
 *
 * An empty list is never silently a free delivery — the caller must treat it
 * as "we cannot ship this", which is what the checkout screen and the order
 * service both do.
 */
export async function quoteShipping(input: QuoteInput): Promise<QuoteResult> {
  const zone = await resolveZone(input)

  if (!zone) {
    return {
      zone: null,
      methods: [],
      serviceable: false,
      reason: 'We do not deliver to that country yet.',
      weightGrams: input.weightGrams,
    }
  }

  // A zone can exist purely to refuse — see the note at the top of this file.
  if (!zone.isServiceable) {
    return {
      zone: { id: zone.id, name: zone.name },
      methods: [],
      serviceable: false,
      reason:
        zone.unserviceableMessage ??
        'We are not able to deliver to that address at the moment.',
      weightGrams: input.weightGrams,
    }
  }

  const methods = zone.methods
    .filter((m) => methodApplies(m, input.subtotal, input.weightGrams))
    .map((m) => priceMethod(m, input.subtotal, input.weightGrams, input.freeShippingCoupon ?? false))

  const carrier = await applyCarrierRates(zone.methods, methods, input)

  if (carrier === 'unserved') {
    return {
      zone: { id: zone.id, name: zone.name },
      methods: [],
      serviceable: false,
      reason:
        'No courier delivers to that PIN code. Please check it, or try a different address.',
      weightGrams: input.weightGrams,
    }
  }

  return {
    zone: { id: zone.id, name: zone.name },
    methods,
    serviceable: methods.length > 0,
    reason:
      methods.length > 0
        ? null
        : zone.methods.length === 0
          ? 'We are not able to deliver to that address at the moment.'
          : 'No delivery option covers this order — it may be too heavy or outside the value limits.',
    weightGrams: input.weightGrams,
  }
}

/**
 * Re-prices a specific method at checkout and refuses one the customer was
 * never offered — otherwise a hand-edited request could pick the ₹0 method for
 * an address that does not qualify (business rule: checkout cannot select an
 * ineligible or stale shipping method).
 */
export async function priceChosenMethod(
  methodId: string,
  input: QuoteInput,
): Promise<ShippingQuote> {
  const method = await prisma.shippingMethod.findUnique({
    where: { id: methodId },
    include: { zone: true, rates: { orderBy: { position: 'asc' } } },
  })
  if (!method || !method.isActive || !method.zone.isActive) {
    throw new NotFoundError('Shipping method', 'SHIPPING_METHOD_NOT_FOUND')
  }

  const zone = await resolveZone(input)
  if (!zone || zone.id !== method.zoneId) {
    throw new ValidationError('That delivery option is not available for this address')
  }
  if (!zone.isServiceable) {
    throw new ValidationError(
      zone.unserviceableMessage ?? 'We are not able to deliver to that address',
    )
  }

  if (!methodApplies(method, input.subtotal, input.weightGrams)) {
    throw new ValidationError('That delivery option is not available for this order')
  }

  const quote = priceMethod(
    method,
    input.subtotal,
    input.weightGrams,
    input.freeShippingCoupon ?? false,
  )

  /**
   * Ask the carrier again, at the moment the order is made.
   *
   * The checkout quote already refused a PIN code nobody serves, but that
   * answer came from a browser and this is the call that takes money. A
   * request that skipped the quote — or an address edited between quoting and
   * paying — would otherwise be priced at the flat rate and charged for a
   * parcel no courier will collect.
   *
   * The same rule as the quote: a carrier that cannot be reached leaves the
   * flat rate standing, because an outage must not stop a sale.
   */
  const outcome = await applyCarrierRates([method], [quote], input)
  if (outcome === 'unserved') {
    throw new ValidationError(
      'No courier delivers to that PIN code. Please check the address.',
      { code: 'ADDRESS_NOT_SERVICEABLE' },
    )
  }

  return quote
}
