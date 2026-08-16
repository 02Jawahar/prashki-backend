import { Prisma } from '@prisma/client'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { percentOf } from '../../utils/money.js'
import { emit } from '../../events/bus.js'
import { recordAudit } from '../../utils/audit.js'
import { evaluateCoupon, recordRedemption, releaseRedemption } from '../coupons/coupon.service.js'
import { priceChosenMethod } from '../shipping/shipping.service.js'

/**
 * Order creation (spec §25, §50).
 *
 * Everything below happens inside one transaction: totals, order rows, stock
 * decrement, movement ledger, payment record and cart clearing. If any step
 * fails the whole thing rolls back — an order can never exist with stock
 * unaccounted for, and stock can never be consumed without an order.
 *
 * Prices are read from the database at this moment and snapshotted onto the
 * order lines. Nothing the client sent is trusted (spec §70 rule 1).
 */

export interface CreateOrderInput {
  userId: string
  addressId: string
  notes?: string
  /**
   * Optional so the settings-based flat rate still works for a store that has
   * not configured zones. When present it is re-validated against the delivery
   * address — the client picks an id, never a price.
   */
  shippingMethodId?: string
}

/** Store-wide charges live in settings, not in code (spec §37). */
async function loadCharges() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['tax.default_percent', 'shipping.default_fee', 'shipping.free_threshold'] } },
  })
  const get = (key: string, fallback = 0) => {
    const value = rows.find((r) => r.key === key)?.value
    const n = value === undefined ? NaN : Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  return {
    taxPercent: get('tax.default_percent'),
    shippingFee: get('shipping.default_fee'),
    freeShippingThreshold: get('shipping.free_threshold'),
  }
}

export async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const count = await tx.order.count()
  const year = new Date().getFullYear()
  return `ORD-${year}-${String(count + 1).padStart(5, '0')}`
}

