import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { ok, noContent } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { evaluateCoupon, normalizeCode } from '../coupons/coupon.service.js'
import { resolveCart } from './cart.service.js'
import { cartInclude, loadCart, serializeCart } from './cart.serializer.js'

/**
 * Cart (spec §22–23). Open to guests; a signed-in user always resolves to their
 * own cart. The client sends only variant ids and quantities — never prices.
 */
export const cartRouter: Router = Router()

const addItemSchema = z.object({
  variantId: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
})

const updateItemSchema = z.object({
  quantity: z.coerce.number().int().min(0).max(20),
})

cartRouter.get('/', async (req, res) => {
  const cart = await resolveCart(req, res)
  return ok(res, { cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }) })
})

cartRouter.post('/items', validate({ body: addItemSchema }), async (req, res) => {
  const { variantId, quantity } = req.validated!.body as z.infer<typeof addItemSchema>
  const cart = await resolveCart(req, res)

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, inventory: true },
  })

  if (!variant) throw new NotFoundError('Variant', 'VARIANT_NOT_FOUND')
  if (variant.product.status !== 'ACTIVE' || variant.status !== 'ACTIVE') {
    throw new ConflictError('That item is not available', 'ITEM_UNAVAILABLE')
  }

  const existing = await prisma.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
  })

  const desired = (existing?.quantity ?? 0) + quantity
  const stock = variant.inventory?.availableStock ?? 0

  // Stock is checked here and again at order creation, inside the transaction.
  if (desired > stock) {
    throw new ConflictError(
      stock === 0 ? 'That item is out of stock' : `Only ${stock} left in stock`,
      'INSUFFICIENT_STOCK',
    )
  }

  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    create: { cartId: cart.id, variantId, quantity },
    update: { quantity: desired },
  })

  return ok(res, { cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }) })
})

cartRouter.patch('/items/:itemId', validate({ body: updateItemSchema }), async (req, res) => {
  const { itemId } = req.params as { itemId: string }
  const { quantity } = req.validated!.body as z.infer<typeof updateItemSchema>
  const cart = await resolveCart(req, res)

  const item = await prisma.cartItem.findUnique({
    where: { id: itemId },
    include: { variant: { include: { inventory: true } } },
  })
  // Scoped to this cart — an id from another cart must not be editable.
  if (!item || item.cartId !== cart.id) throw new NotFoundError('Cart item', 'CART_ITEM_NOT_FOUND')

  if (quantity === 0) {
    await prisma.cartItem.delete({ where: { id: itemId } })
  } else {
    const stock = item.variant.inventory?.availableStock ?? 0
    if (quantity > stock) {
      throw new ConflictError(
        stock === 0 ? 'That item is out of stock' : `Only ${stock} left in stock`,
        'INSUFFICIENT_STOCK',
      )
    }
    await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } })
  }

  return ok(res, { cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }) })
})

cartRouter.delete('/items/:itemId', async (req, res) => {
  const { itemId } = req.params as { itemId: string }
  const cart = await resolveCart(req, res)

  const item = await prisma.cartItem.findUnique({ where: { id: itemId } })
  if (!item || item.cartId !== cart.id) throw new NotFoundError('Cart item', 'CART_ITEM_NOT_FOUND')

  await prisma.cartItem.delete({ where: { id: itemId } })
  return ok(res, { cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }) })
})

cartRouter.delete('/', async (req, res) => {
  const cart = await resolveCart(req, res)
  await prisma.cart.update({
    where: { id: cart.id },
    // An emptied bag should not keep a coupon primed for whatever goes in next.
    data: { couponCode: null, items: { deleteMany: {} } },
  })
  return noContent(res)
})

// ------------------------------------------------------------------- coupons

const couponSchema = z.object({
  code: z.string().trim().min(2, 'Enter a code').max(60),
})

/**
 * Applying a coupon stores only the code (M13). The discount is recomputed on
 * every read, so nothing here can be replayed or tampered with — the worst a
 * forged request achieves is naming a code the customer could have typed.
 */
cartRouter.post('/coupon', writeLimiter, validate({ body: couponSchema }), async (req, res) => {
  const { code } = req.validated!.body as z.infer<typeof couponSchema>
  const cart = await resolveCart(req, res)
  const loaded = await loadCart(cart.id)

  const purchasable = loaded.items
    .filter((i) => i.variant.status === 'ACTIVE' && i.variant.product.status === 'ACTIVE')
    .map((i) => {
      const unitPrice = i.variant.price ?? i.variant.product.price
      return {
        id: i.id,
        productId: i.variant.productId,
        categoryIds: i.variant.product.categoryId ? [i.variant.product.categoryId] : [],
        unitPrice,
        quantity: i.quantity,
        lineTotal: unitPrice * i.quantity,
        isDiscounted:
          i.variant.product.compareAtPrice !== null &&
          i.variant.product.compareAtPrice > unitPrice,
      }
    })

  if (purchasable.length === 0) {
    throw new ConflictError('Add something to your bag first', 'CART_EMPTY')
  }

  // Throws a customer-safe ValidationError when the code cannot be used, so an
  // invalid code never gets saved onto the cart.
  await evaluateCoupon({
    code,
    userId: req.user?.id ?? null,
    lines: purchasable,
    subtotal: purchasable.reduce((sum, l) => sum + l.lineTotal, 0),
  })

  await prisma.cart.update({
    where: { id: cart.id },
    data: { couponCode: normalizeCode(code) },
  })

  return ok(res, {
    cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }),
  })
})

cartRouter.delete('/coupon', async (req, res) => {
  const cart = await resolveCart(req, res)
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } })

  return ok(res, {
    cart: await serializeCart(await loadCart(cart.id), { userId: req.user?.id ?? null }),
  })
})

export { cartInclude }
