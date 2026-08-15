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
