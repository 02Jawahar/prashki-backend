import { prisma } from '../config/db.js'
import { logger } from '../config/logger.js'
import { formatPaise } from '../utils/money.js'
import { sendMessage } from '../modules/messaging/message.service.js'
import { notify, notifyAdmins } from '../modules/notifications/notification.service.js'
import { on } from './bus.js'

/**
 * Side effects, wired to business events (spec §43).
 *
 * Keeping these here rather than inline in the order service means adding a
 * notification never involves editing checkout logic. Handlers are isolated by
 * the bus, so a failing email cannot fail an order.
 *
 * Everything outbound goes through `sendMessage`, which resolves the editable
 * template, honours the customer's preferences, and writes a delivery log —
 * so the copy is changeable from admin and "was it sent?" has an answer.
 *
 * When this needs retries and durability, these same handlers move behind
 * BullMQ without the emitters changing.
 */
export function registerEventHandlers(): void {
  on('USER_REGISTERED', async ({ userId, email, name }) => {
    await sendMessage({
      channel: 'EMAIL',
      key: 'account.welcome',
      recipient: email,
      userId,
      variables: { name },
      entityType: 'User',
      entityId: userId,
    })
  })

  on('ORDER_CREATED', async ({ orderId, orderNumber, userId, total }) => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, items: true },
    })
    if (!order) return

    const variables = {
      orderNumber,
      name: order.user.name,
      total: formatPaise(order.total),
      itemCount: order.items.reduce((n, i) => n + i.quantity, 0),
      items: order.items.map((i) => `${i.quantity} × ${i.productNameSnapshot}`).join(', '),
    }

    await sendMessage({
      channel: 'EMAIL',
      key: 'order.placed',
      recipient: order.user.email,
      userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

    if (order.user.phone) {
      await sendMessage({
        channel: 'WHATSAPP',
        key: 'order.placed',
        recipient: order.user.phone,
        userId,
        variables,
        entityType: 'Order',
        entityId: orderId,
      })
    }

    notify({
      userId,
      type: 'order.placed',
      title: `Order ${orderNumber} received`,
      body: `We have your order for ${formatPaise(total)}.`,
      link: `/account/orders/${orderId}`,
      severity: 'SUCCESS',
    })

    notifyAdmins({
      type: 'order.placed',
      title: `New order ${orderNumber}`,
      body: `${order.user.name} — ${formatPaise(total)}`,
      link: `/admin/orders/${orderId}`,
      severity: 'INFO',
    })
  })

  on('ORDER_PAID', async ({ orderId, orderNumber, userId, total }) => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } })
    if (!order) return

    const variables = { orderNumber, name: order.user.name, total: formatPaise(total) }

    await sendMessage({
      channel: 'EMAIL',
      key: 'order.paid',
      recipient: order.user.email,
      userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

    if (order.user.phone) {
      await sendMessage({
        channel: 'SMS',
        key: 'order.paid',
        recipient: order.user.phone,
        userId,
        variables,
        entityType: 'Order',
        entityId: orderId,
      })
    }

    notify({
      userId,
      type: 'order.paid',
      title: `Payment received for ${orderNumber}`,
      link: `/account/orders/${orderId}`,
      severity: 'SUCCESS',
    })
  })

  on('ORDER_SHIPPED', async ({ orderId, orderNumber }) => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    if (!order) return

    const shipment = order.shipments[0]
    const variables = {
      orderNumber,
      name: order.user.name,
      carrier: shipment?.carrier ?? '',
      trackingNumber: shipment?.trackingNumber ?? '',
      trackingUrl: shipment?.trackingUrl ?? '',
    }

    await sendMessage({
      channel: 'EMAIL',
      key: 'order.shipped',
      recipient: order.user.email,
      userId: order.userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

    if (order.user.phone) {
      await sendMessage({
        channel: 'WHATSAPP',
        key: 'order.shipped',
        recipient: order.user.phone,
        userId: order.userId,
        variables,
        entityType: 'Order',
        entityId: orderId,
      })
    }

    notify({
      userId: order.userId,
      type: 'order.shipped',
      title: `Order ${orderNumber} is on its way`,
      body: shipment?.trackingNumber ? `Tracking ${shipment.trackingNumber}` : null,
      link: `/account/orders/${orderId}`,
      severity: 'INFO',
    })
  })

  on('ORDER_DELIVERED', async ({ orderId, orderNumber }) => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } })
    if (!order) return

    await sendMessage({
      channel: 'EMAIL',
      key: 'order.delivered',
      recipient: order.user.email,
      userId: order.userId,
      variables: { orderNumber, name: order.user.name },
      entityType: 'Order',
      entityId: orderId,
    })

    notify({
      userId: order.userId,
      type: 'order.delivered',
      title: `Order ${orderNumber} delivered`,
      body: 'We would love to know what you think.',
      link: `/account/orders/${orderId}`,
      severity: 'SUCCESS',
    })
  })

  on('ORDER_CANCELLED', async ({ orderId, orderNumber }) => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } })
    if (!order) return

    await sendMessage({
      channel: 'EMAIL',
      key: 'order.cancelled',
      recipient: order.user.email,
      userId: order.userId,
      variables: { orderNumber, name: order.user.name },
      entityType: 'Order',
      entityId: orderId,
    })
  })

  on('INVENTORY_UPDATED', async ({ variantId, availableStock }) => {
    const inventory = await prisma.inventory.findUnique({
      where: { variantId },
      include: { variant: { include: { product: true } } },
    })
    if (!inventory) return
    if (availableStock > inventory.lowStockThreshold) return

    logger.warn(
      { sku: inventory.variant.sku, product: inventory.variant.product.name, availableStock },
      'Low stock',
    )

    notifyAdmins({
      type: 'inventory.low_stock',
      title:
        availableStock === 0
          ? `${inventory.variant.product.name} is out of stock`
          : `${inventory.variant.product.name} is running low`,
      body: `${inventory.variant.sku} — ${availableStock} left`,
      link: '/admin/inventory',
      severity: availableStock === 0 ? 'ERROR' : 'WARNING',
    })
  })
}
