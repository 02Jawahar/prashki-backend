import { z } from 'zod'

/** Storefront listing — only ACTIVE products are ever returned here. */
export const publicListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  inStock: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: z
    .enum(['newest', 'oldest', 'price-asc', 'price-desc', 'name-asc', 'name-desc', 'featured'])
    .default('featured'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(48).default(12),
})

/** Admin listing — can see every status. */
export const adminListQuery = publicListQuery.extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

const slug = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens')

const sku = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'SKU may contain letters, numbers, dot, underscore and hyphen')

/** Money arrives as paise and must be a whole number (spec §10). */
const paise = z.coerce.number().int('Price must be a whole number of paise').min(0)

export const createProductSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: slug.optional(),
    description: z.string().trim().min(1).max(20_000),
    shortDescription: z.string().trim().max(300).optional().or(z.literal('')),
    sku,
    price: paise,
    compareAtPrice: paise.optional().nullable(),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('DRAFT'),
    featured: z.boolean().default(false),
    categoryId: z.string().trim().min(1).nullable().optional(),
    variants: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(80),
          sku,
          price: paise.nullable().optional(),
          stock: z.coerce.number().int().min(0).default(0),
        }),
      )
      .min(1, 'A product needs at least one variant')
      .max(50)
      .optional(),
  })
  .refine((d) => d.compareAtPrice == null || d.compareAtPrice > d.price, {
    message: 'Compare-at price must be higher than the price',
    path: ['compareAtPrice'],
  })

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    slug: slug.optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    shortDescription: z.string().trim().max(300).nullable().optional(),
    sku: sku.optional(),
    price: paise.optional(),
    compareAtPrice: paise.nullable().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    featured: z.boolean().optional(),
    categoryId: z.string().trim().min(1).nullable().optional(),
  })
  .refine(
    (d) => d.compareAtPrice == null || d.price == null || d.compareAtPrice > d.price,
    { message: 'Compare-at price must be higher than the price', path: ['compareAtPrice'] },
  )

export const publishSchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
})

export const createVariantSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sku,
  price: paise.nullable().optional(),
  stock: z.coerce.number().int().min(0).default(0),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
})

export const updateVariantSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sku: sku.optional(),
  price: paise.nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
})

export const reorderImagesSchema = z.object({
  imageIds: z.array(z.string().min(1)).min(1),
})

export const slugParam = z.object({ slug: z.string().trim().min(1) })
export const idParam = z.object({ id: z.string().trim().min(1) })

export type PublicListQuery = z.infer<typeof publicListQuery>
export type AdminListQuery = z.infer<typeof adminListQuery>
export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
