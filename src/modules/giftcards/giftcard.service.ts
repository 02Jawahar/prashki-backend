import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { nextOrderNumber } from '../orders/order.service.js'
import { type GiftCardConfig, readGiftCardConfig } from './giftcard.config.js'

/**
 * Gift cards (M13) — stored value bought by one person and spent by another.
 *
 * Two rules hold everywhere in this file:
 *
 *   Money only moves inside a transaction that re-reads the balance. A gift
 *   card is the one object in the store two people can spend at once — the
 *   buyer and whoever they sent the code to — and a read-then-write outside a
 *   transaction lets both of them spend the same rupee.
 *
 *   Every movement writes a ledger row. The balance column is what checkout
 *   reads; the ledger is what answers "where did it go" three months later.
 */

/**
 * Codes are shown to people, read aloud, and typed from a phone screen, so the
 * alphabet drops the characters that are argued over: no O or 0, no I or 1, no
 * S or 5. What is left is unambiguous in every font this will be rendered in.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789'

function segment(length: number): string {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

/** PK-7Q4M-2XKD — grouped, because a twelve-character run is misread. */
export function generateCode(): string {
  return `PK-${segment(4)}-${segment(4)}`
}

/**
 * What may be bought, and for how long it lasts, now live in settings — see
 * `giftcard.config.ts`. They are read per call rather than held here so an
 * editor changing an amount in admin changes what the server will accept, not
 * only what the page displays.
 */

function expiryFromNow(years: number): Date {
  const at = new Date()
  at.setFullYear(at.getFullYear() + years)
  return at
}

/**
 * The server decides what a gift card may cost.
 *
 * A price posted from the browser is a number the customer chose, and this is
 * the one endpoint on the site where that would hand out money. Callers that
 * already hold the config pass it in; the rest read it.
 */
export async function assertPurchasableAmount(
  paise: number,
  config?: GiftCardConfig,
): Promise<void> {
  if (!Number.isInteger(paise)) {
    throw new ValidationError('That is not a valid amount')
  }

  const { denominations, custom } = config ?? (await readGiftCardConfig())
  if (denominations.includes(paise)) return

  if (paise < custom.min || paise > custom.max) {
    throw new ValidationError(
      `A gift card can be between ₹${(custom.min / 100).toLocaleString('en-IN')} and ₹${(custom.max / 100).toLocaleString('en-IN')}`,
      { code: 'AMOUNT_OUT_OF_RANGE' },
    )
  }
  // Whole rupees. A card for ₹2,000.37 is a rounding error someone typed.
  if (paise % 100 !== 0) {
    throw new ValidationError('Enter a whole number of rupees', { code: 'AMOUNT_NOT_WHOLE' })
  }
}

export interface IssueInput {
  amount: number
  purchaserId?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  message?: string | null
  orderId?: string | null
  /** An admin issuing by hand; recorded on the ledger row. */
  actorId?: string | null
  note?: string | null
  /** PENDING until the order that bought it is paid. */
  active?: boolean
}

