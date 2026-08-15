import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { ok, noContent } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
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
  return ok(res, { cart: serializeCart(await loadCart(cart.id)) })
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

  return ok(res, { cart: serializeCart(await loadCart(cart.id)) })
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

  return ok(res, { cart: serializeCart(await loadCart(cart.id)) })
})

cartRouter.delete('/items/:itemId', async (req, res) => {
  const { itemId } = req.params as { itemId: string }
  const cart = await resolveCart(req, res)

  const item = await prisma.cartItem.findUnique({ where: { id: itemId } })
  if (!item || item.cartId !== cart.id) throw new NotFoundError('Cart item', 'CART_ITEM_NOT_FOUND')

  await prisma.cartItem.delete({ where: { id: itemId } })
  return ok(res, { cart: serializeCart(await loadCart(cart.id)) })
})

cartRouter.delete('/', async (req, res) => {
  const cart = await resolveCart(req, res)
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } })
  return noContent(res)
})

export { cartInclude }
