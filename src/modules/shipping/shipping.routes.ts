import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { loadCart, serializeCart } from '../cart/cart.serializer.js'
import { resolveCart } from '../cart/cart.service.js'
import { quoteShipping } from './shipping.service.js'

/**
 * Delivery options for the current bag (M21).
 *
 * Open to guests: the checkout page needs to show rates before sign-in. The
 * basket value comes from the customer's own cart, never from the query string,
 * so a free-shipping threshold cannot be talked into applying.
 */
export const shippingRouter: Router = Router()

const quoteQuery = z.object({
  country: z.string().trim().min(2).max(2).default('IN'),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
})

shippingRouter.get('/quote', validate({ query: quoteQuery }), async (req, res) => {
  const q = req.validated!.query as z.infer<typeof quoteQuery>

  const cart = await resolveCart(req, res)
  const serialized = await serializeCart(await loadCart(cart.id), {
    userId: req.user?.id ?? null,
  })

  const quote = await quoteShipping({
    country: q.country,
    state: q.state,
    postalCode: q.postalCode,
    subtotal: serialized.discountedSubtotal,
    freeShippingCoupon: serialized.freeShipping,
  })

  return ok(res, {
    ...quote,
    /** Empty methods with a resolved zone still means "we cannot deliver". */
    deliverable: quote.methods.length > 0,
  })
})

// ------------------------------------------------------------------- admin

export const adminShippingRouter: Router = Router()

const zoneSchema = z.object({
  name: z.string().trim().min(2).max(120),
  countries: z.array(z.string().trim().length(2).toUpperCase()).min(1).max(250),
  regions: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
})

const methodFields = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(300).optional().nullable(),
  rate: z.coerce.number().int().min(0).default(0),
  freeAbove: z.coerce.number().int().min(0).nullable().optional(),
  minSubtotal: z.coerce.number().int().min(0).nullable().optional(),
  maxSubtotal: z.coerce.number().int().min(0).nullable().optional(),
  minDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  maxDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  isCod: z.boolean().default(false),
  codFee: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
})

/** Shared by create and patch, so a partial update cannot invert a range. */
function checkRanges(
  v: Partial<z.infer<typeof methodFields>>,
  ctx: z.RefinementCtx,
) {
  if (v.minDays != null && v.maxDays != null && v.maxDays < v.minDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxDays'],
      message: 'The longest estimate cannot be shorter than the shortest',
    })
  }
  if (v.minSubtotal != null && v.maxSubtotal != null && v.maxSubtotal < v.minSubtotal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSubtotal'],
      message: 'The upper bound cannot be below the lower bound',
    })
  }
}

const methodSchema = methodFields.superRefine(checkRanges)
const methodPatchSchema = methodFields.partial().superRefine(checkRanges)

adminShippingRouter.get('/zones', requirePermission('settings.read'), async (_req, res) => {
  const zones = await prisma.shippingZone.findMany({
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: { methods: { orderBy: [{ position: 'asc' }, { rate: 'asc' }] } },
  })
  return ok(res, { zones })
})

/** Exactly one zone may be the fallback, so setting one clears the rest. */
async function clearOtherDefaults(exceptId?: string) {
  await prisma.shippingZone.updateMany({
    where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { isDefault: false },
  })
}

adminShippingRouter.post(
  '/zones',
  writeLimiter,
  requirePermission('shipping.manage'),
  validate({ body: zoneSchema }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof zoneSchema>

    const zone = await prisma.shippingZone.create({ data: body, include: { methods: true } })
    if (body.isDefault) await clearOtherDefaults(zone.id)

    recordAudit({ action: 'SHIPPING_ZONE_CREATED', entityType: 'ShippingZone', entityId: zone.id, req })
    return created(res, { zone })
  },
)