export async function issueGiftCard(input: IssueInput) {
  const config = await readGiftCardConfig()
  await assertPurchasableAmount(input.amount, config)

  const expiresAt = expiryFromNow(config.validForYears)

  /**
   * Retried rather than assumed unique. The odds of a collision are tiny, but
   * "tiny" over a long enough life is a customer holding a code that belongs to
   * someone else's money.
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    try {
      return await prisma.$transaction(async (tx) => {
        const card = await tx.giftCard.create({
          data: {
            code,
            initialValue: input.amount,
            balance: input.amount,
            status: input.active ? 'ACTIVE' : 'PENDING',
            purchaserId: input.purchaserId ?? null,
            recipientName: input.recipientName ?? null,
            recipientEmail: input.recipientEmail ?? null,
            message: input.message ?? null,
            orderId: input.orderId ?? null,
            expiresAt,
            issuedAt: input.active ? new Date() : null,
          },
        })

        await tx.giftCardTransaction.create({
          data: {
            giftCardId: card.id,
            type: 'ISSUE',
            amount: input.amount,
            balanceAfter: input.amount,
            orderId: input.orderId ?? null,
            actorId: input.actorId ?? null,
            note: input.note ?? null,
          },
        })

        return card
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') continue
      throw err
    }
  }

  throw new ConflictError('Could not allocate a gift card code', 'CODE_COLLISION')
}

export interface PurchaseInput {
  userId: string
  amount: number
  recipientName?: string | null
  recipientEmail?: string | null
  message?: string | null
}

/**
 * Buys a gift card: an order for it, and a card held pending until it is paid.
 *
 * Deliberately not routed through the cart. A cart line is a variant at a fixed
 * price, and a gift card is an arbitrary amount bought for a named person with
 * a note attached — modelling that as a variant would mean a row per possible
 * value, or a nullable price on every cart line in the shop.
 *
 * It is also a different kind of purchase. Mixing a digital card with garments
 * in one order gives you an order that is part shipped and part emailed, which
 * every downstream screen then has to special-case.
 *
 * No tax and no shipping. A gift card is not a sale of goods — it is money
 * changing hands, and the tax is charged when the card is spent on something.
 * Taxing it here would tax the same rupee twice.
 */
export async function purchaseGiftCard(input: PurchaseInput) {
  const config = await readGiftCardConfig()
  await assertPurchasableAmount(input.amount, config)

  return prisma.$transaction(async (tx) => {
    const orderNumber = await nextOrderNumber(tx)

    const order = await tx.order.create({
      data: {
        orderNumber,
        userId: input.userId,
        status: 'PENDING_PAYMENT',
        subtotal: input.amount,
        discount: 0,
        shipping: 0,
        tax: 0,
        total: input.amount,
        currency: 'INR',
        /**
         * There is nowhere to ship a gift card, but the column is not nullable
         * and the snapshot is what every order screen renders. An explicit
         * "digital" marker reads better than a blank card in the admin.
         */
        shippingAddressSnapshot: {
          name: input.recipientName ?? 'Digital delivery',
          phone: '',
          addressLine1: 'Sent by email',
          addressLine2: null,
          city: '',
          state: '',
          postalCode: '',
          country: 'IN',
        },
        items: {
          create: {
            productId: null,
            variantId: null,
            productNameSnapshot: 'Gift card',
            variantNameSnapshot: null,
            sku: 'GIFT-CARD',
            unitPrice: input.amount,
            quantity: 1,
            lineTotal: input.amount,
          },
        },
        statusHistory: {
          create: { toStatus: 'PENDING_PAYMENT', note: 'Gift card purchased' },
        },
      },
      include: { items: true },
    })

    // Pending: it carries no spendable balance until the order is paid for.
    const card = await tx.giftCard.create({
      data: {
        code: generateCode(),
        initialValue: input.amount,
        balance: input.amount,
        status: 'PENDING',
        purchaserId: input.userId,
        recipientName: input.recipientName ?? null,
        recipientEmail: input.recipientEmail ?? null,
        message: input.message ?? null,
        orderId: order.id,
        expiresAt: expiryFromNow(config.validForYears),
      },
    })

    await tx.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        type: 'ISSUE',
        amount: input.amount,
        balanceAfter: input.amount,
        orderId: order.id,
        note: `Bought on ${orderNumber}`,
      },
    })

    return { order, giftCard: card }
  })
}

/** Flips a card live once the order that bought it is paid for. */
export async function activateForOrder(orderId: string): Promise<number> {
  const pending = await prisma.giftCard.findMany({ where: { orderId, status: 'PENDING' } })
  if (pending.length === 0) return 0

  await prisma.giftCard.updateMany({
    where: { orderId, status: 'PENDING' },
    data: { status: 'ACTIVE', issuedAt: new Date() },
  })

  return pending.length
}

export interface CardSummary {
  id: string
  code: string
  balance: number
  currency: string
  expiresAt: Date | null
}

/**
 * Looks a card up for checkout.
 *
 * Every refusal is the same shape on purpose. An endpoint that says "expired"
 * for one code and "no such card" for another is a way to test codes: the
 * difference tells you which guesses were real.
 */