export async function createOrder(input: CreateOrderInput) {
  const charges = await loadCharges()

  return prisma.$transaction(
    async (tx) => {
      const cart = await tx.cart.findUnique({
        where: { userId: input.userId },
        include: {
          items: {
            include: {
              variant: {
                include: {
                  inventory: true,
                  product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
                },
              },
            },
          },
        },
      })

      if (!cart || cart.items.length === 0) {
        throw new ValidationError('Your bag is empty')
      }

      const address = await tx.address.findFirst({
        where: { id: input.addressId, userId: input.userId },
      })
      if (!address) throw new NotFoundError('Address', 'ADDRESS_NOT_FOUND')

      // ---- price and validate every line from the database ----
      const priced = cart.items.map((item) => {
        const { variant } = item
        const { product } = variant

        if (product.status !== 'ACTIVE' || variant.status !== 'ACTIVE') {
          throw new ConflictError(`${product.name} is no longer available`, 'ITEM_UNAVAILABLE')
        }

        const stock = variant.inventory?.availableStock ?? 0
        if (stock < item.quantity) {
          throw new ConflictError(
            stock === 0
              ? `${product.name} (${variant.name}) is out of stock`
              : `Only ${stock} of ${product.name} (${variant.name}) left`,
            'INSUFFICIENT_STOCK',
          )
        }

        const unitPrice = variant.price ?? product.price
        return {
          cartItemId: item.id,
          categoryId: product.categoryId,
          isDiscounted: product.compareAtPrice !== null && product.compareAtPrice > unitPrice,
          variantId: variant.id,
          productId: product.id,
          productNameSnapshot: product.name,
          variantNameSnapshot: variant.name,
          sku: variant.sku,
          imageUrlSnapshot: product.images[0]?.url ?? null,
          unitPrice,
          quantity: item.quantity,
          lineTotal: unitPrice * item.quantity,
        }
      })

      const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0)

      /**
       * The coupon is re-evaluated here, not carried over from the cart read.
       * Between adding the code and pressing pay, it may have expired, been
       * paused, hit its limit, or stopped matching the bag — and the customer
       * may have edited the bag itself. Only this evaluation decides the money.
       */
      const evaluation = cart.couponCode
        ? await evaluateCoupon({
            code: cart.couponCode,
            userId: input.userId,
            subtotal,
            lines: priced.map((l) => ({
              id: l.cartItemId,
              productId: l.productId,
              categoryIds: l.categoryId ? [l.categoryId] : [],
              unitPrice: l.unitPrice,
              quantity: l.quantity,
              lineTotal: l.lineTotal,
              isDiscounted: l.isDiscounted,
            })),
          })
        : null

      const discount = evaluation?.discount ?? 0

      const lines = priced.map(({ cartItemId, categoryId: _c, isDiscounted: _d, ...line }) => ({
        ...line,
        discountAllocated: evaluation?.allocation[cartItemId] ?? 0,
      }))

      const shippingWaived = evaluation?.freeShipping ?? false

      /**
       * A configured method wins; the settings flat rate is the fallback for a
       * store with no zones set up yet. Either way the amount is computed here,
       * server-side, from the address the order is actually going to.
       */
      const quote = input.shippingMethodId
        ? await priceChosenMethod(input.shippingMethodId, {
            country: address.country,
            state: address.state,
            postalCode: address.postalCode,
            subtotal: subtotal - discount,
            freeShippingCoupon: shippingWaived,
          })
        : null

      const shipping = quote
        ? quote.cost + (quote.isCod ? quote.codFee : 0)
        : shippingWaived
          ? 0
          : charges.freeShippingThreshold > 0 && subtotal >= charges.freeShippingThreshold
            ? 0
            : charges.shippingFee
      // Tax follows the discounted goods value — charging tax on money the
      // customer never paid would overcharge them.
      const tax = percentOf(subtotal - discount, charges.taxPercent)
      const total = subtotal - discount + shipping + tax

      const order = await tx.order.create({
        data: {
          orderNumber: await nextOrderNumber(tx),
          userId: input.userId,
          status: 'PENDING_PAYMENT',
          subtotal,
          discount,
          shipping,
          tax,
          total,
          currency: 'INR',
          notes: input.notes ?? null,
          ...(evaluation
            ? { couponId: evaluation.coupon.id, couponCode: evaluation.coupon.code }
            : {}),
          ...(quote ? { shippingMethodId: quote.id, shippingMethodName: quote.name } : {}),
          // Frozen copy — the address row may be edited or deleted later.
          shippingAddressSnapshot: {
            name: address.name,
            phone: address.phone,
            addressLine1: address.addressLine1,
            addressLine2: address.addressLine2,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
          },
          items: { create: lines },
          statusHistory: {
            create: { toStatus: 'PENDING_PAYMENT', note: 'Order created' },
          },
        },
        include: { items: true },
      })

      // ---- consume stock, with a ledger entry for each movement ----
      for (const item of cart.items) {
        const inventory = item.variant.inventory
        if (!inventory) throw new NotFoundError('Inventory record', 'INVENTORY_NOT_FOUND')

        const balanceAfter = inventory.availableStock - item.quantity
        // Belt and braces: the check above already covered this, but a
        // concurrent order could have consumed stock in between.
        if (balanceAfter < 0) {
          throw new ConflictError(
            `${item.variant.product.name} sold out while you were checking out`,
            'INSUFFICIENT_STOCK',
          )
        }

        await tx.inventory.update({
          where: { id: inventory.id },
          data: { availableStock: balanceAfter },
        })

        await tx.inventoryMovement.create({
          data: {
            inventoryId: inventory.id,
            type: 'SALE',
            quantity: -item.quantity,
            balanceAfter,
            reason: `Order ${order.orderNumber}`,
            referenceType: 'ORDER',
            referenceId: order.id,
          },
        })
      }

      await tx.payment.create({
        data: {
          orderId: order.id,
          provider: process.env.PAYMENT_PROVIDER ?? 'mock',
          amount: total,
          currency: 'INR',
          status: 'CREATED',
        },
      })

      if (evaluation) {
        await recordRedemption(tx, {
          coupon: evaluation.coupon,
          userId: input.userId,
          orderId: order.id,
          amount: discount,
        })
      }

      // The cart has become an order; clearing it prevents a double submit.
      await tx.cart.update({
        where: { id: cart.id },
        data: { couponCode: null, items: { deleteMany: {} } },
      })

      return order
    },
    // Stock decrements must not interleave with another checkout's reads.
    { isolationLevel: 'Serializable', timeout: 15_000 },
  )
}

/**
 * How long an in-flight checkout blocks a retry with the same key. Long enough
 * that a slow payment page cannot double-submit, short enough that a genuinely
 * crashed attempt does not strand the customer.
 */
const CHECKOUT_SESSION_TTL_MS = 30 * 60_000

export interface IdempotentOrderResult {
  order: Awaited<ReturnType<typeof createOrder>>
  /** True when this request returned an order a previous request had created. */
  replayed: boolean
}

/**
 * Checkout submit, made safe to retry (FR-8.7).
 *
 * A double-clicked "Place order", a flaky connection retried by the browser, or
 * a mobile app resending after a timeout must all end with *one* order and one
 * stock decrement. The client sends an idempotency key; this function makes the
 * key the thing that owns the order.
 *
 * The unique constraint on `idempotencyKey` is what actually enforces this —
 * two simultaneous requests race to insert, one wins, the loser reads the
 * winner's row. Checking first and inserting after would leave a gap.
 */
