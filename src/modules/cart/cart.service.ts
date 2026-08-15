import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { baseCookie } from '../../utils/tokens.js'

/**
 * Cart identity.
 *
 * A guest cart is addressed by an opaque cookie token. A signed-in user's cart
 * is addressed by userId. On login the guest cart is merged into the user cart
 * and discarded (spec §36).
 */
export const CART_COOKIE = 'cart_token'

/** Same scope rules as the session cookies — see utils/tokens.ts. */
const cartCookieOptions = {
  ...baseCookie,
  maxAge: 30 * 24 * 60 * 60 * 1000,
} as const

export function readCartToken(req: Request): string | undefined {
  return req.cookies?.[CART_COOKIE]
}

export function setCartToken(res: Response, token: string) {
  res.cookie(CART_COOKIE, token, cartCookieOptions)
}

/**
 * Resolves the cart for this request, creating one if needed.
 * Signed-in users always resolve to their own cart, never a guest cart.
 */
export async function resolveCart(req: Request, res: Response) {
  const userId = req.user?.id

  if (userId) {
    const existing = await prisma.cart.findUnique({ where: { userId } })
    if (existing) return existing
    return prisma.cart.create({ data: { userId, token: crypto.randomUUID() } })
  }

  const token = readCartToken(req)
  if (token) {
    const existing = await prisma.cart.findUnique({ where: { token } })
    // A token that now belongs to a user is not a valid guest cart.
    if (existing && !existing.userId) return existing
  }

  const cart = await prisma.cart.create({ data: { token: crypto.randomUUID() } })
  setCartToken(res, cart.token)
  return cart
}

/**
 * Folds a guest cart into the user's cart at sign-in.
 *
 * Conflict strategy (deterministic, per spec §36): quantities are summed, then
 * clamped to what stock allows, so merging can never create an unfulfillable
 * line. The guest cart is deleted afterwards so it cannot be merged twice.
 */
export async function mergeGuestCart(req: Request, userId: string): Promise<void> {
  const guestToken = readCartToken(req)
  if (!guestToken) return

  try {
    const guestCart = await prisma.cart.findUnique({
      where: { token: guestToken },
      include: { items: true },
    })
    if (!guestCart || guestCart.userId || guestCart.items.length === 0) return

    await prisma.$transaction(async (tx) => {
      const userCart =
        (await tx.cart.findUnique({ where: { userId } })) ??
        (await tx.cart.create({ data: { userId, token: crypto.randomUUID() } }))

      for (const item of guestCart.items) {
        const inventory = await tx.inventory.findUnique({ where: { variantId: item.variantId } })
        const ceiling = inventory?.availableStock ?? 0
        if (ceiling <= 0) continue

        const existing = await tx.cartItem.findUnique({
          where: { cartId_variantId: { cartId: userCart.id, variantId: item.variantId } },
        })

        const merged = Math.min((existing?.quantity ?? 0) + item.quantity, ceiling)

        if (existing) {
          await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: merged } })
        } else {
          await tx.cartItem.create({
            data: { cartId: userCart.id, variantId: item.variantId, quantity: merged },
          })
        }
      }

      await tx.cart.delete({ where: { id: guestCart.id } })
    })
  } catch (err) {
    // Losing a guest cart is bad; failing the login over it is worse.
    logger.error({ err, userId }, 'Guest cart merge failed')
  }
}
