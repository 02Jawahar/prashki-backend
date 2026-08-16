import type { Prisma, ShipmentStatus } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { emit } from '../../events/bus.js'
import { recordAudit } from '../../utils/audit.js'
import { getShippingProvider, type CarrierEvent } from '../../integrations/shipping/index.js'
import { orderWeightGrams } from '../shipping/shipping.service.js'

/**
 * Fulfilment (M09).
 *
 * An order can go out in more than one parcel, so a shipment carries its own
 * item rows. The invariant this file protects: across all of an order's
 * shipments, no order line is ever shipped more times than it was bought.
 */

/**
 * Carrier tracking URLs. Kept as a table rather than hard-coded per carrier so
 * adding one is a data change; an unknown carrier simply has no link.
 */
const TRACKING_URLS: Record<string, string> = {
  bluedart: 'https://www.bluedart.com/tracking?trackFor=0&trackNo={tracking}',
  delhivery: 'https://www.delhivery.com/track/package/{tracking}',
  dtdc: 'https://www.dtdc.in/tracking.asp?strCnno={tracking}',
  ekart: 'https://ekartlogistics.com/shipmenttrack/{tracking}',
  indiapost: 'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?logisticsNo={tracking}',
  xpressbees: 'https://www.xpressbees.com/track?awb={tracking}',
}

export function trackingUrlFor(carrier: string | null, tracking: string | null): string | null {
  if (!carrier || !tracking) return null
  const template = TRACKING_URLS[carrier.trim().toLowerCase().replace(/\s+/g, '')]
  return template ? template.replace('{tracking}', encodeURIComponent(tracking)) : null
}

/** PK-1042-S1: the order's number, then the shipment's position within it. */
async function nextShipmentNumber(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderNumber: string,
): Promise<string> {
  const existing = await tx.shipment.count({ where: { orderId } })
  return `${orderNumber}-S${existing + 1}`
}

export interface CreateShipmentInput {
  orderId: string
  items: Array<{ orderItemId: string; quantity: number }>
  carrier?: string | null
  trackingNumber?: string | null
  weightGrams?: number | null
  lengthMm?: number | null
  widthMm?: number | null
  heightMm?: number | null
  estimatedAt?: Date | null
  notes?: string | null
  dispatchedBy?: string | null
  /**
   * Ask the configured carrier to book the parcel and return an AWB
   * (FR-21.3). Ignored when the adapter cannot create shipments.
   */
  bookWithProvider?: boolean
  actorId: string
}

