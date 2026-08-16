import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { maskContact } from '../../utils/pii.js'
import {
  hasPurchased,
  publicReviewSelect,
  ratingBreakdown,
  recomputeRating,
} from './review.service.js'

/**
 * Reviews (M17).
 *
 * New reviews land in PENDING and are invisible until moderated — an
 * unmoderated review box on a fashion storefront becomes a spam board within a
 * week. The author can always see their own, so submitting does not feel like
 * shouting into a void.
 */
export const reviewRouter: Router = Router()

const listQuery = z.object({
  sort: z.enum(['newest', 'highest', 'lowest', 'helpful']).default('newest'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(10),
})

const ORDER_BY: Record<string, Prisma.ReviewOrderByWithRelationInput> = {
  newest: { createdAt: 'desc' },
  highest: { rating: 'desc' },
  lowest: { rating: 'asc' },
  helpful: { helpfulCount: 'desc' },
}

/** Public reviews for a product. Only APPROVED rows are ever returned here. */
reviewRouter.get('/product/:productId', validate({ query: listQuery }), async (req, res) => {
  const { productId } = req.params as { productId: string }
  const q = req.validated!.query as z.infer<typeof listQuery>

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, ratingAverage: true, ratingCount: true },
  })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  const where: Prisma.ReviewWhereInput = {
    productId,
    status: 'APPROVED',
    ...(q.rating ? { rating: q.rating } : {}),
  }

  const [total, reviews, breakdown] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: ORDER_BY[q.sort],
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
      select: publicReviewSelect,
    }),
    ratingBreakdown(productId),
  ])

  return ok(
    res,
    {
      reviews,
      summary: {
        average: product.ratingAverage,
        count: product.ratingCount,
        breakdown,
      },
    },
    { pagination: pageMeta(q.page, q.perPage, total) },
  )
})

const bodySchema = z.object({
  productId: z.string().trim().min(1),
  rating: z.coerce.number().int().min(1, 'Give it at least one star').max(5),
  title: z.string().trim().max(140).optional(),
  body: z.string().trim().max(4000).optional(),
  images: z.array(z.string().trim().max(500)).max(4).default([]),
})

/**
 * Submit or replace a review. One per customer per product: editing replaces
 * the previous text and sends it back through moderation, which is what stops
 * an approved review being quietly rewritten into something else.
 */
reviewRouter.post(
  '/',
  writeLimiter,
  requireAuth,
  validate({ body: bodySchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof bodySchema>
    const userId = req.user!.id

    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, status: true },
    })
    if (!product || product.status === 'ARCHIVED') {
      throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')
    }

    // Derived, never taken from the request body.
    const isVerifiedPurchase = await hasPurchased(userId, input.productId)

    const review = await prisma.review.upsert({
      where: { productId_userId: { productId: input.productId, userId } },
      create: {
        productId: input.productId,
        userId,
        rating: input.rating,
        title: input.title ?? null,
        body: input.body ?? null,
        images: input.images,
        isVerifiedPurchase,
        status: 'PENDING',
      },
      update: {
        rating: input.rating,
        title: input.title ?? null,
        body: input.body ?? null,
        images: input.images,
        isVerifiedPurchase,
        // Back to the queue: edited content has not been read by anyone yet.
        status: 'PENDING',
        adminResponse: null,
        adminRespondedAt: null,
        moderatedById: null,
        moderatedAt: null,
        rejectionReason: null,
      },
    })

    // An edit to an already-approved review removes it from the average until
    // it is approved again.
    await recomputeRating(input.productId)

    return created(res, {
      review,
      message: 'Thank you — your review will appear once it has been read.',
    })
  },
)

/** The author's own review, whatever its status, so the form can prefill. */
reviewRouter.get('/mine/:productId', requireAuth, async (req, res) => {
  const { productId } = req.params as { productId: string }

  const review = await prisma.review.findUnique({
    where: { productId_userId: { productId, userId: req.user!.id } },
  })

  return ok(res, { review })
})

