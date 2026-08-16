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
import {
  getShippingProvider,
  type ServiceabilityResult,
} from '../../integrations/shipping/index.js'
import { cartWeightGrams, quoteShipping, resolveZone } from './shipping.service.js'

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
    weightGrams: await cartWeightGrams(cart.id),
    freeShippingCoupon: serialized.freeShipping,
  })

  return ok(res, {
    ...quote,
    /** Kept for existing clients; `serviceable` is the field to read. */
    deliverable: quote.serviceable,
  })
})

const serviceabilityQuery = z.object({
  postalCode: z.string().trim().min(3).max(20),
  country: z.string().trim().length(2).default('IN'),
})

/**
 * "Do you deliver to my PIN?" (FR-21.1).
 *
 * Public and cart-independent, so the product page can answer before anything
 * is in the bag. It reports the zone's own rules; the carrier adapter is asked
 * too, when it has an opinion.
 */
shippingRouter.get(
  '/serviceability',
  validate({ query: serviceabilityQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof serviceabilityQuery>

    const zone = await resolveZone({ country: q.country, postalCode: q.postalCode })

    if (!zone || !zone.isServiceable) {
      return ok(res, {
        serviceable: false,
        codAvailable: false,
        zone: zone ? { id: zone.id, name: zone.name } : null,
        reason:
          zone?.unserviceableMessage ??
          'We are not able to deliver to that PIN code at the moment.',
        estimate: null,
      })
    }

    const provider = getShippingProvider()
    const carrier: ServiceabilityResult = await provider
      .checkServiceability(q.postalCode, { country: q.country })
      // A carrier lookup that fails must not make a serviceable PIN look dead —
      // the zone configuration is the fallback answer, not an error.
      .catch(() => ({ serviceable: true, codAvailable: true }))

    if (!carrier.serviceable) {
      return ok(res, {
        serviceable: false,
        codAvailable: false,
        zone: { id: zone.id, name: zone.name },
        reason: carrier.reason ?? 'Our courier does not currently reach that PIN code.',
        estimate: null,
      })
    }

    const days = zone.methods
      .map((m) => ({ min: m.minDays, max: m.maxDays }))
      .filter((d): d is { min: number; max: number } => d.min !== null && d.max !== null)

    return ok(res, {
      serviceable: zone.methods.length > 0,
      codAvailable: carrier.codAvailable && zone.methods.some((m) => m.isCod),
      zone: { id: zone.id, name: zone.name },
      reason: zone.methods.length > 0 ? null : 'No delivery option covers that PIN code yet.',
      estimate:
        days.length > 0
          ? { minDays: Math.min(...days.map((d) => d.min)), maxDays: Math.max(...days.map((d) => d.max)) }
          : null,
    })
  },
)

// ------------------------------------------------------------------- admin

export const adminShippingRouter: Router = Router()

const zoneSchema = z.object({
  name: z.string().trim().min(2).max(120),
  countries: z.array(z.string().trim().length(2).toUpperCase()).min(1).max(250),
  regions: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  /// False turns the zone into a refusal — see the service for why.
  isServiceable: z.boolean().default(true),
  unserviceableMessage: z.string().trim().max(300).optional().nullable(),
  position: z.coerce.number().int().min(0).default(0),
})

const rateSchema = z
  .object({
    label: z.string().trim().max(80).optional().nullable(),
    minWeightGrams: z.coerce.number().int().min(0).nullable().optional(),
    maxWeightGrams: z.coerce.number().int().min(1).nullable().optional(),
    minSubtotal: z.coerce.number().int().min(0).nullable().optional(),
    maxSubtotal: z.coerce.number().int().min(1).nullable().optional(),
    amount: z.coerce.number().int().min(0),
    position: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.minWeightGrams != null && v.maxWeightGrams != null && v.maxWeightGrams <= v.minWeightGrams) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxWeightGrams'],
        message: 'The upper weight must be above the lower weight',
      })
    }
    if (v.minSubtotal != null && v.maxSubtotal != null && v.maxSubtotal <= v.minSubtotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxSubtotal'],
        message: 'The upper value must be above the lower value',
      })
    }
  })

const methodFields = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(300).optional().nullable(),
  rate: z.coerce.number().int().min(0).default(0),
  freeAbove: z.coerce.number().int().min(0).nullable().optional(),
  minSubtotal: z.coerce.number().int().min(0).nullable().optional(),
  maxSubtotal: z.coerce.number().int().min(0).nullable().optional(),
  /// Parcels above this are not offered the method (carrier limit).
  maxWeightGrams: z.coerce.number().int().min(1).nullable().optional(),
  minDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  maxDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  isCod: z.boolean().default(false),
  codFee: z.coerce.number().int().min(0).default(0),
  /// Null books by hand; a name selects a registered carrier adapter.
  provider: z.string().trim().max(60).optional().nullable(),
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
    include: {
      methods: {
        orderBy: [{ position: 'asc' }, { rate: 'asc' }],
        include: { rates: { orderBy: { position: 'asc' } } },
      },
    },
  })

  const provider = getShippingProvider()

  return ok(res, {
    zones,
    /** So the admin screen can say whether parcels are booked by hand. */
    provider: { name: provider.name, canCreateShipments: provider.canCreateShipments },
  })
})

/**
 * Rate bands for a method (FR-21.2). Replaced wholesale — the editor always
 * sends the complete set, so a removed band is a removed row.
 */
adminShippingRouter.put(
  '/methods/:id/rates',
  writeLimiter,
  requirePermission('shipping.manage'),
  validate({ body: z.object({ rates: z.array(rateSchema).max(30) }) }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { rates } = req.validated!.body as { rates: Array<z.infer<typeof rateSchema>> }

    const method = await prisma.shippingMethod.findUnique({ where: { id } })
    if (!method) throw new NotFoundError('Shipping method', 'SHIPPING_METHOD_NOT_FOUND')

    await prisma.$transaction([
      prisma.shippingRate.deleteMany({ where: { methodId: id } }),
      prisma.shippingRate.createMany({
        data: rates.map((rate, index) => ({
          methodId: id,
          label: rate.label ?? null,
          minWeightGrams: rate.minWeightGrams ?? null,
          maxWeightGrams: rate.maxWeightGrams ?? null,
          minSubtotal: rate.minSubtotal ?? null,
          maxSubtotal: rate.maxSubtotal ?? null,
          amount: rate.amount,
          position: rate.position || index,
        })),
      }),
    ])

    recordAudit({
      action: 'SHIPPING_RATES_UPDATED',
      entityType: 'ShippingMethod',
      entityId: id,
      metadata: { bands: rates.length },
      req,
    })

    return ok(res, {
      method: await prisma.shippingMethod.findUnique({
        where: { id },
        include: { rates: { orderBy: { position: 'asc' } } },
      }),
    })
  },
)

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
