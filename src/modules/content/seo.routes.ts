import { Router } from 'express'
import { prisma } from '../../config/db.js'
import { ok } from '../../utils/response.js'

/**
 * Sitemap data (M23).
 *
 * The API supplies the entries; the storefront renders sitemap.xml and
 * robots.txt, because only it knows its own public base URL. Anything marked
 * `seoNoindex` is left out — telling search engines about a page and then
 * telling them not to index it is a contradiction they resolve badly.
 */
export const seoRouter: Router = Router()

seoRouter.get('/sitemap', async (_req, res) => {
  const [products, categories, pages] = await Promise.all([
    prisma.product.findMany({
      where: { status: 'ACTIVE', seoNoindex: false },
      select: { slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    }),
    prisma.category.findMany({
      where: { status: 'ACTIVE', seoNoindex: false },
      select: { slug: true, updatedAt: true },
    }),
    prisma.page.findMany({
      where: { status: 'PUBLISHED', seoNoindex: false },
      select: { slug: true, updatedAt: true },
    }),
  ])

  return ok(res, {
    products: products.map((p) => ({ path: `/products/${p.slug}`, lastModified: p.updatedAt })),
    categories: categories.map((c) => ({ path: `/categories/${c.slug}`, lastModified: c.updatedAt })),
    pages: pages.map((p) => ({ path: `/${p.slug}`, lastModified: p.updatedAt })),
  })
})