export async function createShipment(input: CreateShipmentInput) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { items: true, shipments: { include: { items: true } } },
    })
    if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

    if (order.status === 'CANCELLED') {
      throw new ConflictError('A cancelled order cannot be shipped', 'ORDER_CANCELLED')
    }
    if (order.status === 'PENDING_PAYMENT') {
      throw new ConflictError('That order has not been paid for yet', 'ORDER_UNPAID')
    }

    // Everything already committed to a parcel, per line. Cancelled shipments
    // release their claim so the goods can be sent again.
    const alreadyShipped = new Map<string, number>()
    for (const shipment of order.shipments) {
      if (shipment.status === 'CANCELLED') continue
      for (const item of shipment.items) {
        alreadyShipped.set(item.orderItemId, (alreadyShipped.get(item.orderItemId) ?? 0) + item.quantity)
      }
    }

    if (input.items.length === 0) throw new ValidationError('Choose at least one item to ship')

    for (const line of input.items) {
      const orderItem = order.items.find((i) => i.id === line.orderItemId)
      if (!orderItem) throw new ValidationError('That item is not on this order')

      const remaining = orderItem.quantity - (alreadyShipped.get(line.orderItemId) ?? 0)
      if (line.quantity < 1) throw new ValidationError('Ship at least one of each item')
      if (line.quantity > remaining) {
        throw new ConflictError(
          remaining === 0
            ? `${orderItem.productNameSnapshot} has already been shipped in full`
            : `Only ${remaining} of ${orderItem.productNameSnapshot} is left to ship`,
          'OVER_SHIPMENT',
        )
      }
    }

    const carrier = input.carrier?.trim() || null
    const trackingNumber = input.trackingNumber?.trim() || null

    const shipment = await tx.shipment.create({
      data: {
        orderId: order.id,
        shipmentNumber: await nextShipmentNumber(tx, order.id, order.orderNumber),
        status: trackingNumber ? 'IN_TRANSIT' : 'READY_TO_SHIP',
        carrier,
        trackingNumber,
        trackingUrl: trackingUrlFor(carrier, trackingNumber),
        weightGrams: input.weightGrams ?? null,
        lengthMm: input.lengthMm ?? null,
        widthMm: input.widthMm ?? null,
        heightMm: input.heightMm ?? null,
        estimatedAt: input.estimatedAt ?? null,
        notes: input.notes ?? null,
        dispatchedBy: input.dispatchedBy ?? null,
        packedAt: new Date(),
        shippedAt: trackingNumber ? new Date() : null,
        items: { create: input.items },
        events: {
          create: {
            status: trackingNumber ? 'IN_TRANSIT' : 'READY_TO_SHIP',
            message: trackingNumber ? 'Handed to the carrier' : 'Packed and ready',
          },
        },
      },
      include: { items: true, events: true },
    })

    /**
     * The order becomes SHIPPED only once every line is accounted for. A partial
     * despatch leaves it in PROCESSING, which is what the customer should see
     * while part of the order is still with us.
     */
    for (const line of input.items) {
      alreadyShipped.set(line.orderItemId, (alreadyShipped.get(line.orderItemId) ?? 0) + line.quantity)
    }
    const fullyShipped = order.items.every(
      (item) => (alreadyShipped.get(item.id) ?? 0) >= item.quantity,
    )

    if (fullyShipped && order.status !== 'SHIPPED' && order.status !== 'DELIVERED') {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'SHIPPED',
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: 'SHIPPED',
              note: `Shipment ${shipment.shipmentNumber}`,
              changedById: input.actorId,
            },
          },
        },
      })
    } else if (!fullyShipped && order.status === 'PAID') {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'PROCESSING',
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: 'PROCESSING',
              note: `Partial shipment ${shipment.shipmentNumber}`,
              changedById: input.actorId,
            },
          },
        },
      })
    }

    return { shipment, order, fullyShipped }
  })
}

const TERMINAL: ShipmentStatus[] = ['DELIVERED', 'RETURNED_TO_ORIGIN', 'CANCELLED']

/**
 * How far along the journey each state is.
 *
 * Used only to detect a carrier event arriving *behind* where the parcel has
 * already got to. Side states (exception, failed) sit off the ladder: they can
 * happen at any point and are never treated as going backwards.
 */
const PROGRESS: Partial<Record<ShipmentStatus, number>> = {
  PENDING: 0,
  READY_TO_SHIP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
  RETURNED_TO_ORIGIN: 4,
}

/** True when `next` would move the parcel back down the ladder. */
export function isBackwards(current: ShipmentStatus, next: ShipmentStatus): boolean {
  const from = PROGRESS[current]
  const to = PROGRESS[next]
  if (from === undefined || to === undefined) return false
  return to < from
}

/**
 * Records a tracking update. Every change appends an event, so the trail the
 * customer sees is the history rather than a reconstruction of it.
 *
 * `source` decides how strict this is. An operator acting deliberately is
 * blocked from reopening a closed parcel; a carrier callback that arrives out
 * of order is *recorded but not applied*, and the shipment is flagged for
 * review instead — losing the event would be worse than holding it.
 */
