import type { Prisma, ReturnStatus } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * Returns (M22).
 *
 * Two things this file exists to get right:
 *
 *   1. A customer can never ask to return more than they bought, counting
 *      returns already in flight.
 *   2. The refundable value of a line is its price *minus its share of the
 *      order discount*. Refunding `unitPrice × quantity` on a discounted order
 *      hands back money that was never taken — which is why order lines carry
 *      `discountAllocated`.
 */

/** How long after delivery a return may be opened. Store policy, one place. */
export const RETURN_WINDOW_DAYS = 7

export const RETURN_REASONS = [
  'WRONG_SIZE',
  'NOT_AS_DESCRIBED',
  'DAMAGED',
  'DEFECTIVE',
  'WRONG_ITEM',
  'CHANGED_MIND',
  'OTHER',
] as const

export type ReturnReason = (typeof RETURN_REASONS)[number]

/** Value of one unit of a line, net of the discount that line absorbed. */
export function netUnitValue(item: { lineTotal: number; discountAllocated: number; quantity: number }): number {
  if (item.quantity <= 0) return 0
  // Floor so rounding can never refund more than the line was worth in total.
  return Math.floor((item.lineTotal - item.discountAllocated) / item.quantity)
}

export interface ReturnableLine {
  orderItemId: string
  productName: string
  variantName: string | null
  imageUrl: string | null
  purchased: number
  /** Already returned or awaiting a decision. */
  claimed: number
  returnable: number
  unitValue: number
}

/**
 * What is still returnable on an order, and why not if nothing is.
 *
 * Rejected and cancelled requests release their claim; everything else holds
 * it, so a customer cannot open a second request for goods already in a first.
 */
export async function returnableItems(orderId: string): Promise<{
  eligible: boolean
  reason: string | null
  windowClosesAt: Date | null
  lines: ReturnableLine[]
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      returnRequests: { include: { items: true } },
      statusHistory: { where: { toStatus: 'DELIVERED' }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  const claimed = new Map<string, number>()
  for (const request of order.returnRequests) {
    if (request.status === 'REJECTED' || request.status === 'CANCELLED') continue
    for (const item of request.items) {
      claimed.set(item.orderItemId, (claimed.get(item.orderItemId) ?? 0) + item.quantity)
    }
  }

  const lines: ReturnableLine[] = order.items.map((item) => {
    const taken = claimed.get(item.id) ?? 0
    return {
      orderItemId: item.id,
      productName: item.productNameSnapshot,
      variantName: item.variantNameSnapshot,
      imageUrl: item.imageUrlSnapshot,
      purchased: item.quantity,
      claimed: taken,
      returnable: Math.max(0, item.quantity - taken),
      unitValue: netUnitValue(item),
    }
  })

  const deliveredAt = order.statusHistory[0]?.createdAt ?? null
  const windowClosesAt = deliveredAt
    ? new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60_000)
    : null

  if (order.status !== 'DELIVERED') {
    return {
      eligible: false,
      reason: 'Returns open once your order has been delivered',
      windowClosesAt,
      lines,
    }
  }
  if (windowClosesAt && windowClosesAt < new Date()) {
    return {
      eligible: false,
      reason: `The ${RETURN_WINDOW_DAYS}-day return window has closed`,
      windowClosesAt,
      lines,
    }
  }
  if (lines.every((l) => l.returnable === 0)) {
    return {
      eligible: false,
      reason: 'Everything on this order has already been requested for return',
      windowClosesAt,
      lines,
    }
  }

  return { eligible: true, reason: null, windowClosesAt, lines }
}

async function nextReturnNumber(tx: Prisma.TransactionClient): Promise<string> {
  const count = await tx.returnRequest.count()
  return `RET-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`
}

export interface CreateReturnInput {
  orderId: string
  userId: string
  reason: ReturnReason
  comment?: string | null
  images?: string[]
  resolution: 'REFUND' | 'EXCHANGE' | 'STORE_CREDIT'
  items: Array<{ orderItemId: string; quantity: number }>
}

export async function createReturnRequest(input: CreateReturnInput) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: input.orderId, userId: input.userId },
      include: { items: true },
    })
    // Scoped by userId, so another customer's order id is simply not found.
    if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

    const availability = await returnableItems(input.orderId)
    if (!availability.eligible) {
      throw new ConflictError(availability.reason ?? 'This order cannot be returned', 'RETURN_CLOSED')
    }

    if (input.items.length === 0) throw new ValidationError('Choose at least one item to return')

    let refundable = 0
    const itemRows = input.items.map((line) => {
      const available = availability.lines.find((l) => l.orderItemId === line.orderItemId)
      if (!available) throw new ValidationError('That item is not on this order')
      if (line.quantity < 1) throw new ValidationError('Return at least one of each item')
      if (line.quantity > available.returnable) {
        throw new ConflictError(
          available.returnable === 0
            ? `${available.productName} has already been requested for return`
            : `Only ${available.returnable} of ${available.productName} can be returned`,
          'RETURN_QUANTITY',
        )
      }

      // Frozen at request time: a later price edit must not change what this
      // return is worth.
      const amount = available.unitValue * line.quantity
      refundable += amount

      return {
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        refundableAmount: amount,
      }
    })

    const request = await tx.returnRequest.create({
      data: {
        returnNumber: await nextReturnNumber(tx),
        orderId: order.id,
        userId: input.userId,
        reason: input.reason,
        comment: input.comment ?? null,
        images: input.images ?? [],
        resolution: input.resolution,
        status: 'REQUESTED',
        items: { create: itemRows },
        statusHistory: { create: { status: 'REQUESTED', note: 'Return requested' } },
      },
      include: returnDetailInclude,
    })

    return { request, refundable }
  })
}

