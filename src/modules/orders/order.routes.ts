import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { emit } from '../../events/bus.js'
import { createOrderIdempotent, orderDetailInclude, updateOrderStatus } from './order.service.js'
import { forAdmin, forCustomer } from './order.serializer.js'
import { maskContact } from '../../utils/pii.js'

/** Customer-facing orders. Every read is scoped to the session's user. */
export const orderRouter: Router = Router()

orderRouter.use(requireAuth)

const createSchema = z.object({
  addressId: z.string().trim().min(1),
  notes: z.string().trim().max(500).optional(),
  /**
   * Client-generated, one per checkout attempt. Optional so existing callers
   * keep working, but the storefront always sends it — see the service.
   */
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  /** Chosen from GET /shipping/quote. Re-validated server-side. */
  shippingMethodId: z.string().trim().min(1).optional(),
})

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(10),
})

orderRouter.post('/', writeLimiter, validate({ body: createSchema }), async (req, res) => {
  const input = req.validated!.body as z.infer<typeof createSchema>

  const { order, replayed } = await createOrderIdempotent({
    userId: req.user!.id,
    addressId: input.addressId,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
    shippingMethodId: input.shippingMethodId,
  })

  // A replay is the same order coming back, not a new one — auditing and
  // emailing again would double-count revenue and spam the customer.
  if (!replayed) {
    recordAudit({
      action: 'ORDER_CREATED',
      entityType: 'Order',
      entityId: order.id,
      metadata: { orderNumber: order.orderNumber, total: order.total },
      req,
    })
    emit('ORDER_CREATED', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      userId: req.user!.id,
      total: order.total,
    })
  }

  const full = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: orderDetailInclude,
  })

  return created(res, { order: forCustomer(full), replayed })
})

orderRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const q = req.validated!.query as z.infer<typeof listQuery>
  const where = { userId: req.user!.id }

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
      include: { items: { select: { id: true, quantity: true, imageUrlSnapshot: true, productNameSnapshot: true } } },
    }),
  ])

  return ok(
    res,
    {
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        total: o.total,
        createdAt: o.createdAt,
        itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
        items: o.items,
      })),
    },
    { pagination: pageMeta(q.page, q.perPage, total) },
  )
})

orderRouter.get('/:id', async (req, res) => {
  const { id } = req.params as { id: string }

  // Scoped by userId — an order id from another account must 404, not 403,
  // so the endpoint cannot be used to probe which ids exist.
  const order = await prisma.order.findFirst({
    where: { id, userId: req.user!.id },
    include: orderDetailInclude,
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  return ok(res, { order: forCustomer(order) })
})

// ---------------------------------------------------------------- admin

export const adminOrderRouter: Router = Router()

const adminListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminOrderRouter.get(
  '/',
  requirePermission('order.read'),
  validate({ query: adminListQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof adminListQuery>

    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { orderNumber: { contains: q.q, mode: 'insensitive' as const } },
              { user: { name: { contains: q.q, mode: 'insensitive' as const } } },
              { user: { email: { contains: q.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: {
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { items: true } },
        },
      }),
    ])

    return ok(
      res,
      {
        orders: orders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          total: o.total,
          itemCount: o._count.items,
          customer: maskContact(o.user, req.user?.permissions),
          createdAt: o.createdAt,
        })),
      },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

adminOrderRouter.get('/:id', requirePermission('order.read'), async (req, res) => {
  const { id } = req.params as { id: string }
  const order = await prisma.order.findUnique({ where: { id }, include: orderDetailInclude })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')
  return ok(res, { order: forAdmin(order, req.user?.permissions) })
})

const internalNotesSchema = z.object({ internalNotes: z.string().trim().max(4000) })

/**
 * Staff-only note on an order (FR-9.6). Kept separate from `notes`, which is
 * the customer's own message and must stay editable only by them.
 */
adminOrderRouter.patch(
  '/:id/internal-notes',
  writeLimiter,
  requirePermission('order.update'),
  validate({ body: internalNotesSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { internalNotes } = req.validated!.body as z.infer<typeof internalNotesSchema>

    const exists = await prisma.order.findUnique({ where: { id }, select: { id: true } })
    if (!exists) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

    await prisma.order.update({ where: { id }, data: { internalNotes: internalNotes || null } })

    recordAudit({ action: 'ORDER_NOTE_UPDATED', entityType: 'Order', entityId: id, req })

    const order = await prisma.order.findUniqueOrThrow({ where: { id }, include: orderDetailInclude })
    return ok(res, { order: forAdmin(order, req.user?.permissions) })
  },
)

const statusSchema = z.object({
  status: z.enum(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
  note: z.string().trim().max(300).optional(),
})

adminOrderRouter.patch(
  '/:id/status',
  writeLimiter,
  requirePermission('order.update_status'),
  validate({ body: statusSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { status, note } = req.validated!.body as z.infer<typeof statusSchema>

    await updateOrderStatus(id, status, req.user!.id, note)

    const order = await prisma.order.findUniqueOrThrow({ where: { id }, include: orderDetailInclude })
    return ok(res, { order: forAdmin(order, req.user?.permissions) })
  },
)
