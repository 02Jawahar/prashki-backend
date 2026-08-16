import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { ok } from '../../utils/response.js'

/**
 * Reports (M19, M24).
 *
 * Every figure is a real aggregate over real rows — nothing here is estimated
 * or cached. Revenue counts only orders that were actually paid for, so the
 * number on the dashboard is the number in the bank, not the number of carts
 * that reached checkout.
 */
export const adminReportRouter: Router = Router()

/** Statuses that represent money we have taken and kept. */
const EARNED = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const

const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Bucket size for the time series. */
  interval: z.enum(['day', 'week', 'month']).default('day'),
})

/** Defaults to the last 30 days when no range is given. */
function resolveRange(q: z.infer<typeof rangeQuery>) {
  const to = q.to ?? new Date()
  const from = q.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60_000)
  return { from, to }
}

adminReportRouter.get(
  '/sales',
  requirePermission('report.read'),
  validate({ query: rangeQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof rangeQuery>
    const { from, to } = resolveRange(q)

    const where = {
      status: { in: [...EARNED] },
      createdAt: { gte: from, lte: to },
    }

    const [totals, orderCount, refunded, series] = await Promise.all([
      prisma.order.aggregate({
        where,
        _sum: { total: true, subtotal: true, discount: true, shipping: true, tax: true },
        _avg: { total: true },
      }),
      prisma.order.count({ where }),
      prisma.refund.aggregate({
        where: { status: { in: ['PENDING', 'PROCESSING', 'COMPLETED'] }, createdAt: { gte: from, lte: to } },
        _sum: { amount: true },
      }),
      /**
       * date_trunc keeps the bucketing in the database rather than pulling
       * every order into Node to group by hand.
       */
      prisma.$queryRaw<Array<{ bucket: Date; orders: bigint; revenue: bigint }>>`
        SELECT date_trunc(${q.interval}, "createdAt") AS bucket,
               COUNT(*)::bigint                       AS orders,
               COALESCE(SUM("total"), 0)::bigint      AS revenue
        FROM "orders"
        WHERE "createdAt" BETWEEN ${from} AND ${to}
          AND "status" = ANY(${Prisma.sql`ARRAY['PAID','PROCESSING','SHIPPED','DELIVERED']::"OrderStatus"[]`})
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    ])

    const gross = totals._sum.total ?? 0
    const refundTotal = Number(refunded._sum.amount ?? 0)

    return ok(res, {
      range: { from, to, interval: q.interval },
      orders: orderCount,
      grossRevenue: gross,
      refunds: refundTotal,
      netRevenue: gross - refundTotal,
      averageOrderValue: Math.round(totals._avg.total ?? 0),
      breakdown: {
        subtotal: totals._sum.subtotal ?? 0,
        discount: totals._sum.discount ?? 0,
        shipping: totals._sum.shipping ?? 0,
        tax: totals._sum.tax ?? 0,
      },
      series: series.map((row) => ({
        date: row.bucket,
        orders: Number(row.orders),
        revenue: Number(row.revenue),
      })),
    })
  },
)

const topQuery = rangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

adminReportRouter.get(
  '/top-products',
  requirePermission('report.read'),
  validate({ query: topQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof topQuery>
    const { from, to } = resolveRange(q)

    const rows = await prisma.orderItem.groupBy({
      by: ['productId', 'productNameSnapshot'],
      where: {
        order: { status: { in: [...EARNED] }, createdAt: { gte: from, lte: to } },
      },
      _sum: { quantity: true, lineTotal: true, discountAllocated: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: q.limit,
    })

    return ok(res, {
      range: { from, to },
      products: rows.map((row) => ({
        productId: row.productId,
        name: row.productNameSnapshot,
        unitsSold: row._sum.quantity ?? 0,
        // Net of the discount those lines absorbed, so the ranking reflects
        // what the products actually earned.
        revenue: (row._sum.lineTotal ?? 0) - (row._sum.discountAllocated ?? 0),
      })),
    })
  },
)

adminReportRouter.get(
  '/inventory',
  requirePermission('report.read'),
  async (_req, res) => {
    const [totals, low, outOfStock, topMoving] = await Promise.all([
      prisma.inventory.aggregate({ _sum: { availableStock: true }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "inventory"
        WHERE "availableStock" <= "lowStockThreshold" AND "availableStock" > 0
      `,
      prisma.inventory.count({ where: { availableStock: { lte: 0 } } }),
      prisma.inventoryMovement.groupBy({
        by: ['inventoryId'],
        where: { type: 'SALE', createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60_000) } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'asc' } },
        take: 10,
      }),
    ])

    // SALE movements are negative, so the biggest sellers are the most negative.
    const inventoryIds = topMoving.map((m) => m.inventoryId)
    const details = inventoryIds.length
      ? await prisma.inventory.findMany({
          where: { id: { in: inventoryIds } },
          include: { variant: { include: { product: { select: { id: true, name: true } } } } },
        })
      : []

    const byId = new Map(details.map((d) => [d.id, d]))

    return ok(res, {
      variantsTracked: totals._count._all,
      unitsInStock: totals._sum.availableStock ?? 0,
      lowStockCount: Number(low[0]?.count ?? 0),
      outOfStockCount: outOfStock,
      fastestMoving: topMoving
        .map((m) => {
          const record = byId.get(m.inventoryId)
          if (!record) return null
          return {
            variantId: record.variantId,
            sku: record.variant.sku,
            productName: record.variant.product.name,
            unitsSold: Math.abs(m._sum.quantity ?? 0),
            remaining: record.availableStock,
          }
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    })
  },
)

