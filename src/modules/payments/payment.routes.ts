import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { ok } from '../../utils/response.js'
import { ConflictError, NotFoundError, PaymentError } from '../../utils/errors.js'
import { getPaymentProvider } from '../../integrations/payment/index.js'
import { announcePaid, markOrderPaid, markPaymentFailed } from './payment.service.js'

/** Customer payment endpoints (spec §31). */
export const paymentRouter: Router = Router()

paymentRouter.use(requireAuth)

const createSchema = z.object({ orderId: z.string().trim().min(1) })

/**
 * Creates the provider-side order.
 *
 * The amount comes from our order row, never from the request — the client
 * cannot ask to pay less than the order is worth.
 */
paymentRouter.post('/create', writeLimiter, validate({ body: createSchema }), async (req, res) => {
  const { orderId } = req.validated!.body as z.infer<typeof createSchema>

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: req.user!.id },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  if (order.status !== 'PENDING_PAYMENT') {
    throw new ConflictError('That order is not awaiting payment', 'ORDER_NOT_PAYABLE')
  }

  const provider = getPaymentProvider()
  const providerOrder = await provider.createOrder({
    orderId: order.id,
    orderNumber: order.orderNumber,
    amount: order.total,
    currency: order.currency,
    customerEmail: req.user!.email,
    customerName: req.user!.name,
  })

  const payment = order.payments[0]
  if (payment) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { provider: provider.name, providerOrderId: providerOrder.providerOrderId },
    })
    await prisma.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        type: 'CREATE',
        status: 'CREATED',
        amount: order.total,
        providerReference: providerOrder.providerOrderId,
      },
    })
  }

  return ok(res, {
    provider: provider.name,
    providerOrderId: providerOrder.providerOrderId,
    amount: providerOrder.amount,
    currency: providerOrder.currency,
    // Publishable key only. The secret never leaves the server.
    publicKey: providerOrder.publicKey,
    orderNumber: order.orderNumber,
  })
})

const verifySchema = z.object({
  orderId: z.string().trim().min(1),
  providerOrderId: z.string().trim().min(1),
  providerPaymentId: z.string().trim().min(1),
  signature: z.string().trim().min(1),
})

/**
 * Verifies the client-side payment callback.
 *
 * A "success" from the browser proves nothing on its own — the order only moves
 * to PAID once the HMAC signature verifies here (spec §31). The webhook is the
 * authoritative confirmation; this exists so the customer gets an immediate
 * answer rather than waiting on delivery.
 */
paymentRouter.post('/verify', writeLimiter, validate({ body: verifySchema }), async (req, res) => {
  const input = req.validated!.body as z.infer<typeof verifySchema>

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId: req.user!.id },
  })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  const provider = getPaymentProvider()
  const result = await provider.verifyPayment({
    providerOrderId: input.providerOrderId,
    providerPaymentId: input.providerPaymentId,
    signature: input.signature,
  })

  if (!result.valid) {
    await markPaymentFailed({
      orderId: order.id,
      providerPaymentId: input.providerPaymentId,
      reason: result.reason ?? 'Signature verification failed',
      source: 'callback',
    })
    throw new PaymentError('Payment could not be verified', 'SIGNATURE_INVALID')
  }

  const outcome = await markOrderPaid({
    orderId: order.id,
    providerPaymentId: input.providerPaymentId,
    providerOrderId: input.providerOrderId,
    source: 'callback',
  })

  if (outcome.changed && outcome.order) {
    announcePaid({
      id: outcome.order.id,
      orderNumber: outcome.order.orderNumber,
      userId: outcome.order.userId,
      total: outcome.order.total,
    })
  }

  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  return ok(res, { verified: true, orderNumber: fresh.orderNumber, status: fresh.status })
})
