import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'

/**
 * URL redirects (M23).
 *
 * Renaming a product or page strands every link that pointed at the old
 * address. A redirect row keeps those links working and keeps the search
 * ranking that came with them.
 *
 * Paths only — never a full URL. An open redirect (one that will send a visitor
 * to any host a request names) is a phishing primitive, so `toPath` is
 * validated to start with a single slash and nothing else.
 */

const pathRule = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^\/(?!\/)[^\s?#]*(\?[^\s#]*)?$/, 'Enter a path beginning with a single /')

const bodySchema = z
  .object({
    fromPath: pathRule,
    toPath: pathRule,
    statusCode: z.union([z.literal(301), z.literal(302)]).default(301),
    isActive: z.boolean().default(true),
    note: z.string().trim().max(300).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.fromPath === v.toPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toPath'],
        message: 'A redirect cannot point at itself',
      })
    }
  })

type RedirectBody = z.infer<typeof bodySchema>

/**
 * Follows the chain from `toPath` to make sure it does not come back around.
 * A loop would make the page unreachable and, with a 301, the browser would
 * cache that forever.
 */
async function assertNoLoop(fromPath: string, toPath: string, ignoreId?: string) {
  const seen = new Set([fromPath])
  let cursor = toPath

  for (let hops = 0; hops < 10; hops++) {
    if (seen.has(cursor)) {
      throw new ValidationError('That would create a redirect loop')
    }
    seen.add(cursor)

    const next: { id: string; toPath: string } | null = await prisma.redirect.findFirst({
      where: { fromPath: cursor, isActive: true, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
      select: { id: true, toPath: true },
    })
    if (!next) return
    cursor = next.toPath
  }

  throw new ValidationError('That redirect chain is too long')
}

// -------------------------------------------------------------- storefront

/**
 * Public lookup. The storefront's middleware asks about a path it is about to
 * 404 and follows whatever comes back — so this endpoint is deliberately cheap
 * and returns nothing but the destination.
 */
export const redirectRouter: Router = Router()

const lookupQuery = z.object({ path: z.string().trim().min(1).max(500) })

redirectRouter.get('/', validate({ query: lookupQuery }), async (req, res) => {
  const { path } = req.validated!.query as z.infer<typeof lookupQuery>

  const redirect = await prisma.redirect.findFirst({
    where: { fromPath: path, isActive: true },
    select: { id: true, toPath: true, statusCode: true },
  })
  if (!redirect) return ok(res, { redirect: null })

  // Fire-and-forget: a hit counter must never delay the redirect itself.
  void prisma.redirect
    .update({
      where: { id: redirect.id },
      data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
    })
    .catch(() => undefined)

  return ok(res, { redirect: { toPath: redirect.toPath, statusCode: redirect.statusCode } })
})

// ------------------------------------------------------------------- admin

export const adminRedirectRouter: Router = Router()

const listQuery = z.object({
  q: z.string().trim().max(300).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
})

adminRedirectRouter.get(
  '/',
  requirePermission('content.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>

    const where: Prisma.RedirectWhereInput = q.q
      ? {
          OR: [
            { fromPath: { contains: q.q, mode: 'insensitive' } },
            { toPath: { contains: q.q, mode: 'insensitive' } },
          ],
        }
      : {}

    const [total, redirects] = await Promise.all([
      prisma.redirect.count({ where }),
      prisma.redirect.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
    ])

    return ok(res, { redirects }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

adminRedirectRouter.post(
  '/',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: bodySchema }),
  async (req, res) => {
    const body = req.validated!.body as RedirectBody

    const clash = await prisma.redirect.findUnique({ where: { fromPath: body.fromPath } })
    if (clash) throw new ConflictError('A redirect from that path already exists', 'REDIRECT_EXISTS')

    await assertNoLoop(body.fromPath, body.toPath)

    const redirect = await prisma.redirect.create({
      data: { ...body, note: body.note ?? null },
    })

    recordAudit({
      action: 'REDIRECT_CREATED',
      entityType: 'Redirect',
      entityId: redirect.id,
      metadata: { from: body.fromPath, to: body.toPath },
      req,
    })

    return created(res, { redirect })
  },
)

adminRedirectRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  validate({ body: bodySchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as RedirectBody

    const existing = await prisma.redirect.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Redirect', 'REDIRECT_NOT_FOUND')

    if (body.fromPath !== existing.fromPath) {
      const clash = await prisma.redirect.findUnique({ where: { fromPath: body.fromPath } })
      if (clash) throw new ConflictError('A redirect from that path already exists', 'REDIRECT_EXISTS')
    }

    await assertNoLoop(body.fromPath, body.toPath, id)

    const redirect = await prisma.redirect.update({
      where: { id },
      data: { ...body, note: body.note ?? null },
    })

    recordAudit({ action: 'REDIRECT_UPDATED', entityType: 'Redirect', entityId: id, req })

    return ok(res, { redirect })
  },
)

adminRedirectRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('content.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const existing = await prisma.redirect.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Redirect', 'REDIRECT_NOT_FOUND')

    await prisma.redirect.delete({ where: { id } })
    recordAudit({ action: 'REDIRECT_DELETED', entityType: 'Redirect', entityId: id, req })

    return ok(res, { deleted: true })
  },
)