export async function createOrderIdempotent(
  input: CreateOrderInput & { idempotencyKey?: string },
): Promise<IdempotentOrderResult> {
  const { idempotencyKey, ...orderInput } = input

  if (!idempotencyKey) {
    return { order: await createOrder(orderInput), replayed: false }
  }

  const now = new Date()
  let sessionId: string

  try {
    const session = await prisma.checkoutSession.create({
      data: {
        idempotencyKey,
        userId: orderInput.userId,
        status: 'started',
        payload: { addressId: orderInput.addressId },
        expiresAt: new Date(now.getTime() + CHECKOUT_SESSION_TTL_MS),
      },
    })
    sessionId = session.id
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err

    const existing = await prisma.checkoutSession.findUnique({
      where: { idempotencyKey },
      include: { order: { include: { items: true } } },
    })
    // The row must exist — we just collided with it — but a concurrent cleanup
    // could have removed it, in which case there is nothing to replay.
    if (!existing) throw err

    // A key is scoped to the customer who minted it. Someone else presenting it
    // gets the same answer as any other bad key, never a peek at the order.
    if (existing.userId !== orderInput.userId) {
      throw new ValidationError('That checkout could not be completed')
    }

    if (existing.order) {
      return { order: existing.order, replayed: true }
    }

    if (existing.status === 'started' && existing.expiresAt > now) {
      throw new ConflictError(
        'That order is already being placed — hold on a moment',
        'CHECKOUT_IN_PROGRESS',
      )
    }

    // A failed or timed-out attempt is allowed to be retried under the same key.
    await prisma.checkoutSession.update({
      where: { id: existing.id },
      data: {
        status: 'started',
        error: null,
        expiresAt: new Date(now.getTime() + CHECKOUT_SESSION_TTL_MS),
      },
    })
    sessionId = existing.id
  }

  try {
    const order = await createOrder(orderInput)
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { status: 'completed', orderId: order.id },
    })
    return { order, replayed: false }
  } catch (err) {
    await prisma.checkoutSession
      .update({
        where: { id: sessionId },
        data: { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' },
      })
      // Recording the failure must not replace the failure the caller needs.
      .catch(() => undefined)
    throw err
  }
}

/** Restores stock for a cancelled order, once. */
export async function cancelOrder(orderId: string, actorId: string | null, note?: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    })
    if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

    if (order.status === 'CANCELLED') {
      throw new ConflictError('That order is already cancelled', 'ALREADY_CANCELLED')
    }
    if (order.status === 'DELIVERED') {
      throw new ConflictError('A delivered order cannot be cancelled', 'ORDER_DELIVERED')
    }

    for (const item of order.items) {
      if (!item.variantId) continue
      const inventory = await tx.inventory.findUnique({ where: { variantId: item.variantId } })
      if (!inventory) continue

      const balanceAfter = inventory.availableStock + item.quantity
      await tx.inventory.update({ where: { id: inventory.id }, data: { availableStock: balanceAfter } })
      await tx.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'RETURN',
          quantity: item.quantity,
          balanceAfter,
          reason: `Cancelled order ${order.orderNumber}`,
          referenceType: 'ORDER',
          referenceId: order.id,
          createdById: actorId,
        },
      })
    }

    // A cancelled order gives its coupon use back, so a customer whose order
    // fell through is not left having spent a single-use code on nothing.
    await releaseRedemption(tx, orderId)

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus: 'CANCELLED',
            note: note ?? 'Order cancelled',
            changedById: actorId,
          },
        },
      },
    })

    return updated
  })
}

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
}

export async function updateOrderStatus(
  orderId: string,
  next: OrderStatus,
  actorId: string | null,
  note?: string,
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) throw new NotFoundError('Order', 'ORDER_NOT_FOUND')

  if (order.status === next) return order

  // Cancelling restores stock, so it goes through its own path.
  if (next === 'CANCELLED') {
    const cancelled = await cancelOrder(orderId, actorId, note)
    emit('ORDER_CANCELLED', { orderId, orderNumber: cancelled.orderNumber })
    return cancelled
  }

  if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
    throw new ConflictError(
      `Cannot move an order from ${order.status} to ${next}`,
      'INVALID_STATUS_TRANSITION',
    )
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: next,
      statusHistory: {
        create: { fromStatus: order.status, toStatus: next, note: note ?? null, changedById: actorId },
      },
    },
  })

  recordAudit({
    userId: actorId,
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'Order',
    entityId: orderId,
    metadata: { from: order.status, to: next },
  })

  if (next === 'SHIPPED') emit('ORDER_SHIPPED', { orderId, orderNumber: updated.orderNumber })
  if (next === 'DELIVERED') emit('ORDER_DELIVERED', { orderId, orderNumber: updated.orderNumber })

  return updated
}

export const orderDetailInclude = {
  items: true,
  statusHistory: { orderBy: { createdAt: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' } },
  user: { select: { id: true, name: true, email: true, phone: true } },
} satisfies Prisma.OrderInclude
