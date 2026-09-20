import { prisma } from '../config/db.js'
import { activateForOrder } from '../modules/giftcards/giftcard.service.js'
import { logger } from '../config/logger.js'
import { formatPaise } from '../utils/money.js'
import { sendToAllChannels } from '../modules/messaging/message.service.js'
import { notify, notifyAdmins } from '../modules/notifications/notification.service.js'
import { on } from './bus.js'

/**
 * Side effects, wired to business events (spec §43).
 *
 * Keeping these here rather than inline in the order service means adding a
 * notification never involves editing checkout logic. Handlers are isolated by
 * the bus, so a failing email cannot fail an order.
 *
 * Everything outbound goes through `sendToAllChannels`, which sends on every
 * channel that has an active template for the event. Handlers name the event,
 * not the channel: adding WhatsApp to shipping updates is an admin creating a
 * template, not a deploy. The old shape — an EMAIL call plus an `if (phone)`
 * WhatsApp call — meant the channel list lived in this file, so a template an
 * admin created for a channel nothing mentioned would never fire.
 *
 * When this needs retries and durability, these same handlers move behind
 * BullMQ without the emitters changing.
 */

/**
 * Where to reach the customer about one order.
 *
 * The profile phone is optional and most people never fill it in — eleven of
 * seventy-three, when this was written. The delivery phone is mandatory,
 * frozen onto the order, and already given to the courier so they can call
 * before arriving. Reading only the profile meant every SMS and WhatsApp about
 * an order was silently skipped for the great majority of customers, with
 * NO_RECIPIENT in the delivery log and nothing on any screen to say so.
 *
 * The profile still wins where it exists: somebody who deliberately entered a
 * number on their account meant that one, and a delivery address may belong to
 * whoever is receiving the parcel rather than whoever bought it.
 *
 * Worth being clear about what this is for. A delivery phone is given so a
 * parcel can arrive, which covers telling them about that parcel — and does
 * not extend to marketing. Transactional messages only.
 */
function contactFor(order: {
  user: { email: string; phone: string | null }
  shippingAddressSnapshot?: unknown
}): { email: string; phone: string | null } {
  const snapshot = order.shippingAddressSnapshot as { phone?: string | null } | null | undefined

  return {
    email: order.user.email,
    phone: order.user.phone ?? snapshot?.phone ?? null,
  }
}

