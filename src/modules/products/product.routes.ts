import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { ok, pageMeta } from '../../utils/response.js'
import { prisma } from '../../config/db.js'
import {
  getPublicProductBySlug,
  getRelatedProducts,
  listPublicProducts,
} from './product.service.js'
import { publicListQuery, slugParam } from './product.schemas.js'
import type { PublicListQuery } from './product.schemas.js'

/** Public catalogue. No authentication — browsing is open (spec §21). */
export const productRouter: Router = Router()

productRouter.get('/', validate({ query: publicListQuery }), async (req, res) => {
  const q = req.validated!.query as PublicListQuery
  const { products, total } = await listPublicProducts(q)
  return ok(res, { products }, { pagination: pageMeta(q.page, q.perPage, total) })
})

productRouter.get('/:slug', validate({ params: slugParam }), async (req, res) => {
  const { slug } = req.params as { slug: string }
  const product = await getPublicProductBySlug(slug)
  const related = await getRelatedProducts(product.id, product.category?.id ?? null)

  return ok(res, { product, related })
})

/** Public category listing, used by the header and the category pages. */
export const categoryRouter: Router = Router()

categoryRouter.get('/', async (_req, res) => {
  const categories = await prisma.category.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      children: {
        where: { status: 'ACTIVE' },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, slug: true, image: true },
      },
      _count: { select: { products: { where: { status: 'ACTIVE' } } } },
    },
  })

  return ok(res, {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      image: c.image,
      parentId: c.parentId,
      productCount: c._count.products,
      children: c.children,
    })),
  })
})

categoryRouter.get('/:slug', validate({ params: slugParam }), async (req, res) => {
  const { slug } = req.params as { slug: string }
  const category = await prisma.category.findUnique({
    where: { slug },
    include: {
      children: { where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } },
      parent: { select: { id: true, name: true, slug: true } },
    },
  })

  if (!category || category.status !== 'ACTIVE') {
    return res.status(404).json({
      success: false,
      error: { code: 'CATEGORY_NOT_FOUND', message: 'Category not found' },
    })
  }

  return ok(res, { category })
})
