import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { ok, pageMeta } from '../../utils/response.js'
import { recordAudit } from '../../utils/audit.js'
import { lowStock, movementHistory } from '../inventory/inventory.service.js'

export const adminDashboardRouter: Router = Router()

/**
 * Dashboard (spec §7). Every figure is a real query — no placeholder numbers.
 */
adminDashboardRouter.get('/stats', requirePermission('dashboard.read'), async (_req, res) => {
  const [
    totalProducts,
    activeProducts,
    totalCustomers,
    totalOrders,
    pendingOrders,
    revenue,
    lowStockItems,
  ] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
    // Revenue counts orders that actually got paid — not carts, not abandoned
    // pending-payment orders.
    prisma.order.aggregate({
      where: { status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
      _sum: { total: true },
    }),
    lowStock(5),
  ])

  return ok(res, {
    totalProducts,
    activeProducts,
    totalCustomers,
    totalOrders,
    pendingOrders,
    totalRevenue: revenue._sum.total ?? 0,
    lowStockCount: lowStockItems.length,
    lowStockItems,
  })
})

adminDashboardRouter.get('/recent-orders', requirePermission('order.read'), async (_req, res) => {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
    take: 8,
    include: {
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { items: true } },
    },
  })

  return ok(res, {
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      total: o.total,
      itemCount: o._count.items,
      customer: o.user,
      createdAt: o.createdAt,
    })),
  })
})

// -------------------------------------------------------------- inventory

export const adminInventoryRouter: Router = Router()

const inventoryQuery = z.object({
  q: z.string().trim().max(120).optional(),
  lowOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminInventoryRouter.get(
  '/',
  requirePermission('inventory.read'),
  validate({ query: inventoryQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof inventoryQuery>

    const where = {
      ...(q.q
        ? {
            variant: {
              OR: [
                { sku: { contains: q.q, mode: 'insensitive' as const } },
                { product: { name: { contains: q.q, mode: 'insensitive' as const } } },
              ],
            },
          }
        : {}),
      ...(q.lowOnly ? { availableStock: { lte: prisma.inventory.fields.lowStockThreshold } } : {}),
    }

    const [total, rows] = await Promise.all([
      prisma.inventory.count({ where }),
      prisma.inventory.findMany({
        where,
        orderBy: { availableStock: 'asc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: {
          variant: {
            include: { product: { select: { id: true, name: true, slug: true, status: true } } },
          },
        },
      }),
    ])

    return ok(
      res,
      {
        items: rows.map((r) => ({
          variantId: r.variantId,
          sku: r.variant.sku,
          variantName: r.variant.name,
          productId: r.variant.product.id,
          productName: r.variant.product.name,
          productSlug: r.variant.product.slug,
          productStatus: r.variant.product.status,
          availableStock: r.availableStock,
          reservedStock: r.reservedStock,
          lowStockThreshold: r.lowStockThreshold,
          isLow: r.availableStock <= r.lowStockThreshold,
        })),
      },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

adminInventoryRouter.get(
  '/:variantId/movements',
  requirePermission('inventory.read'),
  async (req, res) => {
    const { variantId } = req.params as { variantId: string }
    return ok(res, await movementHistory(variantId))
  },
)

// --------------------------------------------------------------- settings

export const adminSettingsRouter: Router = Router()

adminSettingsRouter.get('/', requirePermission('settings.read'), async (_req, res) => {
  const settings = await prisma.setting.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] })
  return ok(res, { settings })
})

const updateSettingsSchema = z.object({
  settings: z
    .array(z.object({ key: z.string().min(1), value: z.string().max(20_000) }))
    .min(1)
    .max(100),
})

adminSettingsRouter.patch(
  '/',
  writeLimiter,
  requirePermission('settings.update'),
  validate({ body: updateSettingsSchema }),
  async (req, res) => {
    const { settings } = req.validated!.body as z.infer<typeof updateSettingsSchema>

    await prisma.$transaction(
      settings.map((s) =>
        prisma.setting.update({ where: { key: s.key }, data: { value: s.value } }),
      ),
    )

    recordAudit({
      action: 'SETTINGS_UPDATED',
      entityType: 'Setting',
      entityId: 'bulk',
      metadata: { keys: settings.map((s) => s.key) },
      req,
    })

    return ok(res, { settings: await prisma.setting.findMany({ orderBy: { key: 'asc' } }) })
  },
)

// --------------------------------------------------------------- customers

export const adminCustomerRouter: Router = Router()

const customerQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminCustomerRouter.get(
  '/',
  requirePermission('customer.read'),
  validate({ query: customerQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof customerQuery>

    const where = {
      role: 'CUSTOMER' as const,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
              { phone: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          status: true,
          emailVerified: true,
          createdAt: true,
          lastLoginAt: true,
          _count: { select: { orders: true } },
        },
      }),
    ])

    return ok(
      res,
      {
        customers: rows.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          status: c.status,
          emailVerified: c.emailVerified,
          orderCount: c._count.orders,
          createdAt: c.createdAt,
          lastLoginAt: c.lastLoginAt,
        })),
      },
      { pagination: pageMeta(q.page, q.perPage, total) },
    )
  },
)

adminCustomerRouter.get('/:id', requirePermission('customer.read'), async (req, res) => {
  const { id } = req.params as { id: string }

  const customer = await prisma.user.findFirst({
    where: { id, role: 'CUSTOMER' },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      lastLoginAt: true,
      addresses: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, orderNumber: true, status: true, total: true, createdAt: true },
      },
    },
  })

  if (!customer) {
    return res
      .status(404)
      .json({ success: false, error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' } })
  }

  const spend = await prisma.order.aggregate({
    where: { userId: id, status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
    _sum: { total: true },
  })

  return ok(res, { customer: { ...customer, totalSpend: spend._sum.total ?? 0 } })
})

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) })

adminCustomerRouter.patch(
  '/:id/status',
  writeLimiter,
  requirePermission('customer.update'),
  validate({ body: statusSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { status } = req.validated!.body as z.infer<typeof statusSchema>

    const customer = await prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, name: true, email: true, status: true },
    })

    // Suspending must end existing sessions, not just block new logins.
    if (status === 'SUSPENDED') {
      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }

    recordAudit({
      action: 'CUSTOMER_STATUS_CHANGED',
      entityType: 'User',
      entityId: id,
      metadata: { status },
      req,
    })

    return ok(res, { customer })
  },
)