reviewRouter.delete('/:id', writeLimiter, requireAuth, async (req, res) => {
  const { id } = req.params as { id: string }

  const review = await prisma.review.findFirst({
    where: { id, userId: req.user!.id },
    select: { id: true, productId: true },
  })
  if (!review) throw new NotFoundError('Review', 'REVIEW_NOT_FOUND')

  await prisma.review.delete({ where: { id } })
  await recomputeRating(review.productId)

  return ok(res, { deleted: true })
})

/**
 * "This was helpful". Anonymous and uncapped by design — it orders reviews, it
 * does not gate anything, so the cost of a wrong count is cosmetic.
 */
reviewRouter.post('/:id/helpful', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }

  const review = await prisma.review.findFirst({
    where: { id, status: 'APPROVED' },
    select: { id: true },
  })
  if (!review) throw new NotFoundError('Review', 'REVIEW_NOT_FOUND')

  const updated = await prisma.review.update({
    where: { id },
    data: { helpfulCount: { increment: 1 } },
    select: { id: true, helpfulCount: true },
  })

  return ok(res, { review: updated })
})

// ------------------------------------------------------------------- admin

export const adminReviewRouter: Router = Router()

const adminListQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'FLAGGED']).optional(),
  productId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminReviewRouter.get(
  '/',
  requirePermission('review.moderate'),
  validate({ query: adminListQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof adminListQuery>

    const where: Prisma.ReviewWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
    }

    const [total, reviews, pending] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        // Oldest first: the moderation queue is a queue.
        orderBy: { createdAt: 'asc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: {
          user: { select: { id: true, name: true, email: true } },
          product: { select: { id: true, name: true, slug: true } },
        },
      }),
      prisma.review.count({ where: { status: 'PENDING' } }),
    ])

    return ok(
      res,
      {
        reviews: reviews.map((r) => ({
          ...r,
          user: maskContact(r.user, req.user?.permissions),
        })),
        pendingCount: pending,
      },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

const moderateSchema = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'FLAGGED']),
    rejectionReason: z.string().trim().max(500).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'REJECTED' && !v.rejectionReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionReason'],
        message: 'Record why the review was rejected',
      })
    }
  })

adminReviewRouter.patch(
  '/:id/status',
  writeLimiter,
  requirePermission('review.moderate'),
  validate({ body: moderateSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof moderateSchema>

    const existing = await prisma.review.findUnique({ where: { id }, select: { productId: true } })
    if (!existing) throw new NotFoundError('Review', 'REVIEW_NOT_FOUND')

    const review = await prisma.$transaction(async (tx) => {
      const updated = await tx.review.update({
        where: { id },
        data: {
          status: body.status,
          rejectionReason: body.rejectionReason ?? null,
          moderatedById: req.user!.id,
          moderatedAt: new Date(),
        },
      })
      // Recomputed inside the transaction so the rating and the status can
      // never disagree.
      await recomputeRating(existing.productId, tx)
      return updated
    })

    recordAudit({
      action: 'REVIEW_MODERATED',
      entityType: 'Review',
      entityId: id,
      metadata: { status: body.status },
      req,
    })

    return ok(res, { review })
  },
)

const responseSchema = z.object({ adminResponse: z.string().trim().min(1).max(2000) })

adminReviewRouter.patch(
  '/:id/response',
  writeLimiter,
  requirePermission('review.moderate'),
  validate({ body: responseSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { adminResponse } = req.validated!.body as z.infer<typeof responseSchema>

    const existing = await prisma.review.findUnique({ where: { id }, select: { id: true } })
    if (!existing) throw new NotFoundError('Review', 'REVIEW_NOT_FOUND')

    const review = await prisma.review.update({
      where: { id },
      data: { adminResponse, adminRespondedAt: new Date() },
    })

    return ok(res, { review })
  },
)

adminReviewRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('review.moderate'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const review = await prisma.review.findUnique({ where: { id }, select: { productId: true } })
    if (!review) throw new NotFoundError('Review', 'REVIEW_NOT_FOUND')

    await prisma.review.delete({ where: { id } })
    await recomputeRating(review.productId)

    recordAudit({ action: 'REVIEW_DELETED', entityType: 'Review', entityId: id, req })

    return ok(res, { deleted: true })
  },
)
