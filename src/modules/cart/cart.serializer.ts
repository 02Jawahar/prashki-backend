import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { discountPercent } from '../../utils/money.js'
import { tryEvaluateCoupon, type DiscountableLine } from '../coupons/coupon.service.js'

/**
 * Cart pricing (spec §22, §23).
 *
 * Every figure here is read from the database at read time. Nothing about price
 * or availability is ever taken from the client — the request only ever says
 * *which* variant and *how many*.
 *
 * The applied coupon is re-evaluated on every read for the same reason: a code
 * that expired, ran out, or stopped matching the bag must stop discounting the
 * moment that happens, not at checkout.
 */
export const cartInclude = {
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      variant: {
        include: {
          inventory: true,
          product: {
            include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude

export type CartRow = Prisma.CartGetPayload<{ include: typeof cartInclude }>

export interface CartIssue {
  itemId: string
  code: 'PRODUCT_UNAVAILABLE' | 'VARIANT_UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'QUANTITY_REDUCED'
  message: string
}

export interface SerializeOptions {
  /** Needed for per-customer coupon rules; null for a guest cart. */
  userId?: string | null
}

export async function serializeCart(cart: CartRow, options: SerializeOptions = {}) {
  const issues: CartIssue[] = []

  const items = cart.items.map((item) => {
    const { variant } = item
    const { product } = variant

    const unitPrice = variant.price ?? product.price
    const stock = variant.inventory?.availableStock ?? 0

    // Validation runs on read so a stale cart surfaces problems before checkout.
    const productUnavailable = product.status !== 'ACTIVE'
    const variantUnavailable = variant.status !== 'ACTIVE'

    if (productUnavailable) {
      issues.push({
        itemId: item.id,
        code: 'PRODUCT_UNAVAILABLE',
        message: `${product.name} is no longer available`,
      })
    } else if (variantUnavailable) {
      issues.push({
        itemId: item.id,
        code: 'VARIANT_UNAVAILABLE',
        message: `${product.name} (${variant.name}) is no longer available`,
      })
    } else if (stock < item.quantity) {
      issues.push({
        itemId: item.id,
        code: 'INSUFFICIENT_STOCK',
        message:
          stock === 0
            ? `${product.name} (${variant.name}) is out of stock`
            : `Only ${stock} of ${product.name} (${variant.name}) left`,
      })
    }

    return {
      id: item.id,
      variantId: variant.id,
      productId: product.id,
      categoryId: product.categoryId,
      quantity: item.quantity,
      unitPrice,
      lineTotal: unitPrice * item.quantity,
      compareAtPrice: product.compareAtPrice,
      discountPercent: discountPercent(unitPrice, product.compareAtPrice),
      availableStock: stock,
      purchasable: !productUnavailable && !variantUnavailable && stock >= item.quantity,
      variant: { id: variant.id, name: variant.name, sku: variant.sku },
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        image: product.images[0]?.url ?? null,
      },
    }
  })

  const purchasable = items.filter((i) => i.purchasable)
  const subtotal = purchasable.reduce((sum, i) => sum + i.lineTotal, 0)

  const coupon = await resolveCartCoupon(cart, purchasable, subtotal, options.userId ?? null)

  return {
    id: cart.id,
    token: cart.token,
    items: items.map((i) => ({ ...i, discountAllocated: coupon.allocation[i.id] ?? 0 })),
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal,
    discount: coupon.discount,
    /** What the customer pays for the goods themselves, before shipping and tax. */
    discountedSubtotal: subtotal - coupon.discount,
    coupon: coupon.summary,
    /** True when the applied coupon waives the delivery charge. */
    freeShipping: coupon.freeShipping,
    issues,
    /** Checkout is only allowed when there is something valid to buy. */
    checkoutReady: items.length > 0 && issues.length === 0,
  }
}

/** Shape returned to the client — never the whole coupon row. */
export interface CartCouponSummary {
  code: string
  description: string | null
  type: string
  amount: number
  freeShipping: boolean
}

/**
 * Turns the code saved on the cart into money, or into a reason it no longer
 * applies. A code that has become invalid is dropped from the cart so the
 * customer is told once rather than on every page load.
 */
async function resolveCartCoupon(
  cart: CartRow,
  lines: Array<{ id: string; productId: string; categoryId: string | null; unitPrice: number; quantity: number; lineTotal: number; compareAtPrice: number | null }>,
  subtotal: number,
  userId: string | null,
): Promise<{
  discount: number
  allocation: Record<string, number>
  freeShipping: boolean
  summary: (CartCouponSummary & { error?: string }) | null
}> {
  const empty = { discount: 0, allocation: {}, freeShipping: false, summary: null }
  if (!cart.couponCode || lines.length === 0) return empty

  const discountable: DiscountableLine[] = lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    categoryIds: l.categoryId ? [l.categoryId] : [],
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    lineTotal: l.lineTotal,
    isDiscounted: l.compareAtPrice !== null && l.compareAtPrice > l.unitPrice,
  }))

  const { evaluation, error } = await tryEvaluateCoupon({
    code: cart.couponCode,
    userId,
    lines: discountable,
    subtotal,
  })

  if (!evaluation) {
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } })
    return {
      ...empty,
      summary: {
        code: cart.couponCode,
        description: null,
        type: 'INVALID',
        amount: 0,
        freeShipping: false,
        error: error?.message ?? 'That code is no longer valid',
      },
    }
  }

  return {
    discount: evaluation.discount,
    allocation: evaluation.allocation,
    freeShipping: evaluation.freeShipping,
    summary: {
      code: evaluation.coupon.code,
      description: evaluation.coupon.description,
      type: evaluation.coupon.type,
      amount: evaluation.discount,
      freeShipping: evaluation.freeShipping,
    },
  }
}

export type SerializedCart = Awaited<ReturnType<typeof serializeCart>>

export async function loadCart(cartId: string): Promise<CartRow> {
  return prisma.cart.findUniqueOrThrow({ where: { id: cartId }, include: cartInclude })
}
