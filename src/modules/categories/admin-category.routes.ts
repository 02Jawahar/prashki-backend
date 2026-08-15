import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'

const slug = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens')

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slug.optional(),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  image: z.string().trim().max(500).optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  sortOrder: z.coerce.number().int().min(0).default(0),
  parentId: z.string().trim().min(1).nullable().optional(),
})

const updateSchema = createSchema.partial()

async function uniqueSlug(name: string, excludeId?: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'category'

  let candidate = base
  for (let i = 2; i < 100; i++) {
    const clash = await prisma.category.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!clash || clash.id === excludeId) return candidate
    candidate = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

export const adminCategoryRouter: Router = Router()

adminCategoryRouter.get('/', requirePermission('product.read'), async (_req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      parent: { select: { id: true, name: true, slug: true } },
      _count: { select: { products: true, children: true } },
    },
  })

  return ok(res, {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      image: c.image,
      status: c.status,
      sortOrder: c.sortOrder,
      parent: c.parent,
      productCount: c._count.products,
      childCount: c._count.children,
    })),
  })
})

adminCategoryRouter.post(
  '/',
  writeLimiter,
  requirePermission('category.manage'),
  validate({ body: createSchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof createSchema>

    const category = await prisma.category.create({
      data: {
        name: input.name,
        slug: input.slug ?? (await uniqueSlug(input.name)),
        description: input.description || null,
        image: input.image || null,
        status: input.status,
        sortOrder: input.sortOrder,
        parentId: input.parentId ?? null,
      },
    })

    recordAudit({
      action: 'CATEGORY_CREATED',
      entityType: 'Category',
      entityId: category.id,
      metadata: { name: category.name },
      req,
    })
    return created(res, { category })
  },
)

adminCategoryRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('category.manage'),
  validate({ body: updateSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const input = req.validated!.body as z.infer<typeof updateSchema>

    // A category cannot be its own parent, nor descend from itself.
    if (input.parentId) {
      if (input.parentId === id) throw new ConflictError('A category cannot be its own parent', 'INVALID_PARENT')
      let cursor: string | null = input.parentId
      const seen = new Set<string>([id])
      while (cursor) {
        if (seen.has(cursor)) throw new ConflictError('That would create a loop in the category tree', 'CATEGORY_CYCLE')
        seen.add(cursor)
        const parent: { parentId: string | null } | null = await prisma.category.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        })
        cursor = parent?.parentId ?? null
      }
    }

    const category = await prisma.category.update({
      where: { id },
      data: {
        ...input,
        description: input.description === undefined ? undefined : input.description || null,
        image: input.image === undefined ? undefined : input.image || null,
      },
    })

    recordAudit({ action: 'CATEGORY_UPDATED', entityType: 'Category', entityId: id, req })
    return ok(res, { category })
  },
)

adminCategoryRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('category.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const category = await prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true, children: true } } },
    })
    if (!category) throw new NotFoundError('Category', 'CATEGORY_NOT_FOUND')

    if (category._count.products > 0) {
      throw new ConflictError(
        `${category._count.products} product(s) still use this category. Move them first, or disable the category instead.`,
        'CATEGORY_IN_USE',
      )
    }
    if (category._count.children > 0) {
      throw new ConflictError('Remove or re-parent the child categories first', 'CATEGORY_HAS_CHILDREN')
    }

    await prisma.category.delete({ where: { id } })
    recordAudit({ action: 'CATEGORY_DELETED', entityType: 'Category', entityId: id, req })

    return ok(res, { deleted: true })
  },
)
