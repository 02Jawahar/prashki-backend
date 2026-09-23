import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { getShippingProvider } from '../../integrations/shipping/index.js'
import { notifyAdmins } from '../notifications/notification.service.js'
import { bookWithProvider, createShipment } from './shipment.service.js'
import { orderWeightGrams } from '../shipping/shipping.service.js'

/**
 * Books a parcel with the carrier as soon as the gateway confirms payment.
 *
 * Off by default, and deliberately so: a studio that makes each piece to order
 * has nothing to collect for weeks, and an AWB allocated today is a
 * consignment the courier expects and will chase. A store that ships from
 * stock wants the opposite — the label waiting when the box is packed — which
 * is why this is a setting rather than a decision taken in code.
 *
 * What it does not do is guess. It books the whole order as one parcel,
 * because that is the only split it can know is right; anything else is a
 * studio decision. An order that needs two boxes is one an operator unbooks
 * and re-packs, which is why the failure path below leaves the order
 * perfectly usable rather than half-done.
 */

export const AUTO_BOOK_SETTING_KEY = 'shipping.auto_book_on_payment'

export async function autoBookEnabled(): Promise<boolean> {
  const row = await prisma.setting
    .findUnique({ where: { key: AUTO_BOOK_SETTING_KEY } })
    .catch(() => null)

  return row?.value === 'true'
}

/**
 * Called from the ORDER_PAID handler, which fires however the payment was
 * confirmed — the browser callback, the webhook, or an operator reconciling
 * against the gateway. All three mean the same thing, so all three book.
 *
 * Every failure here is swallowed after being logged and announced. A carrier
 * that refuses, a wallet with no balance, an address the courier will not
 * serve: none of them are reasons to disturb an order that is genuinely paid.
 * The order stays paid and unbooked, which is exactly the state an operator
 * can finish by hand — and they are told, rather than finding out from a
 * customer.
 */
export async function autoBookOnPayment(orderId: string, orderNumber: string): Promise<void> {
  if (!(await autoBookEnabled())) return

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { select: { id: true, quantity: true } },
        shipments: { select: { id: true } },
        shippingMethod: { select: { provider: true } },
      },
    })
    if (!order) return

    /**
     * Something already packed this — an operator who got there first, or a
     * second ORDER_PAID. Either way the parcel exists and booking it again
     * would buy a second AWB for the same box.
     */
    if (order.shipments.length > 0) {
      logger.info({ orderId, orderNumber }, 'Auto-booking skipped: this order already has a parcel')
      return
    }

    if (order.items.length === 0) return

    /**
     * A method booked by hand has no carrier to call. Checked here rather
     * than letting the booking fail, because "this method does not book" is a
     * configuration choice and not an error worth alarming anyone about.
     */
    let canBook = false
    try {
      canBook = getShippingProvider(order.shippingMethod?.provider).canCreateShipments
    } catch {
      canBook = false
    }
    if (!canBook) {
      logger.info(
        { orderId, orderNumber },
        'Auto-booking skipped: this delivery method is booked by hand',
      )
      return
    }

    const { shipment: packed } = await createShipment({
      orderId,
      items: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      weightGrams: await orderWeightGrams(orderId),
      // Null, not a fictional "system" user: changedById is a foreign key to
      // a real person, and nobody did this one. The note below is what says so.
      actorId: null,
      notes: 'Booked automatically when payment was confirmed',
    })

    /**
     * Packing and booking are two steps, and `createShipment` only does the
     * first — its `bookWithProvider` flag is honoured by the admin route, not
     * by the service. Passing it here produced a parcel with no carrier, no
     * AWB and no label, while the log cheerfully said it had been booked.
     */
    const shipment = await bookWithProvider(packed.id)

    logger.info(
      { orderId, orderNumber, shipmentId: shipment.id, awb: shipment.trackingNumber },
      'Parcel booked automatically on payment',
    )

    /**
     * An AWB without a label is a parcel nobody can post. It happens — the
     * carrier assigns the number and has the PDF a minute later — so it is
     * worth saying, because the fix is to press "Get label" rather than to
     * wonder why the booking looks wrong.
     */
    if (shipment.trackingNumber && !shipment.labelUrl) {
      notifyAdmins({
        type: 'shipment.label_pending',
        title: `${orderNumber} booked, label not ready`,
        body: `AWB ${shipment.trackingNumber}. Fetch the label from the order.`,
        link: `/admin/orders/${orderId}`,
        severity: 'INFO',
      })
    }
  } catch (err) {
    logger.error({ err, orderId, orderNumber }, 'Auto-booking failed; the order is paid but unbooked')

    notifyAdmins({
      type: 'shipment.auto_book_failed',
      title: `${orderNumber} is paid but not booked`,
      body:
        err instanceof Error
          ? `${err.message} — book it by hand from the order.`
          : 'Book it by hand from the order.',
      link: `/admin/orders/${orderId}`,
      severity: 'WARNING',
    })
  }
}
