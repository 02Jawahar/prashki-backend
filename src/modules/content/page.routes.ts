import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'

/**
 * CMS pages (M25).
 *
 * A page is a slug plus an ordered array of blocks — the same block shape the
 * homepage `home.sections` setting already uses, so the storefront renderer
 * works unchanged whether the blocks came from a setting or from a page row.
 *
 * Every save snapshots the previous version first. Publishing a page is a
 * one-click action and un-publishing is one too, so the rollback path is the
 * boring one rather than a database restore.
 */

/** The block types the storefront knows how to render. */
const BLOCK_TYPES = [
  'hero',
  'richText',
  'imageBanner',
  'videoBanner',
  'productGrid',
  'categoryGrid',
  'faq',
  'gallery',
  'newsletter',
  'spacer',
] as const

const blockSchema = z.object({
  type: z.enum(BLOCK_TYPES),
  /** Free-form per block type; the renderer validates what it needs. */
  data: z.record(z.unknown()).default({}),
})

const pageBody = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(140)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case words separated by hyphens'),
  title: z.string().trim().min(2).max(200),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  blocks: z.array(blockSchema).max(60).default([]),
  seoTitle: z.string().trim().max(200).optional().nullable(),
  seoDescription: z.string().trim().max(400).optional().nullable(),
  seoNoindex: z.boolean().default(false),
  ogImage: z.string().trim().max(500).optional().nullable(),
  scheduledFor: z.coerce.date().optional().nullable(),
  /** Note attached to the revision this save creates. */
  revisionNote: z.string().trim().max(200).optional(),
})

type PageBody = z.infer<typeof pageBody>

// -------------------------------------------------------------- storefront

/**
 * Public page reads. Only published pages are visible — a draft slug 404s
 * exactly like a slug that does not exist, so unreleased content cannot be
 * discovered by guessing.
 */
export const pageRouter: Router = Router()

pageRouter.get('/', async (_req, res) => {
  const pages = await prisma.page.findMany({
    where: { status: 'PUBLISHED', seoNoindex: false },
    orderBy: { title: 'asc' },
    select: { slug: true, title: true, publishedAt: true, updatedAt: true },
  })
  return ok(res, { pages })
})

pageRouter.get('/:slug', async (req, res) => {
  const { slug } = req.params as { slug: string }

  const page = await prisma.page.findFirst({
    where: { slug: slug.toLowerCase(), status: 'PUBLISHED' },
    select: {
      slug: true,
      title: true,
      blocks: true,
      seoTitle: true,
      seoDescription: true,
      seoNoindex: true,
      ogImage: true,
      publishedAt: true,
      updatedAt: true,
    },
  })
  if (!page) throw new NotFoundError('Page', 'PAGE_NOT_FOUND')

  return ok(res, { page })
})

// ------------------------------------------------------------------- admin

export const adminPageRouter: Router = Router()

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminPageRouter.get(
  '/',
  requirePermission('content.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>

    const where: Prisma.PageWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { slug: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [total, pages] = await Promise.all([
      prisma.page.count({ where }),
      prisma.page.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          isSystem: true,
          publishedAt: true,
          scheduledFor: true,
          updatedAt: true,
          _count: { select: { revisions: true } },
        },
      }),
    ])

    return ok(res, { pages }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

adminPageRouter.get('/:id', requirePermission('content.read'), async (req, res) => {
  const { id } = req.params as { id: string }

  const page = await prisma.page.findUnique({
    where: { id },
    include: {
      revisions: {
        orderBy: { version: 'desc' },
        take: 20,
        select: { id: true, version: true, title: true, note: true, createdAt: true },
      },
    },
  })
  if (!page) throw new NotFoundError('Page', 'PAGE_NOT_FOUND')

  return ok(res, { page })
})

/** Publishing stamps the date once; re-saving a published page keeps it. */
function publishFields(body: PageBody, existingPublishedAt: Date | null = null) {
  if (body.status === 'PUBLISHED') {
    return { publishedAt: existingPublishedAt ?? new Date(), scheduledFor: null }
  }
  if (body.status === 'SCHEDULED') {
    return { publishedAt: null, scheduledFor: body.scheduledFor ?? null }
  }
  return { publishedAt: existingPublishedAt, scheduledFor: null }
}

adminPageRouter.post(
  '/',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: pageBody }),
  async (req, res) => {
    const body = req.validated!.body as PageBody

    const clash = await prisma.page.findUnique({ where: { slug: body.slug } })
    if (clash) throw new ConflictError('A page with that address already exists', 'SLUG_TAKEN')

    const page = await prisma.page.create({
      data: {
        slug: body.slug,
        title: body.title,
        status: body.status,
        blocks: body.blocks as unknown as Prisma.InputJsonValue,
        seoTitle: body.seoTitle ?? null,
        seoDescription: body.seoDescription ?? null,
        seoNoindex: body.seoNoindex,
        ogImage: body.ogImage ?? null,
        ...publishFields(body),
        revisions: {
          create: {
            version: 1,
            title: body.title,
            blocks: body.blocks as unknown as Prisma.InputJsonValue,
            createdById: req.user!.id,
            note: body.revisionNote ?? 'Created',
          },
        },
      },
    })

    recordAudit({ action: 'PAGE_CREATED', entityType: 'Page', entityId: page.id, req })

    return created(res, { page })
  },
)

adminPageRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: pageBody }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as PageBody

    const existing = await prisma.page.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Page', 'PAGE_NOT_FOUND')

    if (body.slug !== existing.slug) {
      if (existing.isSystem) {
        throw new ConflictError('A built-in page cannot be moved to a new address', 'SYSTEM_PAGE')
      }
      const clash = await prisma.page.findUnique({ where: { slug: body.slug } })
      if (clash) throw new ConflictError('A page with that address already exists', 'SLUG_TAKEN')
    }

    /**
     * The revision snapshots what the page looked like *before* this save, so
     * restoring version N returns the content that was live at version N.
     */
    const page = await prisma.$transaction(async (tx) => {
      const latest = await tx.pageRevision.findFirst({
        where: { pageId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      })

      await tx.pageRevision.create({
        data: {
          pageId: id,
          version: (latest?.version ?? 0) + 1,
          title: existing.title,
          blocks: existing.blocks as Prisma.InputJsonValue,
          createdById: req.user!.id,
          note: body.revisionNote ?? null,
        },
      })

      return tx.page.update({
        where: { id },
        data: {
          slug: body.slug,
          title: body.title,
          status: body.status,
          blocks: body.blocks as unknown as Prisma.InputJsonValue,
          seoTitle: body.seoTitle ?? null,
          seoDescription: body.seoDescription ?? null,
          seoNoindex: body.seoNoindex,
          ogImage: body.ogImage ?? null,
          ...publishFields(body, existing.publishedAt),
        },
      })
    })

    // Renaming a slug strands every inbound link to the old one, so a redirect
    // is created automatically rather than left for someone to remember.
    if (body.slug !== existing.slug) {
      await prisma.redirect
        .upsert({
          where: { fromPath: `/${existing.slug}` },
          create: {
            fromPath: `/${existing.slug}`,
            toPath: `/${body.slug}`,
            note: 'Created automatically when the page was renamed',
          },
          update: { toPath: `/${body.slug}`, isActive: true },
        })
        .catch(() => undefined)
    }

    recordAudit({ action: 'PAGE_UPDATED', entityType: 'Page', entityId: id, req })

    return ok(res, { page })
  },
)

adminPageRouter.post(
  '/:id/restore/:revisionId',
  writeLimiter,
  requirePermission('content.manage'),
  async (req, res) => {
    const { id, revisionId } = req.params as { id: string; revisionId: string }

    const revision = await prisma.pageRevision.findFirst({ where: { id: revisionId, pageId: id } })
    if (!revision) throw new NotFoundError('Revision', 'REVISION_NOT_FOUND')

    const page = await prisma.$transaction(async (tx) => {
      const current = await tx.page.findUniqueOrThrow({ where: { id } })
      const latest = await tx.pageRevision.findFirst({
        where: { pageId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      })

      // Restoring is itself a change, so the state being replaced is snapshotted
      // too — a restore can be undone.
      await tx.pageRevision.create({
        data: {
          pageId: id,
          version: (latest?.version ?? 0) + 1,
          title: current.title,
          blocks: current.blocks as Prisma.InputJsonValue,
          createdById: req.user!.id,
          note: `Replaced by a restore of version ${revision.version}`,
        },
      })

      return tx.page.update({
        where: { id },
        data: { title: revision.title, blocks: revision.blocks as Prisma.InputJsonValue },
      })
    })

    recordAudit({
      action: 'PAGE_RESTORED',
      entityType: 'Page',
      entityId: id,
      metadata: { version: revision.version },
      req,
    })

    return ok(res, { page })
  },
)

adminPageRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const page = await prisma.page.findUnique({ where: { id } })
    if (!page) throw new NotFoundError('Page', 'PAGE_NOT_FOUND')

    // Policy and contact pages are linked from the footer and referenced at
    // checkout; deleting one breaks the storefront, so they archive instead.
    if (page.isSystem) {
      const archived = await prisma.page.update({ where: { id }, data: { status: 'ARCHIVED' } })
      return ok(res, {
        deleted: false,
        page: archived,
        message: 'That is a built-in page, so it was archived rather than deleted.',
      })
    }

    await prisma.page.delete({ where: { id } })
    recordAudit({ action: 'PAGE_DELETED', entityType: 'Page', entityId: id, req })

    return ok(res, { deleted: true })
  },
)
