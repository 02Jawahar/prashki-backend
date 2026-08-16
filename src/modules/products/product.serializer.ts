import type { Prisma } from '@prisma/client'
import { discountPercent } from '../../utils/money.js'

/**
 * Product payloads.
 *
 * Discount is computed here from price and compareAtPrice, never stored
 * (spec §10) — so it can't drift out of step with the prices it describes.
 * Stock is read from the inventory ledger, not from a field on the variant.
 */

export const productListSelect = {
  id: true,
  name: true,
  slug: true,
  shortDescription: true,
  sku: true,
  price: true,
  compareAtPrice: true,
  status: true,
  featured: true,
  ratingAverage: true,
  ratingCount: true,
  createdAt: true,
  publishedAt: true,
  category: { select: { id: true, name: true, slug: true } },
  images: { select: { url: true, altText: true }, orderBy: { sortOrder: 'asc' }, take: 2 },
  variants: {
    where: { status: 'ACTIVE' as const },
    select: { id: true, inventory: { select: { availableStock: true } } },
  },
} satisfies Prisma.ProductSelect

type ProductListRow = Prisma.ProductGetPayload<{ select: typeof productListSelect }>

export function toProductListItem(p: ProductListRow) {
  const totalStock = p.variants.reduce((sum, v) => sum + (v.inventory?.availableStock ?? 0), 0)

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    shortDescription: p.shortDescription,
    sku: p.sku,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    discountPercent: discountPercent(p.price, p.compareAtPrice),
    status: p.status,
    featured: p.featured,
    ratingAverage: p.ratingAverage,
    ratingCount: p.ratingCount,
    category: p.category,
    image: p.images[0]?.url ?? null,
    hoverImage: p.images[1]?.url ?? p.images[0]?.url ?? null,
    inStock: totalStock > 0,
    totalStock,
    createdAt: p.createdAt,
    publishedAt: p.publishedAt,
  }
}

export const productDetailInclude = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  variants: {
    orderBy: { position: 'asc' },
    include: { inventory: true },
  },
} satisfies Prisma.ProductInclude

type ProductDetailRow = Prisma.ProductGetPayload<{ include: typeof productDetailInclude }>

export function toProductDetail(p: ProductDetailRow, { includeInactive = false } = {}) {
  const variants = p.variants
    .filter((v) => includeInactive || v.status === 'ACTIVE')
    .map((v) => ({
      id: v.id,
      name: v.name,
      sku: v.sku,
      /// null price means "inherit the product price"
      price: v.price ?? p.price,
      status: v.status,
      position: v.position,
      stock: v.inventory?.availableStock ?? 0,
      lowStockThreshold: v.inventory?.lowStockThreshold ?? 0,
      inStock: (v.inventory?.availableStock ?? 0) > 0,
    }))

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    shortDescription: p.shortDescription,
    sku: p.sku,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    discountPercent: discountPercent(p.price, p.compareAtPrice),
    status: p.status,
    featured: p.featured,
    /// Fabric and care copy the product page needs (FR-03.1).
    material: p.material,
    careInstructions: p.careInstructions,
    /// Recomputed from approved reviews; display only.
    ratingAverage: p.ratingAverage,
    ratingCount: p.ratingCount,
    /// Fall back to the product's own copy when no override is set.
    seo: {
      title: p.seoTitle ?? p.name,
      description: p.seoDescription ?? p.shortDescription,
      noindex: p.seoNoindex,
    },
    category: p.category,
    images: p.images.map((i) => ({
      id: i.id,
      url: i.url,
      altText: i.altText,
      sortOrder: i.sortOrder,
    })),
    variants,
    inStock: variants.some((v) => v.inStock),
    totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    publishedAt: p.publishedAt,
  }
}
