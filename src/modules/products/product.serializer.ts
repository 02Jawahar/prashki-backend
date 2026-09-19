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
  /**
   * Only what a card needs: is this a set, and what is the cheapest way in.
   * A set shown at its full price alone reads as an expensive single garment,
   * when the blouse in it might be a third of that.
   */
  components: {
    select: { component: { select: { price: true, status: true } } },
  },
  setOptions: { select: { price: true } },
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
    /**
     * Cheapest piece for a set, so a card can read "from ₹5,000" rather than
     * only the full-set price. Null for a single garment.
     */
    fromPrice:
      p.setOptions.length > 0
        ? Math.min(...p.setOptions.map((o) => o.price))
        : p.components.length > 0
          ? Math.min(
              ...p.components
                .filter((c) => c.component.status === 'ACTIVE')
                .map((c) => c.component.price),
              p.price,
            )
          : null,
    isSet: p.components.length > 0 || p.setOptions.length > 0,
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
  /** What may be bought of this product — the whole thing, or part of it. */
  setOptions: { orderBy: { position: 'asc' as const } },
  /**
   * The pieces a set is made of, each with its own sizes — the page needs a
   * size picker per piece, not one for the whole set.
   */
  components: {
    orderBy: { position: 'asc' },
    select: {
      position: true,
      component: {
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          status: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
          variants: {
            where: { status: 'ACTIVE' as const },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              name: true,
              sku: true,
              inventory: { select: { availableStock: true } },
            },
          },
        },
      },
    },
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
      /// Grams, or null for a garment nobody has weighed. Not defaulted here:
      /// admin needs to see which pieces are still unweighed, and a number
      /// standing in for "unknown" hides exactly that.
      weightGrams: v.weightGrams,
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

    /**
     * What can be bought of this product, when it is sold in parts. Null for
     * an ordinary garment. One size governs whichever part is chosen.
     */
    setOptions:
      p.setOptions.length === 0
        ? null
        : p.setOptions.map((o) => ({
            id: o.id,
            label: o.label,
            price: o.price,
            weightGrams: o.weightGrams,
            position: o.position,
          })),

    /**
     * Null for a single garment. When present, the page asks for a size per
     * piece and the customer pays the set's price, not the sum below — the
     * pieces carry their own prices only so the saving can be shown.
     */
    set:
      p.components.length === 0
        ? null
        : {
            pieces: p.components.map(({ component }) => ({
              productId: component.id,
              name: component.name,
              slug: component.slug,
              price: component.price,
              image: component.images[0]?.url ?? null,
              available: component.status === 'ACTIVE',
              sizes: component.variants.map((v) => ({
                id: v.id,
                name: v.name,
                sku: v.sku,
                stock: v.inventory?.availableStock ?? 0,
                inStock: (v.inventory?.availableStock ?? 0) > 0,
              })),
            })),
            /** What the pieces come to separately, for showing what is saved. */
            piecesTotal: p.components.reduce((sum, c) => sum + c.component.price, 0),
          },
    inStock: variants.some((v) => v.inStock),
    totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    publishedAt: p.publishedAt,
    /// Set with status=SCHEDULED; a job flips it to ACTIVE when this passes.
    scheduledFor: p.scheduledFor,
  }
}