export function registerEventHandlers(): void {
  on('USER_REGISTERED', async ({ userId, email, name, phone }) => {
    await sendToAllChannels({
      key: 'account.welcome',
      contact: { email, phone },
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

    await sendToAllChannels({
      key: 'order.placed',
      contact: contactFor(order),
      userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

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

    /**
     * A gift card bought on this order becomes spendable now, and only now.
     * Issuing it when the order was created would mint money for anyone who
     * opened the payment page and walked away.
     */
    const activated = await activateForOrder(orderId)
    if (activated > 0) {
      const cards = await prisma.giftCard.findMany({ where: { orderId, status: 'ACTIVE' } })

      for (const card of cards) {
        // Falls back to the buyer: a card bought for someone with no email
        // still has to reach somebody, and the buyer can forward it.
        const to = card.recipientEmail ?? order.user.email

        await sendToAllChannels({
          key: 'giftcard.issued',
          contact: { email: to, phone: null },
          // No userId: the recipient is usually not a customer, and a
          // preference check would look them up and find nothing.
          variables: {
            name: card.recipientName ?? order.user.name,
            code: card.code,
            amount: formatPaise(card.initialValue),
            message: card.message ?? '',
            from: order.user.name,
            expiresOn: card.expiresAt ? card.expiresAt.toDateString() : '',
          },
          entityType: 'GiftCard',
          entityId: card.id,
        })
      }
    }

    const variables = { orderNumber, name: order.user.name, total: formatPaise(total) }

    await sendToAllChannels({
      key: 'order.paid',
      contact: contactFor(order),
      userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

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

    await sendToAllChannels({
      key: 'order.shipped',
      contact: contactFor(order),
      userId: order.userId,
      variables,
      entityType: 'Order',
      entityId: orderId,
    })

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

    await sendToAllChannels({
      key: 'order.delivered',
      contact: contactFor(order),
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

  /**
   * A payment that did not go through.
   *
   * The order stays PENDING_PAYMENT and the stock stays held, so the customer
   * can retry — but only if they know. Left silent, this is the failure that
   * looks to them like the money vanished, and it arrives in support as "I paid
   * and got nothing".
   *
   * In-app rather than email, deliberately: a payment failure is something you
   * act on in the next minute, on the page you are already looking at. There is
   * no `order.failed` email template because a bounced-card notice landing in an
   * inbox an hour later helps nobody.
   */
  on('ORDER_FAILED', async ({ orderId, orderNumber, userId, reason }) => {
    if (!userId) return

    /**
     * The reason is written for staff — it carries strings like "Provider
     * reported payment.failed", which tells a customer nothing and reads like
     * something broke on our side. It stays in the payment record and the
     * admin view; what reaches the customer is what they can act on.
     */
    logger.info({ orderId, orderNumber, reason }, 'Notifying customer of failed payment')

    notify({
      userId,
      type: 'order.payment_failed',
      title: `Payment for ${orderNumber} did not go through`,
      body: 'Your order is being held. You can try paying again from your order page.',
      link: `/account/orders/${orderId}`,
      severity: 'WARNING',
    })
  })

  on('ORDER_CANCELLED', async ({ orderId, orderNumber }) => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } })
    if (!order) return

    await sendToAllChannels({
      key: 'order.cancelled',
      contact: contactFor(order),
      userId: order.userId,
      variables: { orderNumber, name: order.user.name },
      entityType: 'Order',
      entityId: orderId,
    })
  })

  /**
   * Return progress (FR-22.6). Only the states a customer would want to hear
   * about — the internal steps between them are noise in an inbox.
   */
  on('RETURN_UPDATED', async ({ returnRequestId, returnNumber, userId, status, note }) => {
    const TELL_THE_CUSTOMER = ['APPROVED', 'REJECTED', 'RECEIVED', 'COMPLETED']
    if (!TELL_THE_CUSTOMER.includes(status)) return

    const request = await prisma.returnRequest.findUnique({
      where: { id: returnRequestId },
      include: { user: true, order: { select: { orderNumber: true } } },
    })
    if (!request) return

    const readable = status.toLowerCase().replace(/_/g, ' ')

    await sendToAllChannels({
      key: 'return.updated',
      contact: { email: request.user.email, phone: request.user.phone },
      userId,
      variables: {
        name: request.user.name,
        returnNumber,
        orderNumber: request.order.orderNumber,
        status: readable,
        // The rejection reason is the note that matters most; fall back to
        // whatever the operator typed.
        note: request.rejectionReason ?? note ?? '',
      },
      entityType: 'ReturnRequest',
      entityId: returnRequestId,
    })

    notify({
      userId,
      type: 'return.updated',
      title: `Return ${returnNumber} is ${readable}`,
      body: request.rejectionReason ?? note,
      link: `/account/returns/${returnRequestId}`,
      severity: status === 'REJECTED' ? 'WARNING' : 'INFO',
    })
  })

  /** Money going back is always worth telling someone about (FR-22.6). */
  on('REFUND_ISSUED', async ({ refundId, orderId, orderNumber, userId, amount }) => {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return

    await sendToAllChannels({
      key: 'refund.issued',
      contact: { email: user.email, phone: user.phone },
      userId,
      variables: { name: user.name, orderNumber, amount: formatPaise(amount) },
      entityType: 'Refund',
      entityId: refundId,
    })

    notify({
      userId,
      type: 'refund.issued',
      title: `Refund of ${formatPaise(amount)} for ${orderNumber}`,
      body: 'It usually reaches your account within 5-7 working days.',
      link: `/account/orders/${orderId}`,
      severity: 'SUCCESS',
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