adminReportRouter.get(
  '/customers',
  requirePermission('report.read'),
  validate({ query: rangeQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof rangeQuery>
    const { from, to } = resolveRange(q)

    const [newCustomers, totalCustomers, repeat] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: from, lte: to } } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      /** Customers with more than one earned order — the repeat-purchase base. */
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT "userId"
          FROM "orders"
          WHERE "status" = ANY(${Prisma.sql`ARRAY['PAID','PROCESSING','SHIPPED','DELIVERED']::"OrderStatus"[]`})
          GROUP BY "userId"
          HAVING COUNT(*) > 1
        ) AS repeat_buyers
      `,
    ])

    const buyers = await prisma.order.findMany({
      where: { status: { in: [...EARNED] } },
      distinct: ['userId'],
      select: { userId: true },
    })

    const repeatCount = Number(repeat[0]?.count ?? 0)

    return ok(res, {
      range: { from, to },
      newCustomers,
      totalCustomers,
      customersWhoBought: buyers.length,
      repeatCustomers: repeatCount,
      repeatRate: buyers.length > 0 ? Math.round((repeatCount / buyers.length) * 1000) / 10 : 0,
    })
  },
)

const searchQuery = rangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

/** What people looked for, and what found them nothing (M24). */
adminReportRouter.get(
  '/searches',
  requirePermission('report.read'),
  validate({ query: searchQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof searchQuery>
    const { from, to } = resolveRange(q)

    const rows = await prisma.$queryRaw<Array<{ term: string; searches: bigint; zero: bigint }>>`
      SELECT "properties"->>'term'                                        AS term,
             COUNT(*)::bigint                                             AS searches,
             COUNT(*) FILTER (WHERE ("properties"->>'results')::int = 0)::bigint AS zero
      FROM "analytics_events"
      WHERE "type" = 'search'
        AND "createdAt" BETWEEN ${from} AND ${to}
        AND "properties"->>'term' IS NOT NULL
      GROUP BY term
      ORDER BY searches DESC
      LIMIT ${q.limit}
    `

    return ok(res, {
      range: { from, to },
      searches: rows.map((row) => ({
        term: row.term,
        searches: Number(row.searches),
        zeroResults: Number(row.zero),
      })),
    })
  },
)
