import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { discountPercent } from '../../utils/money.js'

/**
 * Wishlist (M18).
 *
 * Signed-in only. A guest wishlist would need its own cookie identity and a
 * merge-on-login path for very little gain — the "save this" prompt sends
 * guests to sign in instead.
 *
 * Rows survive a product going out of stock or inactive; the serializer marks
 * them so the UI can show "back soon" rather than dropping the item silently.
 */
export const wishlistRouter: Router = Router()

wishlistRouter.use(requireAuth)

const itemInclude = {
  product: {
    include: {
      images: { orderBy: { sortOrder: 'asc' }, take: 1 },
      variants: {
        where: { status: 'ACTIVE' },
        orderBy: { position: 'asc' },
        include: { inventory: true },
      },
    },
  },
  variant: { include: { inventory: true } },
} satisfies Prisma.WishlistItemInclude

type WishlistRow = Prisma.WishlistItemGetPayload<{ include: typeof itemInclude }>

function serialize(item: WishlistRow) {
  const { product } = item
  const price = item.variant?.price ?? product.price

  // Available if the chosen variant has stock, or — when no variant was saved —
  // if any active variant does.
  const inStock = item.variant
    ? (item.variant.inventory?.availableStock ?? 0) > 0
    : product.variants.some((v) => (v.inventory?.availableStock ?? 0) > 0)

  return {
    id: item.id,
    addedAt: item.createdAt,
    available: product.status === 'ACTIVE' && (!item.variant || item.variant.status === 'ACTIVE'),
    inStock,
    price,
    compareAtPrice: product.compareAtPrice,
    discountPercent: discountPercent(price, product.compareAtPrice),
    variant: item.variant ? { id: item.variant.id, name: item.variant.name, sku: item.variant.sku } : null,
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      image: product.images[0]?.url ?? null,
      status: product.status,
    },
  }
}

wishlistRouter.get('/', async (req, res) => {
  const items = await prisma.wishlistItem.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    include: itemInclude,
  })

  return ok(res, { items: items.map(serialize), count: items.length })
})

const addSchema = z.object({
  productId: z.string().trim().min(1),
  /** Optional: saving a specific size rather than the product. */
  variantId: z.string().trim().min(1).optional(),
})

wishlistRouter.post('/', writeLimiter, validate({ body: addSchema }), async (req, res) => {
  const { productId, variantId } = req.validated!.body as z.infer<typeof addSchema>

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, variants: { select: { id: true } } },
  })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  // A variant from a different product would make the row incoherent.
  if (variantId && !product.variants.some((v) => v.id === variantId)) {
    throw new NotFoundError('Variant', 'VARIANT_NOT_FOUND')
  }

  /**
   * The unique constraint covers (userId, productId, variantId), but Postgres
   * treats NULLs as distinct — so it does not stop a second product-level save.
   * The lookup below is what actually makes "save" idempotent; the constraint
   * still catches the variant-level case and a narrow concurrent race.
   */
  const existing = await prisma.wishlistItem.findFirst({
    where: { userId: req.user!.id, productId, variantId: variantId ?? null },
    include: itemInclude,
  })
  if (existing) return ok(res, { item: serialize(existing), alreadySaved: true })

  try {
    const item = await prisma.wishlistItem.create({
      data: { userId: req.user!.id, productId, variantId: variantId ?? null },
      include: itemInclude,
    })
    return created(res, { item: serialize(item) })
  } catch (err) {
    // Adding something already saved is not an error — it is the same outcome.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.wishlistItem.findFirstOrThrow({
        where: { userId: req.user!.id, productId, variantId: variantId ?? null },
        include: itemInclude,
      })
      return ok(res, { item: serialize(raced), alreadySaved: true })
    }
    throw err
  }
})

wishlistRouter.delete('/:id', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }

  // Scoped by userId, so another account's row simply matches nothing.
  const result = await prisma.wishlistItem.deleteMany({ where: { id, userId: req.user!.id } })
  if (result.count === 0) throw new NotFoundError('Wishlist item', 'WISHLIST_ITEM_NOT_FOUND')

  return ok(res, { removed: true })
})

/** Convenience for the product page's heart toggle, which knows the product. */
wishlistRouter.delete('/product/:productId', writeLimiter, async (req, res) => {
  const { productId } = req.params as { productId: string }

  const result = await prisma.wishlistItem.deleteMany({
    where: { userId: req.user!.id, productId },
  })

  return ok(res, { removed: result.count > 0, count: result.count })
})