export async function findSpendable(code: string): Promise<CardSummary> {
  const card = await prisma.giftCard.findUnique({ where: { code: code.trim().toUpperCase() } })

  const unusable =
    !card ||
    card.status !== 'ACTIVE' ||
    card.balance <= 0 ||
    (card.expiresAt !== null && card.expiresAt < new Date())

  if (unusable) {
    // One message for every reason. An endpoint that distinguishes "expired"
    // from "no such card" is a way to test guesses: the difference tells the
    // guesser which codes are real.
    throw new ValidationError('That gift card code is not valid', { code: 'GIFT_CARD_INVALID' })
  }

  return {
    id: card.id,
    code: card.code,
    balance: card.balance,
    currency: card.currency,
    expiresAt: card.expiresAt,
  }
}

/**
 * Takes money off a card, inside the caller's transaction.
 *
 * Deliberately takes a transaction client rather than opening its own: the
 * redemption and the order it pays for have to commit or fail together, or a
 * failed order leaves the customer's card drained.
 *
 * Returns what was actually taken, which may be less than asked for — a card
 * with less on it than the order costs pays what it can and the rest is owed.
 */
export async function redeem(
  tx: Prisma.TransactionClient,
  giftCardId: string,
  wanted: number,
  orderId: string,
): Promise<number> {
  const card = await tx.giftCard.findUnique({ where: { id: giftCardId } })
  if (!card || card.status !== 'ACTIVE') {
    throw new ValidationError('That gift card is no longer usable', { code: 'GIFT_CARD_INVALID' })
  }
  if (card.expiresAt !== null && card.expiresAt < new Date()) {
    throw new ValidationError('That gift card has expired', { code: 'GIFT_CARD_EXPIRED' })
  }

  const taken = Math.min(card.balance, wanted)
  if (taken <= 0) {
    throw new ValidationError('That gift card has nothing left on it', { code: 'GIFT_CARD_EMPTY' })
  }

  const balanceAfter = card.balance - taken

  await tx.giftCard.update({
    where: { id: giftCardId },
    data: {
      balance: balanceAfter,
      // A spent card is not deleted. It stays as the record of what it paid for.
      status: balanceAfter === 0 ? 'REDEEMED' : 'ACTIVE',
    },
  })

  await tx.giftCardTransaction.create({
    data: {
      giftCardId,
      type: 'REDEEM',
      amount: -taken,
      balanceAfter,
      orderId,
    },
  })

  return taken
}

/**
 * Puts money back after a cancellation or refund.
 *
 * Idempotent on the order: cancelling an already-cancelled order, or a webhook
 * arriving twice, must not credit the card twice. The ledger is what makes that
 * checkable, which is the second reason it exists.
 */
export async function refundToCard(orderId: string, note?: string): Promise<number> {
  const spent = await prisma.giftCardTransaction.findMany({
    where: { orderId, type: 'REDEEM' },
  })
  if (spent.length === 0) return 0

  const alreadyBack = await prisma.giftCardTransaction.findMany({
    where: { orderId, type: 'REFUND' },
  })
  if (alreadyBack.length > 0) {
    logger.info({ orderId }, 'Gift card already refunded for this order — skipping')
    return 0
  }

  let total = 0

  await prisma.$transaction(async (tx) => {
    for (const row of spent) {
      const amount = Math.abs(row.amount)
      const card = await tx.giftCard.findUnique({ where: { id: row.giftCardId } })
      if (!card) continue

      const balanceAfter = card.balance + amount

      await tx.giftCard.update({
        where: { id: card.id },
        data: {
          balance: balanceAfter,
          // A card emptied by the cancelled order becomes usable again.
          status: card.status === 'REDEEMED' ? 'ACTIVE' : card.status,
        },
      })

      await tx.giftCardTransaction.create({
        data: {
          giftCardId: card.id,
          type: 'REFUND',
          amount,
          balanceAfter,
          orderId,
          note: note ?? 'Order cancelled',
        },
      })

      total += amount
    }
  })

  logger.info({ orderId, total }, 'Gift card balance restored')
  return total
}
