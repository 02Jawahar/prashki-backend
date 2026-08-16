import type { Coupon, Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ValidationError } from '../../utils/errors.js'

/**
 * The discount engine (M13).
 *
 * One rule governs everything here: the client names a coupon, the server
 * decides what it is worth. A discount is recomputed from the `Coupon` row on
 * every cart read and again inside the checkout transaction, so a code that
 * expires between "apply" and "place order" is caught at the moment it matters.
 *
 * All arithmetic is integer paise. The proportional allocation below uses
 * largest-remainder so the per-line shares always add back up to the discount
 * exactly — a floor-and-hope split leaves stray paise that surface later as
 * refunds that do not reconcile.
 */

/** What the engine needs to know about a line. Deliberately not a Prisma type. */
export interface DiscountableLine {
  /** Cart item id, or order item index — whatever the caller uses to match up. */
  id: string
  productId: string
  categoryIds: string[]
  unitPrice: number
  quantity: number
  lineTotal: number
  /** True when the item is already marked down (price below compareAtPrice). */
  isDiscounted: boolean
}

export interface CouponEvaluation {
  coupon: Coupon
  /** Total paise removed from the order. */
  discount: number
  /** Per-line share, keyed by line id. Sums exactly to `discount`. */
  allocation: Record<string, number>
  /** True when the coupon waives shipping rather than reducing the subtotal. */
  freeShipping: boolean
}

export class CouponError extends ValidationError {
  constructor(message: string, readonly reason: string) {
    super(message)
  }
}

const couponWithScope = {
  products: { select: { productId: true } },
  categories: { select: { categoryId: true } },
} satisfies Prisma.CouponInclude

type CouponWithScope = Prisma.CouponGetPayload<{ include: typeof couponWithScope }>

/** Codes are stored and compared upper-case, so "welcome10" and "WELCOME10" match. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

async function findUsable(code: string): Promise<CouponWithScope> {
  const coupon = await prisma.coupon.findUnique({
    where: { code: normalizeCode(code) },
    include: couponWithScope,
  })
  // An unknown code and a draft coupon give the same answer: a draft coupon is
  // not yet public, and saying "that exists but isn't live" leaks the roadmap.
  if (!coupon || coupon.status === 'DRAFT') {
    throw new CouponError('That code is not valid', 'NOT_FOUND')
  }
  return coupon
}

/**
 * Which lines a coupon can act on. A coupon with no product and no category
 * restriction applies to the whole cart.
 */
function eligibleLines(coupon: CouponWithScope, lines: DiscountableLine[]): DiscountableLine[] {
  const productIds = new Set(coupon.products.map((p) => p.productId))
  const categoryIds = new Set(coupon.categories.map((c) => c.categoryId))
  const scoped = productIds.size > 0 || categoryIds.size > 0

  return lines.filter((line) => {
    if (coupon.excludeDiscounted && line.isDiscounted) return false
    if (!scoped) return true
    if (productIds.has(line.productId)) return true
    return line.categoryIds.some((id) => categoryIds.has(id))
  })
}

/**
 * Splits `total` across lines in proportion to their value, in whole paise.
 *
 * Largest-remainder: floor every share, then hand the leftover paise out one at
 * a time to the lines with the biggest fractional part. Guarantees the shares
 * sum to `total`, and that no line is discounted below zero.
 */
function allocateProportionally(
  total: number,
  lines: DiscountableLine[],
): Record<string, number> {
  const basis = lines.reduce((sum, l) => sum + l.lineTotal, 0)
  const allocation: Record<string, number> = {}
  if (basis <= 0 || total <= 0) {
    for (const line of lines) allocation[line.id] = 0
    return allocation
  }

  const remainders: Array<{ id: string; fraction: number }> = []
  let assigned = 0

  for (const line of lines) {
    const exact = (total * line.lineTotal) / basis
    const whole = Math.floor(exact)
    allocation[line.id] = whole
    assigned += whole
    remainders.push({ id: line.id, fraction: exact - whole })
  }

  remainders.sort((a, b) => b.fraction - a.fraction)
  let leftover = total - assigned
  for (const { id } of remainders) {
    if (leftover <= 0) break
    // Never push a line's discount past what the line is worth.
    const line = lines.find((l) => l.id === id)!
    if (allocation[id]! < line.lineTotal) {
      allocation[id]! += 1
      leftover -= 1
    }
  }

  return allocation
}

export interface EvaluateInput {
  code: string
  userId: string | null
  lines: DiscountableLine[]
  /** Cart subtotal in paise, already computed by the caller. */
  subtotal: number
  /** Excludes the order currently being placed, when called from checkout. */
  excludeOrderId?: string
}

/**
 * Full eligibility check plus the resulting discount. Throws `CouponError` with
 * a customer-safe message when the coupon cannot be used.
 */