export async function updateShipmentStatus(args: {
  shipmentId: string
  status: ShipmentStatus
  message?: string | null
  location?: string | null
  occurredAt?: Date
  actorId: string | null
  source?: 'manual' | 'provider' | 'system'
  providerEventId?: string | null
  providerStatus?: string | null
}) {
  const source = args.source ?? 'manual'

  return prisma.$transaction(async (tx) => {
    const shipment = await tx.shipment.findUnique({
      where: { id: args.shipmentId },
      include: { order: { include: { shipments: true } } },
    })
    if (!shipment) throw new NotFoundError('Shipment', 'SHIPMENT_NOT_FOUND')

    const eventData = {
      status: args.status,
      message: args.message ?? null,
      location: args.location ?? null,
      occurredAt: args.occurredAt ?? new Date(),
      source,
      providerEventId: args.providerEventId ?? null,
      providerStatus: args.providerStatus ?? null,
    }

    /**
     * Out-of-order carrier event. The trail keeps it — it genuinely happened —
     * but the status stays where it is and a human is asked to look.
     */
    if (source === 'provider' && isBackwards(shipment.status, args.status)) {
      return tx.shipment.update({
        where: { id: args.shipmentId },
        data: {
          needsReview: true,
          reviewReason: `Carrier reported "${args.providerStatus ?? args.status}" after the parcel was already ${shipment.status.toLowerCase().replace(/_/g, ' ')}`,
          events: { create: { ...eventData, ignoredForStatus: true } },
        },
        include: { items: true, events: { orderBy: { occurredAt: 'asc' } } },
      })
    }

    if (source !== 'provider' && TERMINAL.includes(shipment.status) && shipment.status !== args.status) {
      throw new ConflictError(
        `A ${shipment.status.toLowerCase().replace(/_/g, ' ')} shipment cannot change status`,
        'SHIPMENT_CLOSED',
      )
    }

    // Repeating the current status is not an error — carriers send the same
    // state more than once — but it should not restamp the timestamps.
    if (shipment.status === args.status) {
      return tx.shipment.update({
        where: { id: args.shipmentId },
        data: { events: { create: eventData } },
        include: { items: true, events: { orderBy: { occurredAt: 'asc' } } },
      })
    }

    const updated = await tx.shipment.update({
      where: { id: args.shipmentId },
      data: {
        status: args.status,
        ...(args.status === 'IN_TRANSIT' && !shipment.shippedAt ? { shippedAt: new Date() } : {}),
        ...(args.status === 'DELIVERED' ? { deliveredAt: args.occurredAt ?? new Date() } : {}),
        // A parcel that recovers from an exception no longer needs looking at.
        ...(args.status === 'IN_TRANSIT' || args.status === 'OUT_FOR_DELIVERY' || args.status === 'DELIVERED'
          ? { needsReview: false, reviewReason: null }
          : {}),
        // An exception is exactly what an operator should see.
        ...(args.status === 'EXCEPTION' || args.status === 'FAILED'
          ? {
              needsReview: true,
              reviewReason: args.message ?? `Carrier reported ${args.status.toLowerCase()}`,
            }
          : {}),
        events: { create: eventData },
      },
      include: { items: true, events: { orderBy: { occurredAt: 'asc' } } },
    })

    // The order is delivered when every live parcel has arrived.
    if (args.status === 'DELIVERED') {
      const siblings = await tx.shipment.findMany({ where: { orderId: shipment.orderId } })
      const allDelivered = siblings
        .filter((s) => s.status !== 'CANCELLED')
        .every((s) => s.status === 'DELIVERED')

      if (allDelivered && shipment.order.status !== 'DELIVERED') {
        await tx.order.update({
          where: { id: shipment.orderId },
          data: {
            status: 'DELIVERED',
            statusHistory: {
              create: {
                fromStatus: shipment.order.status,
                toStatus: 'DELIVERED',
                note: 'All shipments delivered',
                changedById: args.actorId,
              },
            },
          },
        })
      }
    }

    return updated
  })
}

/**
 * Books an already-created shipment with the carrier (FR-21.3, FR-21.4).
 *
 * Deliberately a second step, outside the creation transaction: holding a
 * database transaction open across a call to a third party is how connection
 * pools die, and a carrier that times out must leave a shipment we can retry
 * rather than rolling back goods that are already packed.
 */