/**
 * Which transitions are legal. Returns move forward or stop; there is no path
 * back out of a completed or rejected request, because money and stock have
 * already moved by then.
 */
const ALLOWED: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['INSPECTED', 'COMPLETED'],
  INSPECTED: ['COMPLETED', 'REJECTED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
}

export interface TransitionInput {
  returnRequestId: string
  status: ReturnStatus
  note?: string | null
  rejectionReason?: string | null
  actorId: string | null
  /** Applied when moving to RECEIVED or INSPECTED. */
  itemDispositions?: Array<{ returnItemId: string; restock: boolean; condition?: string | null }>
}

export async function transitionReturn(input: TransitionInput) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.returnRequest.findUnique({
      where: { id: input.returnRequestId },
      include: { items: { include: { orderItem: true } }, order: true },
    })
    if (!request) throw new NotFoundError('Return request', 'RETURN_NOT_FOUND')

    if (request.status === input.status) return request

    if (!ALLOWED[request.status].includes(input.status)) {
      throw new ConflictError(
        `A return cannot move from ${request.status} to ${input.status}`,
        'INVALID_RETURN_TRANSITION',
      )
    }

    if (input.status === 'REJECTED' && !input.rejectionReason?.trim()) {
      throw new ValidationError('Tell the customer why the return was declined')
    }

    for (const disposition of input.itemDispositions ?? []) {
      const item = request.items.find((i) => i.id === disposition.returnItemId)
      if (!item) throw new ValidationError('That item is not on this return')

      await tx.returnItem.update({
        where: { id: disposition.returnItemId },
        data: { restock: disposition.restock, condition: disposition.condition ?? null },
      })
    }

    /**
     * Stock goes back on the shelf only when the goods are physically with us
     * and someone has marked the line as resaleable. Restocking on "approved"
     * would sell inventory that is still in the post.
     */
    if (input.status === 'INSPECTED' || input.status === 'COMPLETED') {
      const items = await tx.returnItem.findMany({
        where: { returnRequestId: request.id, restock: true },
        include: { orderItem: true },
      })

      for (const item of items) {
        // The movement references the return *line*, not the whole request, so
        // this lookup is exact — a return that is inspected and then completed
        // must not put the same goods back twice.
        const already = await tx.inventoryMovement.findFirst({
          where: { referenceType: 'RETURN_ITEM', referenceId: item.id },
        })
        if (already) continue

        const variantId = item.orderItem.variantId
        if (!variantId) continue

        const inventory = await tx.inventory.findUnique({ where: { variantId } })
        if (!inventory) continue

        const balanceAfter = inventory.availableStock + item.quantity
        await tx.inventory.update({
          where: { id: inventory.id },
          data: { availableStock: balanceAfter },
        })
        await tx.inventoryMovement.create({
          data: {
            inventoryId: inventory.id,
            type: 'RETURN',
            quantity: item.quantity,
            balanceAfter,
            reason: `Return ${request.returnNumber}`,
            referenceType: 'RETURN_ITEM',
            referenceId: item.id,
            createdById: input.actorId,
          },
        })
      }
    }

    const terminal = input.status === 'COMPLETED' || input.status === 'REJECTED' || input.status === 'CANCELLED'

    return tx.returnRequest.update({
      where: { id: request.id },
      data: {
        status: input.status,
        ...(input.rejectionReason !== undefined ? { rejectionReason: input.rejectionReason } : {}),
        ...(terminal ? { resolvedAt: new Date() } : {}),
        statusHistory: {
          create: {
            status: input.status,
            note: input.note ?? null,
            changedById: input.actorId,
          },
        },
      },
      include: returnDetailInclude,
    })
  })
}

export const returnDetailInclude = {
  items: {
    include: {
      orderItem: {
        select: {
          id: true,
          productNameSnapshot: true,
          variantNameSnapshot: true,
          imageUrlSnapshot: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
          discountAllocated: true,
        },
      },
    },
  },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'desc' } },
  order: { select: { id: true, orderNumber: true, status: true, total: true, currency: true } },
} satisfies Prisma.ReturnRequestInclude
