import { prisma } from '../config/db.js'
import { logger } from '../config/logger.js'
import { getEmailProvider, getSmsProvider } from '../integrations/notifications/index.js'
import { formatPaise } from '../utils/money.js'
import { on } from './bus.js'

/**
 * Side effects, wired to business events (spec §43).
 *
 * Keeping these here rather than inline in the order service means adding a
 * notification never involves editing checkout logic. Handlers are isolated by
 * the bus, so a failing email cannot fail an order.
 *
 * When this needs retries and durability, these same handlers move behind
 * BullMQ without the emitters changing.
 */
export function registerEventHandlers(): void {
  on('USER_REGISTERED', async ({ email, name }) => {
    await getEmailProvider().send({
      to: email,
      subject: 'Welcome',
      template: 'welcome',
      data: { name },
    })
  })

  on('ORDER_CREATED', async ({ orderId, orderNumber }) => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, items: true },
    })
    if (!order) return

    await getEmailProvider().send({
      to: order.user.email,
      subject: `Order ${orderNumber} received`,
      template: 'order-confirmation',
      data: {
        orderNumber,
        total: formatPaise(order.total),
        items: order.items.map((i) => ({
          name: i.productNameSnapshot,
          quantity: i.quantity,
          total: formatPaise(i.lineTotal),
        })),
      },
    })
  })

  on('ORDER_PAID', async ({ orderId, orderNumber, total }) => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } })
    if (!order) return

    await getEmailProvider().send({
      to: order.user.email,
      subject: `Payment received for ${orderNumber}`,
      template: 'payment-confirmation',
      data: { orderNumber, total: formatPaise(total) },
    })

    if (order.user.phone) {
      await getSmsProvider().send({
        to: order.user.phone,
        template: 'order-paid',
        data: { orderNumber },
      })
    }
  })

  on('ORDER_SHIPPED', ({ orderNumber }) => {
    logger.info({ orderNumber }, 'Order shipped — notification hook')
  })

  on('ORDER_DELIVERED', ({ orderNumber }) => {
    logger.info({ orderNumber }, 'Order delivered — notification hook')
  })

  on('INVENTORY_UPDATED', async ({ variantId, availableStock }) => {
    const inventory = await prisma.inventory.findUnique({
      where: { variantId },
      include: { variant: { include: { product: true } } },
    })
    if (!inventory) return

    if (availableStock <= inventory.lowStockThreshold) {
      logger.warn(
        { sku: inventory.variant.sku, product: inventory.variant.product.name, availableStock },
        'Low stock',
      )
    }
  })
}
