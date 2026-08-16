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
  bookWithProvider,
  createShipment,
  shipmentInclude,
  trackingUrlFor,
  updateShipmentStatus,
} from './shipment.service.js'
import { orderWeightGrams } from '../shipping/shipping.service.js'

const SHIPMENT_STATUSES = [
  'PENDING',
  'READY_TO_SHIP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
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

  /**
   * An explicit allow-list, not the whole row.
   *
   * Operational fields — `needsReview`, `reviewReason`, internal `notes`, the
   * carrier reference, the label URL, who dispatched it — exist for staff and
   * must never reach the customer (M09: internal notes, risk flags and
   * provider payloads are never customer-visible). Selecting rather than
   * omitting means a column added later is private by default.
   */
  const shipments = await prisma.shipment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      shipmentNumber: true,
      status: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      shippedAt: true,
      deliveredAt: true,
      estimatedAt: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          quantity: true,
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
      events: {
        // An event the carrier sent out of order was deliberately not applied,
        // so showing it would contradict the status right above it.
        where: { ignoredForStatus: false },
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          status: true,
          message: true,
          location: true,
          occurredAt: true,
        },
      },
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
  lengthMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  widthMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  heightMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  estimatedAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  dispatchedBy: z.string().trim().max(120).optional().nullable(),
  /// Ask the carrier adapter to book it and return an AWB.
  bookWithProvider: z.boolean().default(false),
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
      weightGrams: body.weightGrams ?? (await orderWeightGrams(orderId)),
      lengthMm: body.lengthMm,
      widthMm: body.widthMm,
      heightMm: body.heightMm,
      estimatedAt: body.estimatedAt,
      notes: body.notes,
      dispatchedBy: body.dispatchedBy ?? req.user!.name,
      actorId: req.user!.id,
    })

    announceShipment(shipment, order, req.user!.id)

    /**
     * Booking happens after the shipment exists, so a carrier that is slow or
     * down leaves a parcel we can retry rather than losing the whole record.
     */
    if (body.bookWithProvider) {
      try {
        const booked = await bookWithProvider(shipment.id)
        return created(res, { shipment: booked, fullyShipped, booked: true })
      } catch (err) {
        return created(res, {
          shipment,
          fullyShipped,
          booked: false,
          bookingError:
            err instanceof Error ? err.message : 'The carrier could not be reached',
        })
      }
    }

    return created(res, { shipment, fullyShipped, booked: false })
  },
)

/** Books an existing parcel with the carrier, or retries a failed booking. */
adminShipmentRouter.post(
  '/:id/book',
  writeLimiter,
  requirePermission('shipment.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const shipment = await bookWithProvider(id)
    recordAudit({ action: 'SHIPMENT_BOOKED', entityType: 'Shipment', entityId: id, req })

    return ok(res, { shipment })
  },
)

/** Clears the "needs review" flag once an operator has looked at it. */
adminShipmentRouter.post(
  '/:id/reviewed',
  writeLimiter,
  requirePermission('shipment.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const existing = await prisma.shipment.findUnique({ where: { id }, select: { id: true } })
    if (!existing) throw new NotFoundError('Shipment', 'SHIPMENT_NOT_FOUND')

    const shipment = await prisma.shipment.update({
      where: { id },
      data: { needsReview: false, reviewReason: null },
      include: shipmentInclude,
    })

    recordAudit({ action: 'SHIPMENT_REVIEWED', entityType: 'Shipment', entityId: id, req })

    return ok(res, { shipment })
  },
)

const trackingSchema = z.object({
  carrier: z.string().trim().max(80).optional().nullable(),
  trackingNumber: z.string().trim().max(120).optional().nullable(),
  estimatedAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  /// Package profile, editable after the parcel has been weighed.
  weightGrams: z.coerce.number().int().min(0).max(500_000).optional().nullable(),
  lengthMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  widthMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  heightMm: z.coerce.number().int().min(0).max(5_000).optional().nullable(),
  dispatchedBy: z.string().trim().max(120).optional().nullable(),
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
        ...(body.weightGrams !== undefined ? { weightGrams: body.weightGrams } : {}),
        ...(body.lengthMm !== undefined ? { lengthMm: body.lengthMm } : {}),
        ...(body.widthMm !== undefined ? { widthMm: body.widthMm } : {}),
        ...(body.heightMm !== undefined ? { heightMm: body.heightMm } : {}),
        ...(body.dispatchedBy !== undefined ? { dispatchedBy: body.dispatchedBy } : {}),
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
