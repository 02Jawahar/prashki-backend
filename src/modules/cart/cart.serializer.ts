import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { discountPercent } from '../../utils/money.js'

/**
 * Cart pricing (spec §22, §23).
 *
 * Every figure here is read from the database at read time. Nothing about price
 * or availability is ever taken from the client — the request only ever says
 * *which* variant and *how many*.
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

export function serializeCart(cart: CartRow) {
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

  return {
    id: cart.id,
    token: cart.token,
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal,
    issues,
    /** Checkout is only allowed when there is something valid to buy. */
    checkoutReady: items.length > 0 && issues.length === 0,
  }
}

export type SerializedCart = ReturnType<typeof serializeCart>

export async function loadCart(cartId: string): Promise<CartRow> {
  return prisma.cart.findUniqueOrThrow({ where: { id: cartId }, include: cartInclude })
}
