import { Prisma } from '@prisma/client'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { env } from '../../config/env.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { percentOf } from '../../utils/money.js'
import { emit } from '../../events/bus.js'
import { findSpendable, redeem as redeemGiftCard } from '../giftcards/giftcard.service.js'
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
  /** A gift card code the customer entered at checkout. */
  giftCardCode?: string | null
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
              /** The set a line came from, so the order keeps its name. */
              set: { select: { name: true } },
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

        /**
         * A line that came from a set is charged its share of the set price.
         * Same rule as the bag — if these two ever disagree, the customer is
         * shown one figure and billed another.
         */
        const unitPrice = item.setUnitPrice ?? variant.price ?? product.price
        return {
          cartItemId: item.id,
          setGroupId: item.setGroupId,
          setNameSnapshot: item.set?.name ?? null,
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
       * Parcel weight decides which rate band applies, so it is computed from
       * the same cart lines the order is being built from rather than read
       * back afterwards.
       */
      const weightGrams = cart.items.reduce(
        (total, item) =>
          total +
          (item.variant.weightGrams ?? env.SHIPPING_DEFAULT_ITEM_WEIGHT_GRAMS) * item.quantity,
        0,
      )

      /**
       * A configured method wins; the settings flat rate is the fallback for a
       * store with no zones set up yet. Either way the amount is computed here,
       * server-side, from the address the order is actually going to — and it
       * throws rather than falling back if the address is not serviceable.
       */
      const quote = input.shippingMethodId
        ? await priceChosenMethod(input.shippingMethodId, {
            country: address.country,
            state: address.state,
            postalCode: address.postalCode,
            subtotal: subtotal - discount,
            weightGrams,
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

      /**
       * A gift card is payment, not discount. It comes off what is owed after
       * tax rather than off the goods value, so the tax on a part-gifted order
       * is the same as on the identical order paid in full — which is what the
       * tax actually is. Treating it as a discount would quietly under-collect.
       */
      const card = input.giftCardCode ? await findSpendable(input.giftCardCode) : null

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
          ...(card ? { giftCardId: card.id, giftCardCode: card.code } : {}),
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

      /**
       * Redeemed inside the same transaction that created the order. If either
       * fails, both roll back — the alternative is a customer whose card is
       * empty and whose order does not exist.
       *
       * `redeem` returns what it could actually take, which may be less than
       * the total: a card smaller than the order pays what it has and the rest
       * is owed at the gateway.
       */
      if (card) {
        const applied = await redeemGiftCard(tx, card.id, total, order.id)
        await tx.order.update({ where: { id: order.id }, data: { giftCardAmount: applied } })
        order.giftCardAmount = applied
      }

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

/**
 * Puts a cancelled order's gift card money back, inside the caller's
 * transaction.
 *
 * Separate from `refundToCard` in the gift card service, which opens its own
 * transaction for use from a webhook. Here the credit has to share the
 * cancellation's transaction or a rolled-back cancel would leave the card
 * credited for an order that is still live.
 */
async function restoreGiftCard(
  tx: Prisma.TransactionClient,
  order: { id: string; giftCardId: string | null; giftCardAmount: number; orderNumber: string },
  actorId: string | null,
): Promise<void> {
  if (!order.giftCardId) return

  const alreadyBack = await tx.giftCardTransaction.count({
    where: { orderId: order.id, type: 'REFUND' },
  })
  if (alreadyBack > 0) return

  const card = await tx.giftCard.findUnique({ where: { id: order.giftCardId } })
  if (!card) return

  const balanceAfter = card.balance + order.giftCardAmount

  await tx.giftCard.update({
    where: { id: card.id },
    data: {
      balance: balanceAfter,
      // A card emptied by this order becomes spendable again.
      status: card.status === 'REDEEMED' ? 'ACTIVE' : card.status,
    },
  })

  await tx.giftCardTransaction.create({
    data: {
      giftCardId: card.id,
      type: 'REFUND',
      amount: order.giftCardAmount,
      balanceAfter,
      orderId: order.id,
      actorId,
      note: `Cancelled order ${order.orderNumber}`,
    },
  })
}

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

    /**
     * And the same for a gift card. This is the customer's money rather than a
     * discount, so losing it to a cancellation would be taking it — the ledger
     * entry is what proves it went back.
     *
     * Inside the transaction, so the cancellation and the credit stand or fall
     * together. It is idempotent on the order, because a cancel that is
     * retried must not pay the card twice.
     */
    if (order.giftCardId && order.giftCardAmount > 0) {
      await restoreGiftCard(tx, order, actorId)
    }

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

  /**
   * Marking an order paid by hand is a real payment — cash on delivery, a bank
   * transfer, a card taken over the phone — so it fires the same event the
   * gateway does. Without this the customer gets no confirmation and a gift
   * card bought that way is never activated, which was exactly the symptom:
   * the order said PAID and the card sat PENDING for ever.
   *
   * `markOrderPaid` in the payment service emits this for the gateway path and
   * is idempotent on an already-paid order, so the two cannot both fire: this
   * branch only runs on a transition *into* PAID.
   */
  if (next === 'PAID') {
    emit('ORDER_PAID', {
      orderId,
      orderNumber: updated.orderNumber,
      userId: updated.userId,
      total: updated.total,
    })
  }
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
