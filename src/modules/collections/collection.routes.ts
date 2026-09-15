import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { productListSelect, toProductListItem } from '../products/product.serializer.js'

/**
 * Collections — the seasonal drops shown on Discover (M23, M25).
 *
 * A collection is when a piece was made; a category is what it is. A product
 * has one category and belongs to as many collections as it was carried in, so
 * this is a join table rather than a column — see the note on the model.
 *
 * Only ACTIVE collections are public, and a collection's products are filtered
 * to the ones that are themselves sellable. A drop that is live while half its
 * pieces are drafts should show the half that exists, not a grid of gaps.
 */

const STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const

/** What the storefront needs, and nothing operational. */
const publicSelect = {
  id: true,
  name: true,
  slug: true,
  year: true,
  description: true,
  coverImage: true,
  seoTitle: true,
  seoDescription: true,
  publishedAt: true,
} satisfies Prisma.CollectionSelect

export const collectionRouter: Router = Router()

/** The Discover grid. */
collectionRouter.get('/', async (_req, res) => {
  const collections = await prisma.collection.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ position: 'asc' }, { year: 'desc' }, { name: 'asc' }],
    select: {
      ...publicSelect,
      _count: { select: { products: true } },
    },
  })

  return ok(res, {
    collections: collections.map(({ _count, ...c }) => ({ ...c, productCount: _count.products })),
  })
})

/** One collection and the pieces in it. */
collectionRouter.get('/:slug', async (req, res) => {
  const { slug } = req.params as { slug: string }

  /*
   * Written as one literal rather than spreading `publicSelect` into it.
   * Spreading widens the object and Prisma stops checking the field names, so a
   * typo compiles and fails at runtime — which is exactly how `altText` got
   * shipped as `alt` once already.
   */
  const collection = await prisma.collection.findFirst({
    where: { slug, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      slug: true,
      year: true,
      description: true,
      coverImage: true,
      seoTitle: true,
      seoDescription: true,
      publishedAt: true,
      products: {
        orderBy: { position: 'asc' },
        // The same shape the product list returns, so a collection's pieces
        // render through the existing card rather than a near-copy of it that
        // drifts the first time the card gains a field.
        select: { product: { select: productListSelect } },
      },
    } satisfies Prisma.CollectionSelect,
  })

  if (!collection) throw new NotFoundError('Collection', 'COLLECTION_NOT_FOUND')

  /**
   * Drafts and archived pieces are dropped here rather than in the query,
   * because filtering a nested relation would silently return the collection
   * with an empty list when every piece is a draft — indistinguishable from a
   * collection nobody has filled in.
   */
  const { products, ...rest } = collection
  return ok(res, {
    collection: rest,
    products: products
      .map((p) => p.product)
      .filter((p) => p.status === 'ACTIVE')
      .map(toProductListItem),
  })
})

// ------------------------------------------------------------------- admin

export const adminCollectionRouter: Router = Router()

const fields = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(140)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens'),
  /// A drop is known by its year; a full date implies a precision nobody has.
  year: z.coerce.number().int().min(1900).max(2200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  coverImage: z.string().trim().max(500).nullable().optional(),
  seoTitle: z.string().trim().max(200).nullable().optional(),
  seoDescription: z.string().trim().max(400).nullable().optional(),
  status: z.enum(STATUSES).default('DRAFT'),
  position: z.coerce.number().int().min(0).default(0),
  productIds: z.array(z.string().trim().min(1)).max(200).default([]),
})

const createSchema = fields
const patchSchema = fields.partial()

adminCollectionRouter.get('/', requirePermission('content.read'), async (_req, res) => {
  const collections = await prisma.collection.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    include: { _count: { select: { products: true } } },
  })

  return ok(res, {
    collections: collections.map(({ _count, ...c }) => ({ ...c, productCount: _count.products })),
  })
})

adminCollectionRouter.get('/:id', requirePermission('content.read'), async (req, res) => {
  const { id } = req.params as { id: string }
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      products: {
        orderBy: { position: 'asc' },
        include: { product: { select: { id: true, name: true, sku: true, slug: true } } },
      },
    },
  })
  if (!collection) throw new NotFoundError('Collection', 'COLLECTION_NOT_FOUND')

  const { products, ...rest } = collection
  return ok(res, { collection: { ...rest, products: products.map((p) => p.product) } })
})

/** Replaces the membership wholesale — the editor always sends the full set. */
async function setProducts(collectionId: string, productIds: string[]) {
  await prisma.collectionProduct.deleteMany({ where: { collectionId } })
  if (productIds.length === 0) return
  await prisma.collectionProduct.createMany({
    data: productIds.map((productId, position) => ({ collectionId, productId, position })),
    skipDuplicates: true,
  })
}

adminCollectionRouter.post(
  '/',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: createSchema }),
  async (req, res) => {
    const { productIds, ...body } = req.validated!.body as z.infer<typeof createSchema>

    const clash = await prisma.collection.findUnique({ where: { slug: body.slug } })
    if (clash) throw new ConflictError('A collection already uses that web address', 'SLUG_TAKEN')

    const collection = await prisma.collection.create({
      data: {
        ...body,
        // Set when it first goes live, and never recomputed — the date a drop
        // launched is a fact about the drop, not about the last time it was
        // edited.
        publishedAt: body.status === 'ACTIVE' ? new Date() : null,
      },
    })

    await setProducts(collection.id, productIds)

    recordAudit({
      action: 'COLLECTION_CREATED',
      entityType: 'Collection',
      entityId: collection.id,
      metadata: { slug: collection.slug, products: productIds.length },
      req,
    })

    return created(res, { collection })
  },
)

adminCollectionRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: patchSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { productIds, ...body } = req.validated!.body as Partial<z.infer<typeof createSchema>>

    const existing = await prisma.collection.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Collection', 'COLLECTION_NOT_FOUND')

    if (body.slug && body.slug !== existing.slug) {
      const clash = await prisma.collection.findUnique({ where: { slug: body.slug } })
      if (clash) throw new ConflictError('A collection already uses that web address', 'SLUG_TAKEN')
    }

    const collection = await prisma.collection.update({
      where: { id },
      data: {
        ...body,
        ...(body.status === 'ACTIVE' && !existing.publishedAt ? { publishedAt: new Date() } : {}),
      },
    })

    if (productIds) await setProducts(id, productIds)

    recordAudit({
      action: 'COLLECTION_UPDATED',
      entityType: 'Collection',
      entityId: id,
      metadata: { slug: collection.slug },
      req,
    })

    return ok(res, { collection })
  },
)

adminCollectionRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const existing = await prisma.collection.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    })
    if (!existing) throw new NotFoundError('Collection', 'COLLECTION_NOT_FOUND')

    /**
     * A collection that has been published is archived rather than deleted. Its
     * address may be in a customer's bookmarks or an email, and deleting the
     * row turns that into a 404 with nothing to explain it. An unpublished one
     * nobody has seen is deleted properly.
     */
    if (existing.publishedAt) {
      const collection = await prisma.collection.update({
        where: { id },
        data: { status: 'ARCHIVED' },
      })
      recordAudit({ action: 'COLLECTION_ARCHIVED', entityType: 'Collection', entityId: id, req })
      return ok(res, {
        deleted: false,
        collection,
        message: 'That collection has been live, so it was archived rather than deleted.',
      })
    }

    await prisma.collection.delete({ where: { id } })
    recordAudit({ action: 'COLLECTION_DELETED', entityType: 'Collection', entityId: id, req })
    return ok(res, { deleted: true })
  },
)
