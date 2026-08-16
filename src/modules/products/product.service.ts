import type { Prisma, ProductStatus } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { NotFoundError } from '../../utils/errors.js'
import {
  productDetailInclude,
  productListSelect,
  toProductDetail,
  toProductListItem,
} from './product.serializer.js'
import type { AdminListQuery, PublicListQuery } from './product.schemas.js'

const SORTS: Record<string, Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[]> = {
  featured: [{ featured: 'desc' }, { publishedAt: 'desc' }],
  newest: { publishedAt: 'desc' },
  oldest: { publishedAt: 'asc' },
  'price-asc': { price: 'asc' },
  'price-desc': { price: 'desc' },
  'name-asc': { name: 'asc' },
  'name-desc': { name: 'desc' },
  // Products with no reviews sort last rather than tying at zero with the
  // genuinely poorly-reviewed ones.
  rating: [{ ratingAverage: 'desc' }, { ratingCount: 'desc' }],
}

function buildWhere(
  q: PublicListQuery | AdminListQuery,
  { statuses }: { statuses?: ProductStatus[] } = {},
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = []

  if (statuses?.length) and.push({ status: { in: statuses } })
  if ('status' in q && q.status) and.push({ status: q.status })

  if (q.q) {
    and.push({
      OR: [
        { name: { contains: q.q, mode: 'insensitive' } },
        { shortDescription: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
        { sku: { contains: q.q, mode: 'insensitive' } },
        { category: { name: { contains: q.q, mode: 'insensitive' } } },
      ],
    })
  }

  if (q.category) {
    // Matching the parent category should include everything beneath it.
    and.push({
      OR: [
        { category: { slug: q.category } },
        { category: { parent: { slug: q.category } } },
      ],
    })
  }

  if (q.minPrice !== undefined) and.push({ price: { gte: q.minPrice } })
  if (q.maxPrice !== undefined) and.push({ price: { lte: q.maxPrice } })

  if (q.inStock === true) {
    and.push({ variants: { some: { status: 'ACTIVE', inventory: { availableStock: { gt: 0 } } } } })
  } else if (q.inStock === false) {
    and.push({ variants: { every: { inventory: { availableStock: { lte: 0 } } } } })
  }

  if (q.minRating !== undefined) and.push({ ratingAverage: { gte: q.minRating } })

  /**
   * Facets. One AND clause per attribute, each requiring a variant carrying any
   * of that attribute's selected values — so "size M or L" and "colour sage"
   * combine the way the filter panel implies.
   */
  if (q.attributes) {
    for (const [attribute, values] of q.attributes) {
      and.push({
        variants: {
          some: {
            status: 'ACTIVE',
            attributes: {
              some: {
                attributeValue: {
                  slug: { in: values },
                  attribute: { slug: attribute },
                },
              },
            },
          },
        },
      })
    }
  }

  return and.length ? { AND: and } : {}
}

/** Storefront listing — ACTIVE only, never drafts or archived products. */
export async function listPublicProducts(q: PublicListQuery) {
  const where = buildWhere(q, { statuses: ['ACTIVE'] })

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: productListSelect,
      orderBy: SORTS[q.sort] ?? SORTS.featured,
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
    }),
  ])

  return { products: rows.map(toProductListItem), total }
}

/**
 * Filter options for a result set (M12).
 *
 * Counts are computed against the *unfaceted* query — the same category and
 * search terms, but without the attribute selections — so ticking one size
 * does not make every other size vanish from the panel. That is the behaviour
 * shoppers expect and the one that makes a filter panel usable.
 */
export async function listFacets(q: PublicListQuery) {
  const { attributes: _selected, ...unfaceted } = q
  const where = buildWhere(unfaceted as PublicListQuery, { statuses: ['ACTIVE'] })

  const [attributes, priceRange, categories] = await Promise.all([
    prisma.attribute.findMany({
      where: { isFilterable: true },
      orderBy: { position: 'asc' },
      include: {
        values: {
          orderBy: { position: 'asc' },
          include: {
            _count: {
              select: {
                variants: {
                  where: { variant: { status: 'ACTIVE', product: where } },
                },
              },
            },
          },
        },
      },
    }),
    prisma.product.aggregate({ where, _min: { price: true }, _max: { price: true } }),
    prisma.category.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        _count: { select: { products: { where: { status: 'ACTIVE' } } } },
      },
    }),
  ])

  return {
    attributes: attributes.map((attribute) => ({
      slug: attribute.slug,
      name: attribute.name,
      isSwatch: attribute.isSwatch,
      values: attribute.values
        .map((value) => ({
          slug: value.slug,
          value: value.value,
          colorHex: value.colorHex,
          count: value._count.variants,
        }))
        // A value nothing matches is noise in the panel.
        .filter((value) => value.count > 0),
    })).filter((attribute) => attribute.values.length > 0),
    price: { min: priceRange._min.price ?? 0, max: priceRange._max.price ?? 0 },
    categories: categories
      .map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }))
      .filter((c) => c.count > 0),
  }
}

export async function getPublicProductBySlug(slug: string) {
  const product = await prisma.product.findUnique({ where: { slug }, include: productDetailInclude })
  if (!product || product.status !== 'ACTIVE') throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')
  return toProductDetail(product)
}

export async function getRelatedProducts(productId: string, categoryId: string | null, take = 4) {
  if (!categoryId) return []
  const rows = await prisma.product.findMany({
    where: { status: 'ACTIVE', categoryId, id: { not: productId } },
    select: productListSelect,
    take,
    orderBy: { publishedAt: 'desc' },
  })
  return rows.map(toProductListItem)
}

/** Admin listing — every status is visible. */
export async function listAdminProducts(q: AdminListQuery) {
  const where = buildWhere(q)

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: productListSelect,
      orderBy: q.sort === 'featured' ? { createdAt: 'desc' } : (SORTS[q.sort] ?? { createdAt: 'desc' }),
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
    }),
  ])

  return { products: rows.map(toProductListItem), total }
}

export async function getAdminProductById(id: string) {
  const product = await prisma.product.findUnique({ where: { id }, include: productDetailInclude })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')
  return toProductDetail(product, { includeInactive: true })
}

/** Turns a name into a URL slug, guaranteed unique. */
export async function uniqueSlug(name: string, excludeId?: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'product'

  let candidate = base
  for (let i = 2; i < 100; i++) {
    const clash = await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!clash || clash.id === excludeId) return candidate
    candidate = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}
