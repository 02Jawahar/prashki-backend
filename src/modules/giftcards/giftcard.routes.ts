import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import {
  giftCardConfigSchema,
  readGiftCardConfig,
  validityLine,
  writeGiftCardConfig,
} from './giftcard.config.js'
import {
  assertPurchasableAmount,
  findSpendable,
  issueGiftCard,
  purchaseGiftCard,
} from './giftcard.service.js'

/**
 * Gift cards (M13).
 *
 * The public surface is deliberately thin: what you can buy, and what a code is
 * worth. Everything that moves money lives behind checkout or the admin, so
 * there is no unauthenticated endpoint that changes a balance.
 */

export const giftCardRouter: Router = Router()

/** What the gift card page offers. Server-owned, so a posted price is refused. */
giftCardRouter.get('/options', async (_req, res) => {
  const config = await readGiftCardConfig()

  return ok(res, {
    denominations: config.denominations,
    custom: config.custom,
    currency: 'INR',
    validForYears: config.validForYears,
    heading: config.heading,
    intro: config.intro,
    /**
     * Validity first and generated, then whatever the store added. The one
     * sentence that must agree with `validForYears` is not one anybody types.
     */
    terms: [validityLine(config.validForYears), ...config.terms],
  })
})

const balanceSchema = z.object({ code: z.string().trim().min(4).max(40) })

/**
 * What a code is worth.
 *
 * Rate-limited and signed-in only. An open balance endpoint is a code oracle:
 * you would guess codes until one came back with money on it. Requiring an
 * account does not make guessing impossible, but it puts a name against every
 * attempt.
 */
giftCardRouter.post(
  '/balance',
  writeLimiter,
  requireAuth,
  validate({ body: balanceSchema }),
  async (req, res) => {
    const { code } = req.validated!.body as z.infer<typeof balanceSchema>
    const card = await findSpendable(code)

    return ok(res, {
      code: card.code,
      balance: card.balance,
      currency: card.currency,
      expiresAt: card.expiresAt,
    })
  },
)

const purchaseSchema = z
  .object({
    amount: z.coerce.number().int().min(1),
    recipientName: z.string().trim().max(120).optional(),
    recipientEmail: z.string().trim().email().max(200).optional(),
    message: z.string().trim().max(500).optional(),
    /** Buying it for yourself; the recipient is the buyer. */
    sendToMe: z.boolean().default(false),
  })
  .refine((d) => d.sendToMe || Boolean(d.recipientEmail), {
    message: 'Tell us where to send it, or choose to send it to yourself',
    path: ['recipientEmail'],
  })

/**
 * Buys a gift card.
 *
 * Creates an order and a card held pending, then hands back the order for the
 * existing payment flow to finish. The card carries no spendable balance until
 * that order is paid — otherwise abandoning the payment page would mint money.
 */
giftCardRouter.post(
  '/purchase',
  writeLimiter,
  requireAuth,
  validate({ body: purchaseSchema }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof purchaseSchema>

    const me = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { name: true, email: true },
    })

    const { order, giftCard } = await purchaseGiftCard({
      userId: req.user!.id,
      amount: body.amount,
      recipientName: body.sendToMe ? me.name : (body.recipientName ?? null),
      recipientEmail: body.sendToMe ? me.email : (body.recipientEmail ?? null),
      message: body.message ?? null,
    })

    recordAudit({
      action: 'GIFT_CARD_PURCHASED',
      entityType: 'GiftCard',
      entityId: giftCard.id,
      metadata: { amount: body.amount, orderNumber: order.orderNumber },
      req,
    })

    /**
     * The code is not returned here. It is worth money and the order is not
     * paid for yet; it goes out by email once payment lands.
     */
    return created(res, {
      order: { id: order.id, orderNumber: order.orderNumber, total: order.total },
    })
  },
)

/** The cards this customer bought, so they can resend a code they have lost. */
giftCardRouter.get('/mine', requireAuth, async (req, res) => {
  const cards = await prisma.giftCard.findMany({
    where: { purchaserId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      code: true,
      initialValue: true,
      balance: true,
      status: true,
      recipientName: true,
      recipientEmail: true,
      expiresAt: true,
      createdAt: true,
    },
  })

  return ok(res, { giftCards: cards })
})

// ------------------------------------------------------------------- admin

export const adminGiftCardRouter: Router = Router()

