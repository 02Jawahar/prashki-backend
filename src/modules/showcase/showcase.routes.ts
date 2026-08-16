import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, noContent, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import {
  adminInclude,
  createShowcaseItem,
  deleteShowcaseItem,
  listPublicShowcase,
  reorderShowcase,
  updateShowcaseItem,
} from './showcase.service.js'

/**
 * The public wall (M18 — homepage sections).
 *
 * Anonymous and cacheable. Returns only what the storefront renders: no
 * consent notes, no source URLs, nothing about how the permission was obtained.
 */
export const showcaseRouter: Router = Router()

const publicQuery = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
})

showcaseRouter.get('/', validate({ query: publicQuery }), async (req, res) => {
  const { limit } = req.validated!.query as z.infer<typeof publicQuery>
  const items = await listPublicShowcase(limit)

  // Short shared cache: the wall changes when an admin publishes, which is
  // rare, but a stale-by-a-minute homepage is not worth an origin hit per view.
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')

  return ok(res, { items })
})

// ────────────────────────────────────────────────────────────────── admin

export const adminShowcaseRouter: Router = Router()

const STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ARCHIVED'] as const

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
})

adminShowcaseRouter.get(
  '/',
  requirePermission('content.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>
    const where = q.status ? { status: q.status } : {}

    const [total, items] = await Promise.all([
      prisma.showcaseItem.count({ where }),
      prisma.showcaseItem.findMany({
        where,
        orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: adminInclude,
      }),
    ])

    return ok(res, { items }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

adminShowcaseRouter.get('/:id', requirePermission('content.read'), async (req, res) => {
  const { id } = req.params as { id: string }

  const item = await prisma.showcaseItem.findUnique({ where: { id }, include: adminInclude })
  if (!item) throw new NotFoundError('Showcase item', 'SHOWCASE_ITEM_NOT_FOUND')

  return ok(res, { item })
})

/**
 * A URL that must point at our own storage.
 *
 * The storefront renders these as `<video src>` and `<img src>`, so accepting
 * an arbitrary origin would let anyone with content access hotlink a third
 * party — or embed a tracker on every homepage view. The storage provider
 * returns absolute URLs, so a relative path or the configured public prefix is
 * the whole legitimate set.
 */
const mediaUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => value.startsWith('/') || /^https?:\/\//i.test(value), {
    message: 'Must be a URL or an absolute path',
  })

const itemFields = {
  mediaType: z.enum(['VIDEO', 'IMAGE']),
  mediaUrl,
  posterUrl: mediaUrl.nullable(),
  altText: z.string().trim().min(1, 'Describe what is in the shot').max(300),
  caption: z.string().trim().max(500).nullable(),
  creditName: z.string().trim().max(120).nullable(),
  creditHandle: z
    .string()
    .trim()
    .max(60)
    // Stored without the @ so the storefront can render it consistently.
    .transform((value) => value.replace(/^@+/, ''))
    .nullable(),
  sourceUrl: z.string().trim().url().max(500).nullable(),
  consentGrantedAt: z.string().datetime().nullable(),
  consentNote: z.string().trim().max(500).nullable(),
  status: z.enum(STATUSES),
  scheduledFor: z.string().datetime().nullable(),
  productIds: z.array(z.string().trim().min(1)).max(8),
}

const createSchema = z.object({
  ...itemFields,
  mediaType: itemFields.mediaType.default('VIDEO'),
  posterUrl: itemFields.posterUrl.optional(),
  caption: itemFields.caption.optional(),
  creditName: itemFields.creditName.optional(),
  creditHandle: itemFields.creditHandle.optional(),
  sourceUrl: itemFields.sourceUrl.optional(),
  consentGrantedAt: itemFields.consentGrantedAt.optional(),
  consentNote: itemFields.consentNote.optional(),
  status: itemFields.status.default('DRAFT'),
  scheduledFor: itemFields.scheduledFor.optional(),
  productIds: itemFields.productIds.default([]),
})

const patchSchema = z.object(itemFields).partial()

adminShowcaseRouter.post(
  '/',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: createSchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof createSchema>
    const item = await createShowcaseItem(input)

    recordAudit({
      action: 'SHOWCASE_ITEM_CREATED',
      entityType: 'ShowcaseItem',
      entityId: item.id,
      metadata: { status: item.status, mediaType: item.mediaType },
      req,
    })

    return created(res, { item })
  },
)

/**
 * Reordering sits above `/:id` on purpose — Express matches in declaration
 * order, so a later `/reorder` would be swallowed by the id route.
 */
const reorderSchema = z.object({ ids: z.array(z.string().trim().min(1)).min(1).max(100) })

adminShowcaseRouter.patch(
  '/reorder',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: reorderSchema }),
  async (req, res) => {
    const { ids } = req.validated!.body as z.infer<typeof reorderSchema>
    const count = await reorderShowcase(ids)

    recordAudit({
      action: 'SHOWCASE_REORDERED',
      entityType: 'ShowcaseItem',
      // The whole wall moved, so there is no single row to point at.
      entityId: 'all',
      metadata: { count, order: ids },
      req,
    })

    return ok(res, { reordered: count })
  },
)

adminShowcaseRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: patchSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const input = req.validated!.body as z.infer<typeof patchSchema>

    const item = await updateShowcaseItem(id, input)

    recordAudit({
      action: 'SHOWCASE_ITEM_UPDATED',
      entityType: 'ShowcaseItem',
      entityId: id,
      metadata: { fields: Object.keys(input), status: item.status },
      req,
    })

    return ok(res, { item })
  },
)

adminShowcaseRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }
    await deleteShowcaseItem(id)

    recordAudit({
      action: 'SHOWCASE_ITEM_DELETED',
      entityType: 'ShowcaseItem',
      entityId: id,
      req,
    })

    return noContent(res)
  },
)