adminShippingRouter.patch(
  '/zones/:id',
  writeLimiter,
  requirePermission('shipping.manage'),
  validate({ body: zoneSchema.partial() }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as Partial<z.infer<typeof zoneSchema>>

    const existing = await prisma.shippingZone.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Shipping zone', 'ZONE_NOT_FOUND')

    const zone = await prisma.shippingZone.update({
      where: { id },
      data: body,
      include: { methods: true },
    })
    if (body.isDefault) await clearOtherDefaults(id)

    recordAudit({ action: 'SHIPPING_ZONE_UPDATED', entityType: 'ShippingZone', entityId: id, req })
    return ok(res, { zone })
  },
)

adminShippingRouter.delete(
  '/zones/:id',
  writeLimiter,
  requirePermission('shipping.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const zone = await prisma.shippingZone.findUnique({
      where: { id },
      include: { methods: { include: { _count: { select: { orders: true } } } } },
    })
    if (!zone) throw new NotFoundError('Shipping zone', 'ZONE_NOT_FOUND')

    // Deleting a method an order references would erase how that order was
    // delivered. Deactivate instead — the name is snapshotted on the order, but
    // the row is still what the admin screen joins against.
    const used = zone.methods.some((m) => m._count.orders > 0)
    if (used) {
      const updated = await prisma.shippingZone.update({
        where: { id },
        data: { isActive: false, methods: { updateMany: { where: {}, data: { isActive: false } } } },
        include: { methods: true },
      })
      return ok(res, {
        deleted: false,
        zone: updated,
        message: 'That zone has been used by orders, so it was deactivated rather than deleted.',
      })
    }

    await prisma.shippingZone.delete({ where: { id } })
    recordAudit({ action: 'SHIPPING_ZONE_DELETED', entityType: 'ShippingZone', entityId: id, req })
    return ok(res, { deleted: true })
  },
)

adminShippingRouter.post(
  '/zones/:zoneId/methods',
  writeLimiter,
  requirePermission('shipping.manage'),
  validate({ body: methodSchema }),
  async (req, res) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = req.validated!.body as z.infer<typeof methodSchema>

    const zone = await prisma.shippingZone.findUnique({ where: { id: zoneId } })
    if (!zone) throw new NotFoundError('Shipping zone', 'ZONE_NOT_FOUND')

    const method = await prisma.shippingMethod.create({
      data: {
        zoneId,
        ...body,
        description: body.description ?? null,
        freeAbove: body.freeAbove ?? null,
        minSubtotal: body.minSubtotal ?? null,
        maxSubtotal: body.maxSubtotal ?? null,
        minDays: body.minDays ?? null,
        maxDays: body.maxDays ?? null,
      },
    })

    recordAudit({
      action: 'SHIPPING_METHOD_CREATED',
      entityType: 'ShippingMethod',
      entityId: method.id,
      req,
    })
    return created(res, { method })
  },
)

adminShippingRouter.patch(
  '/methods/:id',
  writeLimiter,
  requirePermission('shipping.manage'),
  validate({ body: methodPatchSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as Partial<z.infer<typeof methodSchema>>

    const existing = await prisma.shippingMethod.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Shipping method', 'SHIPPING_METHOD_NOT_FOUND')

    const method = await prisma.shippingMethod.update({ where: { id }, data: body })

    recordAudit({
      action: 'SHIPPING_METHOD_UPDATED',
      entityType: 'ShippingMethod',
      entityId: id,
      req,
    })
    return ok(res, { method })
  },
)

adminShippingRouter.delete(
  '/methods/:id',
  writeLimiter,
  requirePermission('shipping.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const method = await prisma.shippingMethod.findUnique({
      where: { id },
      include: { _count: { select: { orders: true } } },
    })
    if (!method) throw new NotFoundError('Shipping method', 'SHIPPING_METHOD_NOT_FOUND')

    if (method._count.orders > 0) {
      const updated = await prisma.shippingMethod.update({
        where: { id },
        data: { isActive: false },
      })
      return ok(res, {
        deleted: false,
        method: updated,
        message: 'That method has been used by orders, so it was deactivated rather than deleted.',
      })
    }

    await prisma.shippingMethod.delete({ where: { id } })
    recordAudit({
      action: 'SHIPPING_METHOD_DELETED',
      entityType: 'ShippingMethod',
      entityId: id,
      req,
    })
    return ok(res, { deleted: true })
  },
)
