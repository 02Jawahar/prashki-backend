import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import {
  announceShipment,
  createShipment,
  shipmentInclude,
  trackingUrlFor,
  updateShipmentStatus,
} from './shipment.service.js'

const SHIPMENT_STATUSES = [
  'PENDING',
  'READY_TO_SHIP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED_TO_ORIGIN',
  'CANCELLED',
] as const

/**
 * Customer-facing tracking (M09). Scoped to the signed-in user's own orders —
 * a shipment id from another account 404s rather than 403s, so the endpoint
 * cannot be used to discover which ids exist.
 */
export const trackingRouter: Router = Router()

trackingRouter.use(requireAuth)

trackingRouter.get('/orders/:orderId', async (req, res) => {
  const { orderId } = req.params as { orderId: string }

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: req.user!.id },
    select: { id: true, orderNumber: true, status: true },
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  const shipments = await prisma.shipment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    include: {
      items: {
        include: {
          orderItem: {
            select: {
              id: true,
              productNameSnapshot: true,
              variantNameSnapshot: true,
              imageUrlSnapshot: true,
            },
          },
        },
      },
      events: { orderBy: { occurredAt: 'desc' } },
    },
  })

  return ok(res, { order, shipments })
})

// ------------------------------------------------------------------- admin

export const adminShipmentRouter: Router = Router()

const createSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().trim().min(1),
        quantity: z.coerce.number().int().min(1),
      }),
    )
    .min(1, 'Choose at least one item to ship')
    .max(200),
  carrier: z.string().trim().max(80).optional().nullable(),
  trackingNumber: z.string().trim().max(120).optional().nullable(),
  weightGrams: z.coerce.number().int().min(0).max(500_000).optional().nullable(),
  estimatedAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
})

adminShipmentRouter.get('/', requirePermission('order.read'), async (req, res) => {
  const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined

  const shipments = await prisma.shipment.findMany({
    where: orderId ? { orderId } : {},
    orderBy: { createdAt: 'desc' },
    take: orderId ? undefined : 50,
    include: {
      ...shipmentInclude,
      order: { select: { id: true, orderNumber: true, status: true } },
    },
  })

  return ok(res, { shipments })
})

adminShipmentRouter.post(
  '/orders/:orderId',
  writeLimiter,
  requirePermission('shipment.manage'),
  validate({ body: createSchema }),
  async (req, res) => {
    const { orderId } = req.params as { orderId: string }
    const body = req.validated!.body as z.infer<typeof createSchema>

    const { shipment, order, fullyShipped } = await createShipment({
      orderId,
      items: body.items,
      carrier: body.carrier,
      trackingNumber: body.trackingNumber,
      weightGrams: body.weightGrams,
      estimatedAt: body.estimatedAt,
      notes: body.notes,
      actorId: req.user!.id,
    })

    announceShipment(shipment, order, req.user!.id)

    return created(res, { shipment, fullyShipped })
  },
)

const trackingSchema = z.object({
  carrier: z.string().trim().max(80).optional().nullable(),
  trackingNumber: z.string().trim().max(120).optional().nullable(),
  estimatedAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
})

adminShipmentRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('shipment.manage'),
  validate({ body: trackingSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof trackingSchema>

    const existing = await prisma.shipment.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Shipment', 'SHIPMENT_NOT_FOUND')

    const carrier = body.carrier === undefined ? existing.carrier : body.carrier?.trim() || null
    const trackingNumber =
      body.trackingNumber === undefined ? existing.trackingNumber : body.trackingNumber?.trim() || null

    const shipment = await prisma.shipment.update({
      where: { id },
      data: {
        carrier,
        trackingNumber,
        // Recomputed rather than accepted from the request — a tracking link is
        // a URL we send customers, so it must be one we constructed.
        trackingUrl: trackingUrlFor(carrier, trackingNumber),
        ...(body.estimatedAt !== undefined ? { estimatedAt: body.estimatedAt } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
      include: shipmentInclude,
    })

    recordAudit({ action: 'SHIPMENT_TRACKING_UPDATED', entityType: 'Shipment', entityId: id, req })

    return ok(res, { shipment })
  },
)

const statusSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  message: z.string().trim().max(300).optional().nullable(),
  location: z.string().trim().max(160).optional().nullable(),
  occurredAt: z.coerce.date().optional(),
})

adminShipmentRouter.patch(
  '/:id/status',
  writeLimiter,
  requirePermission('shipment.manage'),
  validate({ body: statusSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof statusSchema>

    const shipment = await updateShipmentStatus({
      shipmentId: id,
      status: body.status,
      message: body.message,
      location: body.location,
      occurredAt: body.occurredAt,
      actorId: req.user!.id,
    })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: shipment.orderId },
      select: { id: true, orderNumber: true },
    })
    announceShipment(shipment, order, req.user!.id)

    return ok(res, { shipment })
  },
)
