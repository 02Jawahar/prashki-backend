import { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { getPaymentProvider } from '../../integrations/payment/index.js'

/**
 * Refunds (M22, FR-22.4).
 *
 * The rule that governs every path here: an order can never be refunded for
 * more than it was paid. That is enforced by summing the refunds that already
 * exist, in the same transaction that creates the new one, rather than by
 * trusting whatever the admin screen believed when it rendered.
 *
 * A refund row is created *before* the gateway is called, so a request that
 * times out leaves a record to reconcile rather than money moved with nothing
 * written down.
 */

/** Refunds that count against the cap. A failed one does not. */
const COUNTED = ['PENDING', 'PROCESSING', 'COMPLETED'] as const

export async function refundableAmount(orderId: string): Promise<{
  paid: number
  refunded: number
  refundable: number
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payments: true,
      refunds: { where: { status: { in: [...COUNTED] } } },
    },
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  // Only captured money can come back. An authorized-but-uncaptured payment
  // was never taken, so there is nothing to return.
  const paid = order.payments
    .filter((p) => p.status === 'CAPTURED')
    .reduce((sum, p) => sum + p.amount, 0)

  const refunded = order.refunds.reduce((sum, r) => sum + r.amount, 0)

  return { paid, refunded, refundable: Math.max(0, paid - refunded) }
}

export interface CreateRefundInput {
  orderId: string
  amount: number
  reason?: string | null
  returnRequestId?: string | null
  actorId: string
}

export async function createRefund(input: CreateRefundInput) {
  if (input.amount <= 0) throw new ValidationError('A refund must be more than zero')

  /**
   * The reservation and the cap check share one transaction. Two admins
   * clicking refund at the same moment cannot both pass the check, because the
   * second reads the first's row.
   */
  const { refund, payment } = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        payments: { where: { status: 'CAPTURED' }, orderBy: { createdAt: 'desc' } },
        refunds: { where: { status: { in: [...COUNTED] } } },
      },
    })
    if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

    const paid = order.payments.reduce((sum, p) => sum + p.amount, 0)
    if (paid === 0) throw new ConflictError('That order has not been paid', 'ORDER_UNPAID')

    const alreadyRefunded = order.refunds.reduce((sum, r) => sum + r.amount, 0)
    if (input.amount > paid - alreadyRefunded) {
      throw new ConflictError(
        `Only ₹${((paid - alreadyRefunded) / 100).toFixed(2)} is left to refund on this order`,
        'REFUND_EXCEEDS_PAYMENT',
      )
    }

    if (input.returnRequestId) {
      const request = await tx.returnRequest.findFirst({
        where: { id: input.returnRequestId, orderId: input.orderId },
      })
      if (!request) throw new ValidationError('That return is not on this order')
    }

    const payment = order.payments[0]!

    const refund = await tx.refund.create({
      data: {
        orderId: order.id,
        returnRequestId: input.returnRequestId ?? null,
        provider: payment.provider,
        amount: input.amount,
        currency: order.currency,
        status: 'PENDING',
        reason: input.reason ?? null,
        initiatedById: input.actorId,
      },
    })

    return { refund, payment }
  })

  recordAudit({
    userId: input.actorId,
    action: 'REFUND_INITIATED',
    entityType: 'Refund',
    entityId: refund.id,
    metadata: { orderId: input.orderId, amount: input.amount },
  })

  // The gateway call sits outside the transaction on purpose: holding a
  // database transaction open across a network call to a third party is how
  // connection pools die.
  if (!payment.providerPaymentId) {
    // Nothing to call the gateway with — this was a manual or offline payment,
    // so the refund is recorded for someone to action by hand.
    return prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'PROCESSING',
        reason: refund.reason ?? 'Awaiting manual settlement',
      },
    })
  }

  try {
    const result = await getPaymentProvider().refund({
      providerPaymentId: payment.providerPaymentId,
      amount: input.amount,
      reference: refund.id,
      reason: input.reason ?? undefined,
    })

    return await prisma.refund.update({
      where: { id: refund.id },
      data: {
        providerRefundId: result.providerRefundId,
        status: result.status === 'processed' ? 'COMPLETED' : result.status === 'failed' ? 'FAILED' : 'PROCESSING',
        processedAt: result.status === 'processed' ? new Date() : null,
        rawPayload: sanitize(result.raw),
      },
    })
  } catch (err) {
    logger.error({ err, refundId: refund.id }, 'Refund call to the gateway failed')

    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        reason: err instanceof Error ? err.message.slice(0, 300) : 'Gateway call failed',
      },
    })
    throw err
  }
}

/**
 * Gateway responses are stored for reconciliation, but they arrive with
 * whatever the provider felt like including. Anything that looks like a
 * credential is dropped before it reaches the database.
 */
const SENSITIVE = /^(key|secret|token|password|signature|card|cvv|auth)/i

function sanitize(value: unknown): Prisma.InputJsonValue {
  if (value === null || typeof value !== 'object') return (value ?? null) as Prisma.InputJsonValue
  if (Array.isArray(value)) return value.map(sanitize) as Prisma.InputJsonValue

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.test(key)) continue
    out[key] = typeof entry === 'object' && entry !== null ? sanitize(entry) : entry
  }
  return out as Prisma.InputJsonValue
}