export async function bookWithProvider(shipmentId: string) {
  const provider = getShippingProvider()
  if (!provider.canCreateShipments) {
    throw new ConflictError(
      'This delivery method is booked by hand. Record the tracking number once the courier gives you one.',
      'SHIPPING_PROVIDER_MANUAL',
    )
  }

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: true } },
      order: true,
    },
  })
  if (!shipment) throw new NotFoundError('Shipment', 'SHIPMENT_NOT_FOUND')

  if (shipment.providerShipmentId) {
    throw new ConflictError('That parcel is already booked with the carrier', 'ALREADY_BOOKED')
  }

  const address = shipment.order.shippingAddressSnapshot as Record<string, string | null>

  const booked = await provider.createShipment({
    shipmentNumber: shipment.shipmentNumber,
    orderNumber: shipment.order.orderNumber,
    to: {
      name: address.name ?? '',
      phone: address.phone ?? '',
      addressLine1: address.addressLine1 ?? '',
      addressLine2: address.addressLine2,
      city: address.city ?? '',
      state: address.state ?? '',
      postalCode: address.postalCode ?? '',
      country: address.country ?? 'IN',
    },
    items: shipment.items.map((item) => ({
      name: item.orderItem.productNameSnapshot,
      sku: item.orderItem.sku,
      quantity: item.quantity,
      unitPrice: item.orderItem.unitPrice,
    })),
    weightGrams: shipment.weightGrams ?? (await orderWeightGrams(shipment.orderId)),
    lengthMm: shipment.lengthMm,
    widthMm: shipment.widthMm,
    heightMm: shipment.heightMm,
  })

  const carrier = booked.carrier ?? shipment.carrier
  const trackingNumber = booked.trackingNumber ?? shipment.trackingNumber

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      provider: provider.name,
      providerShipmentId: booked.providerShipmentId,
      carrier,
      trackingNumber,
      trackingUrl: trackingUrlFor(carrier, trackingNumber),
      labelUrl: booked.labelUrl ?? null,
      estimatedAt: booked.estimatedAt ?? shipment.estimatedAt,
      events: {
        create: {
          status: shipment.status,
          message: `Booked with ${provider.name}`,
          source: 'system',
        },
      },
    },
    include: shipmentInclude,
  })
}

/**
 * Applies a verified carrier callback (FR-21.5).
 *
 * Matching is by the carrier's own shipment id first, then the tracking
 * number — nothing else in the payload is trusted to identify a parcel.
 * Returns null when the event cannot be matched, which the webhook route
 * records as a skipped event rather than an error.
 */
export async function applyCarrierEvent(event: CarrierEvent) {
  const shipment = event.providerShipmentId
    ? await prisma.shipment.findUnique({ where: { providerShipmentId: event.providerShipmentId } })
    : event.trackingNumber
      ? await prisma.shipment.findFirst({
          where: { trackingNumber: event.trackingNumber },
          orderBy: { createdAt: 'desc' },
        })
      : null

  if (!shipment) return null

  const updated = await updateShipmentStatus({
    shipmentId: shipment.id,
    status: event.status,
    message: event.message,
    location: event.location,
    occurredAt: event.occurredAt,
    actorId: null,
    source: 'provider',
    providerEventId: event.eventId,
    providerStatus: event.providerStatus,
  })

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: shipment.orderId },
    select: { id: true, orderNumber: true },
  })

  announceShipment(updated, order, null)

  return { shipment: updated, order }
}

export function announceShipment(
  shipment: { id: string; status: ShipmentStatus },
  order: { id: string; orderNumber: string },
  actorId: string | null,
) {
  recordAudit({
    userId: actorId,
    action: 'SHIPMENT_UPDATED',
    entityType: 'Shipment',
    entityId: shipment.id,
    metadata: { status: shipment.status, orderNumber: order.orderNumber },
  })

  if (shipment.status === 'IN_TRANSIT') {
    emit('ORDER_SHIPPED', { orderId: order.id, orderNumber: order.orderNumber })
  }
  if (shipment.status === 'DELIVERED') {
    emit('ORDER_DELIVERED', { orderId: order.id, orderNumber: order.orderNumber })
  }
}

export const shipmentInclude = {
  items: { include: { orderItem: true } },
  events: { orderBy: { occurredAt: 'desc' } },
} satisfies Prisma.ShipmentInclude
