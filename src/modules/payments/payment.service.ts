import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { emit } from '../../events/bus.js'
import { recordAudit } from '../../utils/audit.js'

/**
 * Marks an order paid — the one place that transition happens.
 *
 * Both the client-callback verification path and the webhook path funnel
 * through here, and both can arrive for the same payment. It is therefore
 * idempotent: if the order is already PAID it returns quietly instead of
 * writing a second history entry or emitting ORDER_PAID twice.
 */
export async function markOrderPaid(input: {
  orderId: string
  providerPaymentId: string
  providerOrderId?: string
  source: 'callback' | 'webhook'
}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    if (!order) return { changed: false, reason: 'ORDER_NOT_FOUND' as const }

    const payment = order.payments[0]
    if (payment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CAPTURED',
          providerPaymentId: input.providerPaymentId,
          providerOrderId: input.providerOrderId ?? payment.providerOrderId,
        },
      })
      await tx.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          type: 'CAPTURE',
          status: 'CAPTURED',
          amount: order.total,
          providerReference: input.providerPaymentId,
          payload: { source: input.source } as Prisma.InputJsonValue,
        },
      })
    }

    // Already paid (or beyond): record the payment detail, change nothing else.
    if (order.status !== 'PENDING_PAYMENT') {
      return { changed: false, reason: 'ALREADY_PROCESSED' as const, order }
    }

    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        statusHistory: {
          create: {
            fromStatus: 'PENDING_PAYMENT',
            toStatus: 'PAID',
            note: `Payment confirmed via ${input.source}`,
          },
        },
      },
    })

    return { changed: true, order: updated }
  })
}

/** Records a failed attempt without touching the order's status. */
export async function markPaymentFailed(input: {
  orderId: string
  providerPaymentId?: string
  reason: string
  source: 'callback' | 'webhook'
}) {
  const payment = await prisma.payment.findFirst({
    where: { orderId: input.orderId },
    orderBy: { createdAt: 'desc' },
  })
  if (!payment) return

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'FAILED',
      failureReason: input.reason,
      providerPaymentId: input.providerPaymentId ?? payment.providerPaymentId,
    },
  })

  await prisma.paymentTransaction.create({
    data: {
      paymentId: payment.id,
      type: 'FAIL',
      status: 'FAILED',
      providerReference: input.providerPaymentId ?? null,
      payload: { reason: input.reason, source: input.source } as Prisma.InputJsonValue,
    },
  })

  // The order stays PENDING_PAYMENT so the customer can retry. Stock remains
  // held against it; cancelling is what releases stock.
  logger.info({ orderId: input.orderId, reason: input.reason }, 'Payment failed')

  // The order number is what the customer recognises, so it is looked up here
  // rather than passed as an empty string for every handler to resolve again.
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { orderNumber: true, userId: true },
  })

  emit('ORDER_FAILED', {
    orderId: input.orderId,
    orderNumber: order?.orderNumber ?? '',
    userId: order?.userId ?? null,
    reason: input.reason,
  })
}

export function announcePaid(order: { id: string; orderNumber: string; userId: string; total: number }) {
  recordAudit({
    action: 'ORDER_PAID',
    entityType: 'Order',
    entityId: order.id,
    metadata: { orderNumber: order.orderNumber, total: order.total },
  })
  emit('ORDER_PAID', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    total: order.total,
  })
}
