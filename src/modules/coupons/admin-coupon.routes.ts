import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { normalizeCode } from './coupon.service.js'

/**
 * Coupon administration (M13).
 *
 * Everything a coupon is worth lives in these rows — no discount is ever
 * accepted from a request body at checkout — so this is where the money rules
 * are actually written.
 */
export const adminCouponRouter: Router = Router()

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

const bodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3, 'A code needs at least 3 characters')
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only'),
    description: z.string().trim().max(300).optional().nullable(),
    type: z.enum(['PERCENTAGE', 'FIXED', 'FREE_SHIPPING']),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED']).default('DRAFT'),
    /** Basis points for PERCENTAGE (1000 = 10%), paise for FIXED. */
    value: z.coerce.number().int().min(0),
    maxDiscount: z.coerce.number().int().min(0).nullable().optional(),
    minSubtotal: z.coerce.number().int().min(0).default(0),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    usageLimit: z.coerce.number().int().min(1).nullable().optional(),
    perUserLimit: z.coerce.number().int().min(1).nullable().optional(),
    firstOrderOnly: z.boolean().default(false),
    excludeDiscounted: z.boolean().default(false),
    isPublic: z.boolean().default(true),
    productIds: z.array(z.string().trim().min(1)).max(500).default([]),
    categoryIds: z.array(z.string().trim().min(1)).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    // 10000 basis points is 100% — anything more would pay the customer.
    if (v.type === 'PERCENTAGE' && (v.value < 1 || v.value > 10_000)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'A percentage must be between 0.01% and 100% (1–10000 basis points)',
      })
    }
    if (v.type === 'FIXED' && v.value < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'A fixed discount must be more than zero',
      })
    }
    if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'The end date must be after the start date',
      })
    }
  })

type CouponBody = z.infer<typeof bodySchema>

const couponInclude = {
  products: { select: { product: { select: { id: true, name: true, slug: true } } } },
  categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
  _count: { select: { redemptions: true } },
} satisfies Prisma.CouponInclude

function serialize(coupon: Prisma.CouponGetPayload<{ include: typeof couponInclude }>) {
  return {
    ...coupon,
    products: coupon.products.map((p) => p.product),
    categories: coupon.categories.map((c) => c.category),
    redemptionCount: coupon._count.redemptions,
    /** Convenience for the admin UI; the engine never reads this. */
    percentLabel: coupon.type === 'PERCENTAGE' ? `${coupon.value / 100}%` : null,
  }
}