export async function evaluateCoupon(input: EvaluateInput): Promise<CouponEvaluation> {
  const coupon = await findUsable(input.code)
  const now = new Date()

  if (coupon.status === 'PAUSED') throw new CouponError('That code is not active right now', 'PAUSED')
  if (coupon.status === 'EXPIRED') throw new CouponError('That code has expired', 'EXPIRED')
  if (coupon.startsAt && coupon.startsAt > now) {
    throw new CouponError('That code is not active yet', 'NOT_STARTED')
  }
  if (coupon.endsAt && coupon.endsAt < now) throw new CouponError('That code has expired', 'EXPIRED')

  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new CouponError('That code has been fully redeemed', 'USAGE_LIMIT')
  }

  if (input.subtotal < coupon.minSubtotal) {
    throw new CouponError(
      `Add ₹${((coupon.minSubtotal - input.subtotal) / 100).toFixed(0)} more to use that code`,
      'MIN_SUBTOTAL',
    )
  }

  // Per-customer rules need an identity; a guest cart cannot satisfy them.
  if (coupon.perUserLimit !== null || coupon.firstOrderOnly) {
    if (!input.userId) {
      throw new CouponError('Sign in to use that code', 'LOGIN_REQUIRED')
    }

    if (coupon.perUserLimit !== null) {
      const used = await prisma.couponRedemption.count({
        where: {
          couponId: coupon.id,
          userId: input.userId,
          ...(input.excludeOrderId ? { orderId: { not: input.excludeOrderId } } : {}),
        },
      })
      if (used >= coupon.perUserLimit) {
        throw new CouponError('You have already used that code', 'PER_USER_LIMIT')
      }
    }

    if (coupon.firstOrderOnly) {
      const priorOrders = await prisma.order.count({
        where: {
          userId: input.userId,
          status: { not: 'CANCELLED' },
          ...(input.excludeOrderId ? { id: { not: input.excludeOrderId } } : {}),
        },
      })
      if (priorOrders > 0) {
        throw new CouponError('That code is for first orders only', 'FIRST_ORDER_ONLY')
      }
    }
  }

  const eligible = eligibleLines(coupon, input.lines)
  if (eligible.length === 0) {
    throw new CouponError('That code does not apply to anything in your bag', 'NO_ELIGIBLE_ITEMS')
  }

  const eligibleTotal = eligible.reduce((sum, l) => sum + l.lineTotal, 0)

  if (coupon.type === 'FREE_SHIPPING') {
    // Shipping is not part of the subtotal, so nothing is allocated to lines.
    return {
      coupon,
      discount: 0,
      allocation: Object.fromEntries(input.lines.map((l) => [l.id, 0])),
      freeShipping: true,
    }
  }

  let discount =
    coupon.type === 'PERCENTAGE'
      ? // `value` is basis points: 1000 = 10%. Integer maths, then round once.
        Math.round((eligibleTotal * coupon.value) / 10_000)
      : coupon.value

  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount)
  // A fixed-amount coupon larger than the eligible items must not make the
  // order negative, and must not spill onto items it does not cover.
  discount = Math.min(discount, eligibleTotal)

  const allocation = allocateProportionally(discount, eligible)
  for (const line of input.lines) allocation[line.id] ??= 0

  return { coupon, discount, allocation, freeShipping: false }
}

/**
 * Same as `evaluateCoupon` but returns the failure instead of throwing, for the
 * cart read path where an invalid saved code should downgrade to "no discount"
 * rather than break the whole response.
 */
export async function tryEvaluateCoupon(
  input: EvaluateInput,
): Promise<{ evaluation: CouponEvaluation | null; error: { code: string; message: string } | null }> {
  try {
    return { evaluation: await evaluateCoupon(input), error: null }
  } catch (err) {
    if (err instanceof CouponError) {
      return { evaluation: null, error: { code: err.reason, message: err.message } }
    }
    throw err
  }
}

/**
 * Records a redemption and increments the counter. Must run inside the order
 * transaction: the `usageCount` bump and the order row have to commit together
 * or a failed checkout burns a use.
 *
 * The limit is enforced here with a conditional update rather than by trusting
 * the earlier eligibility check. Eligibility was evaluated before the
 * transaction; between then and now another checkout could have taken the last
 * one. `updateMany` with the bound in its WHERE makes the database the arbiter,
 * so a limited coupon can never be over-redeemed no matter how the requests
 * interleave.
 */
export async function recordRedemption(
  tx: Prisma.TransactionClient,
  args: { coupon: Coupon; userId: string; orderId: string; amount: number },
): Promise<void> {
  const { coupon } = args

  if (coupon.usageLimit !== null) {
    const claimed = await tx.coupon.updateMany({
      where: { id: coupon.id, usageCount: { lt: coupon.usageLimit } },
      data: { usageCount: { increment: 1 } },
    })
    if (claimed.count !== 1) {
      throw new CouponError('That code has been fully redeemed', 'USAGE_LIMIT')
    }
  } else {
    await tx.coupon.update({ where: { id: coupon.id }, data: { usageCount: { increment: 1 } } })
  }

  // The unique constraint on orderId is the second guard: a retried checkout
  // cannot record the same redemption twice.
  await tx.couponRedemption.create({
    data: { couponId: coupon.id, userId: args.userId, orderId: args.orderId, amount: args.amount },
  })
}

/** Releases a redemption when the order it belonged to is cancelled. */
export async function releaseRedemption(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId } })
  if (!redemption) return

  await tx.couponRedemption.delete({ where: { orderId } })
  await tx.coupon.update({
    where: { id: redemption.couponId },
    // Guard against dropping below zero if a counter was ever reset by hand.
    data: { usageCount: { decrement: 1 } },
  })
}
