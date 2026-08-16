import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'

/**
 * Reviews (M17).
 *
 * Two properties this file protects:
 *
 *   1. `isVerifiedPurchase` is derived from delivered orders, never accepted
 *      from the request — the badge is only worth anything if it cannot be set
 *      by asking for it.
 *   2. The rating aggregates on Product are recomputed from APPROVED rows
 *      whenever moderation changes, rather than nudged up and down. An
 *      incremental counter drifts the first time a moderation action is
 *      retried; a recompute cannot.
 */

/** True when the customer has a delivered order containing this product. */
export async function hasPurchased(userId: string, productId: string): Promise<boolean> {
  const order = await prisma.order.findFirst({
    where: {
      userId,
      status: 'DELIVERED',
      items: { some: { productId } },
    },
    select: { id: true },
  })
  return order !== null
}

/**
 * Recomputes a product's rating from its approved reviews. Called after any
 * moderation change, inside the same transaction where possible.
 */
export async function recomputeRating(
  productId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ ratingAverage: number; ratingCount: number }> {
  const stats = await client.review.aggregate({
    where: { productId, status: 'APPROVED' },
    _avg: { rating: true },
    _count: { _all: true },
  })

  // One decimal place: "4.3" is honest, "4.2857142857" is noise.
  const ratingAverage = Math.round((stats._avg.rating ?? 0) * 10) / 10
  const ratingCount = stats._count._all

  await client.product.update({
    where: { id: productId },
    data: { ratingAverage, ratingCount },
  })

  return { ratingAverage, ratingCount }
}

/** Distribution for the "5 star / 4 star / …" bars on a product page. */
export async function ratingBreakdown(productId: string): Promise<Record<number, number>> {
  const rows = await prisma.review.groupBy({
    by: ['rating'],
    where: { productId, status: 'APPROVED' },
    _count: { _all: true },
  })

  const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const row of rows) breakdown[row.rating] = row._count._all
  return breakdown
}

export const publicReviewSelect = {
  id: true,
  rating: true,
  title: true,
  body: true,
  images: true,
  isVerifiedPurchase: true,
  helpfulCount: true,
  adminResponse: true,
  adminRespondedAt: true,
  createdAt: true,
  user: { select: { id: true, name: true } },
} satisfies Prisma.ReviewSelect