adminCouponRouter.get(
  '/',
  requirePermission('coupon.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>

    const where: Prisma.CouponWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { code: { contains: q.q, mode: 'insensitive' } },
              { description: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [total, coupons] = await Promise.all([
      prisma.coupon.count({ where }),
      prisma.coupon.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: couponInclude,
      }),
    ])

    return ok(
      res,
      { coupons: coupons.map(serialize) },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

adminCouponRouter.get('/:id', requirePermission('coupon.read'), async (req, res) => {
  const { id } = req.params as { id: string }
  const coupon = await prisma.coupon.findUnique({ where: { id }, include: couponInclude })
  if (!coupon) throw new NotFoundError('Coupon', 'COUPON_NOT_FOUND')
  return ok(res, { coupon: serialize(coupon) })
})

/** Rejects ids that do not exist, rather than silently dropping the scope. */
async function assertScopeExists(body: Pick<CouponBody, 'productIds' | 'categoryIds'>) {
  if (body.productIds.length > 0) {
    const found = await prisma.product.count({ where: { id: { in: body.productIds } } })
    if (found !== body.productIds.length) {
      throw new ValidationError('One or more of those products no longer exists')
    }
  }
  if (body.categoryIds.length > 0) {
    const found = await prisma.category.count({ where: { id: { in: body.categoryIds } } })
    if (found !== body.categoryIds.length) {
      throw new ValidationError('One or more of those categories no longer exists')
    }
  }
}

adminCouponRouter.post(
  '/',
  writeLimiter,
  requirePermission('coupon.manage'),
  validate({ body: bodySchema }),
  async (req, res) => {
    const body = req.validated!.body as CouponBody
    await assertScopeExists(body)

    const code = normalizeCode(body.code)
    const existing = await prisma.coupon.findUnique({ where: { code } })
    if (existing) throw new ConflictError('A coupon with that code already exists', 'CODE_TAKEN')

    const coupon = await prisma.coupon.create({
      data: {
        code,
        description: body.description ?? null,
        type: body.type,
        status: body.status,
        value: body.type === 'FREE_SHIPPING' ? 0 : body.value,
        maxDiscount: body.maxDiscount ?? null,
        minSubtotal: body.minSubtotal,
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
        usageLimit: body.usageLimit ?? null,
        perUserLimit: body.perUserLimit ?? null,
        firstOrderOnly: body.firstOrderOnly,
        excludeDiscounted: body.excludeDiscounted,
        isPublic: body.isPublic,
        products: { create: body.productIds.map((productId) => ({ productId })) },
        categories: { create: body.categoryIds.map((categoryId) => ({ categoryId })) },
      },
      include: couponInclude,
    })

    recordAudit({
      action: 'COUPON_CREATED',
      entityType: 'Coupon',
      entityId: coupon.id,
      metadata: { code, type: body.type, value: body.value },
      req,
    })

    return created(res, { coupon: serialize(coupon) })
  },
)

adminCouponRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('coupon.manage'),
  validate({ body: bodySchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as CouponBody
    await assertScopeExists(body)

    const existing = await prisma.coupon.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Coupon', 'COUPON_NOT_FOUND')

    const code = normalizeCode(body.code)
    if (code !== existing.code) {
      const clash = await prisma.coupon.findUnique({ where: { code } })
      if (clash) throw new ConflictError('A coupon with that code already exists', 'CODE_TAKEN')
    }

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        code,
        description: body.description ?? null,
        type: body.type,
        status: body.status,
        value: body.type === 'FREE_SHIPPING' ? 0 : body.value,
        maxDiscount: body.maxDiscount ?? null,
        minSubtotal: body.minSubtotal,
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
        usageLimit: body.usageLimit ?? null,
        perUserLimit: body.perUserLimit ?? null,
        firstOrderOnly: body.firstOrderOnly,
        excludeDiscounted: body.excludeDiscounted,
        isPublic: body.isPublic,
        // The scope is replaced wholesale — the form always sends the full set.
        products: {
          deleteMany: {},
          create: body.productIds.map((productId) => ({ productId })),
        },
        categories: {
          deleteMany: {},
          create: body.categoryIds.map((categoryId) => ({ categoryId })),
        },
      },
      include: couponInclude,
    })

    recordAudit({ action: 'COUPON_UPDATED', entityType: 'Coupon', entityId: id, req })

    return ok(res, { coupon: serialize(coupon) })
  },
)

/**
 * A coupon that has been redeemed is never deleted — orders reference it, and
 * the redemption history is part of the financial record. It is expired instead.
 */
adminCouponRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('coupon.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const coupon = await prisma.coupon.findUnique({
      where: { id },
      include: { _count: { select: { redemptions: true } } },
    })
    if (!coupon) throw new NotFoundError('Coupon', 'COUPON_NOT_FOUND')

    if (coupon._count.redemptions > 0) {
      const expired = await prisma.coupon.update({
        where: { id },
        data: { status: 'EXPIRED' },
        include: couponInclude,
      })
      recordAudit({ action: 'COUPON_EXPIRED', entityType: 'Coupon', entityId: id, req })
      return ok(res, {
        deleted: false,
        expired: true,
        coupon: serialize(expired),
        message: 'That coupon has been used, so it was expired rather than deleted.',
      })
    }

    await prisma.coupon.delete({ where: { id } })
    recordAudit({ action: 'COUPON_DELETED', entityType: 'Coupon', entityId: id, req })

    return ok(res, { deleted: true, expired: false })
  },
)