const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'REDEEMED', 'EXPIRED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminGiftCardRouter.get(
  '/',
  requirePermission('order.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>

    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { code: { contains: q.q, mode: 'insensitive' as const } },
              { recipientEmail: { contains: q.q, mode: 'insensitive' as const } },
              { recipientName: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [total, giftCards] = await Promise.all([
      prisma.giftCard.count({ where }),
      prisma.giftCard.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        include: { purchaser: { select: { id: true, name: true, email: true } } },
      }),
    ])

    return ok(res, { giftCards }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

adminGiftCardRouter.get('/:id', requirePermission('order.read'), async (req, res) => {
  const { id } = req.params as { id: string }

  const giftCard = await prisma.giftCard.findUnique({
    where: { id },
    include: {
      purchaser: { select: { id: true, name: true, email: true } },
      // The statement. Oldest first, because that is how a statement reads.
      transactions: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!giftCard) throw new NotFoundError('Gift card', 'GIFT_CARD_NOT_FOUND')

  return ok(res, { giftCard })
})

const issueSchema = z.object({
  amount: z.coerce.number().int().min(1),
  recipientName: z.string().trim().max(120).optional().nullable(),
  recipientEmail: z.string().trim().email().max(200).optional().nullable(),
  message: z.string().trim().max(500).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
})

/**
 * Issues a card by hand — a goodwill gesture, a replacement, a prize.
 *
 * Live immediately, because nothing is being paid for. That makes this a way to
 * create money, so it is audited with the actor and the reason, and sits behind
 * its own permission rather than general order access.
 */
adminGiftCardRouter.post(
  '/',
  writeLimiter,
  requirePermission('refund.create'),
  validate({ body: issueSchema }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof issueSchema>
    await assertPurchasableAmount(body.amount)

    const card = await issueGiftCard({
      amount: body.amount,
      recipientName: body.recipientName,
      recipientEmail: body.recipientEmail,
      message: body.message,
      note: body.note ?? 'Issued from admin',
      actorId: req.user!.id,
      active: true,
    })

    recordAudit({
      action: 'GIFT_CARD_ISSUED',
      entityType: 'GiftCard',
      entityId: card.id,
      metadata: { amount: body.amount, recipient: body.recipientEmail ?? null },
      req,
    })

    return created(res, { giftCard: card })
  },
)

const cancelSchema = z.object({ note: z.string().trim().max(300).optional() })

/**
 * Cancels a card. Not a delete: the row is the record that the money existed,
 * and the ledger under it still has to add up.
 */
adminGiftCardRouter.post(
  '/:id/cancel',
  writeLimiter,
  requirePermission('refund.create'),
  validate({ body: cancelSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { note } = req.validated!.body as z.infer<typeof cancelSchema>

    const existing = await prisma.giftCard.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Gift card', 'GIFT_CARD_NOT_FOUND')

    const giftCard = await prisma.$transaction(async (tx) => {
      const updated = await tx.giftCard.update({
        where: { id },
        data: { status: 'CANCELLED', balance: 0 },
      })

      // The write-off is a ledger row like any other movement, so the statement
      // explains where the remaining balance went.
      if (existing.balance > 0) {
        await tx.giftCardTransaction.create({
          data: {
            giftCardId: id,
            type: 'ADJUST',
            amount: -existing.balance,
            balanceAfter: 0,
            actorId: req.user!.id,
            note: note ?? 'Cancelled from admin',
          },
        })
      }

      return updated
    })

    recordAudit({
      action: 'GIFT_CARD_CANCELLED',
      entityType: 'GiftCard',
      entityId: id,
      metadata: { writtenOff: existing.balance },
      req,
    })

    return ok(res, { giftCard })
  },
)

// ------------------------------------------------------- page configuration

/**
 * What the gift card page offers and says.
 *
 * Behind `settings.update` rather than `content.manage`: the copy on this
 * screen sits beside the amounts the store will sell, and splitting one object
 * across two permissions would mean a role that can rewrite the terms but not
 * the prices they describe.
 */
adminGiftCardRouter.get('/config/page', requirePermission('settings.read'), async (_req, res) =>
  ok(res, { config: await readGiftCardConfig() }),
)

adminGiftCardRouter.put(
  '/config/page',
  writeLimiter,
  requirePermission('settings.update'),
  validate({ body: giftCardConfigSchema }),
  async (req, res) => {
    const config = await writeGiftCardConfig(
      req.validated!.body as z.infer<typeof giftCardConfigSchema>,
    )

    recordAudit({
      req,
      action: 'GIFT_CARD_CONFIG_UPDATED',
      entityType: 'Setting',
      entityId: 'giftcard.config',
      metadata: {
        denominations: config.denominations,
        custom: config.custom,
        validForYears: config.validForYears,
      },
    })

    return ok(res, { config })
  },
)
