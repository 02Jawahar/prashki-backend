import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * Sets — a product assembled from other products (M03).
 *
 * A set is an ordinary product with its own page, price and photographs that
 * happens to be made of others. Buying one puts a line in the bag per piece
 * rather than a single line for the set, which is what lets the customer take a
 * different size on the top than on the bottom, and what keeps stock honest:
 * the garments that leave the studio are the ones decremented.
 *
 * The set's own price is what the customer pays, and it is normally less than
 * the pieces bought separately. That discount has to be shared out across the
 * lines, because everything downstream — refunds, partial returns, tax — works
 * from line totals.
 */

export interface SetPiece {
  productId: string
  name: string
  slug: string
  /** The piece's own price, for showing what the set saves. */
  price: number
  image: string | null
  position: number
}

/** A set and its pieces, or null when the product is a single garment. */
export async function readSet(productId: string): Promise<SetPiece[] | null> {
  const rows = await prisma.productComponent.findMany({
    where: { setProductId: productId },
    orderBy: { position: 'asc' },
    select: {
      position: true,
      component: {
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          status: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
        },
      },
    },
  })

  if (rows.length === 0) return null

  return rows.map((row) => ({
    productId: row.component.id,
    name: row.component.name,
    slug: row.component.slug,
    price: row.component.price,
    image: row.component.images[0]?.url ?? null,
    position: row.position,
  }))
}

/**
 * Splits the set's price across its pieces, in paise, so the parts sum to the
 * whole exactly.
 *
 * Proportional to what each piece costs on its own — a ₹34,000 lehenga carries
 * more of the discount than a ₹13,500 blouse, which is what a customer would
 * expect if they ever did the arithmetic. Rounding leftovers go to the largest
 * pieces first, so no line is ever a rupee out and the total is never a rupee
 * short.
 *
 * Exported because it is the one piece of arithmetic here worth testing on its
 * own.
 */
export function allocateSetPrice(setPrice: number, piecePrices: number[]): number[] {
  if (piecePrices.length === 0) return []

  const sum = piecePrices.reduce((total, price) => total + price, 0)

  // Every piece free, or priced at nothing: split as evenly as the paise allow
  // rather than dividing by zero.
  if (sum <= 0) {
    const each = Math.floor(setPrice / piecePrices.length)
    const shares = piecePrices.map(() => each)
    let left = setPrice - each * piecePrices.length
    for (let i = 0; left > 0; i = (i + 1) % shares.length, left--) shares[i]! += 1
    return shares
  }

  const exact = piecePrices.map((price) => (price * setPrice) / sum)
  const shares = exact.map((value) => Math.floor(value))
  let remainder = setPrice - shares.reduce((total, share) => total + share, 0)

  // Largest fractional part first — the standard way to hand out the leftover
  // paise without biasing any particular line.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)

  for (let i = 0; remainder > 0; i = (i + 1) % order.length, remainder--) {
    shares[order[i]!.index]! += 1
  }

  return shares
}

export interface ChosenPiece {
  productId: string
  variantId: string
}

export interface ResolvedLine {
  variantId: string
  productId: string
  unitPrice: number
}

/**
 * Turns "the customer chose these sizes" into the lines that go in the bag.
 *
 * Refuses anything that does not hold together: a piece that is not in the set,
 * a size that belongs to a different piece, a piece left unchosen, a garment
 * that is no longer on sale. Every one of these is a way to end up selling
 * something at a price nobody agreed to.
 */
export async function resolveSetSelection(
  setProductId: string,
  chosen: ChosenPiece[],
): Promise<{ setName: string; lines: ResolvedLine[] }> {
  const set = await prisma.product.findUnique({
    where: { id: setProductId },
    select: { id: true, name: true, price: true, status: true },
  })
  if (!set) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')
  if (set.status !== 'ACTIVE') {
    throw new ValidationError('That set is not on sale', { code: 'SET_NOT_AVAILABLE' })
  }

  const pieces = await readSet(setProductId)
  if (!pieces) {
    throw new ValidationError('That product is not a set', { code: 'NOT_A_SET' })
  }

  if (chosen.length !== pieces.length) {
    throw new ValidationError('Please choose a size for every piece', {
      code: 'SET_INCOMPLETE',
    })
  }

  const wanted = new Map(chosen.map((c) => [c.productId, c.variantId]))
  const missing = pieces.filter((piece) => !wanted.has(piece.productId))
  if (missing.length > 0) {
    throw new ValidationError(
      `Please choose a size for ${missing.map((m) => m.name).join(' and ')}`,
      { code: 'SET_INCOMPLETE' },
    )
  }

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: [...wanted.values()] } },
    select: { id: true, productId: true, status: true, product: { select: { status: true } } },
  })

  for (const piece of pieces) {
    const variantId = wanted.get(piece.productId)!
    const variant = variants.find((v) => v.id === variantId)

    // A size that belongs to a different garment is the interesting case: it
    // would otherwise let someone pay a blouse's share for a lehenga.
    if (!variant || variant.productId !== piece.productId) {
      throw new ValidationError(`That size does not belong to ${piece.name}`, {
        code: 'SET_VARIANT_MISMATCH',
      })
    }
    if (variant.status !== 'ACTIVE' || variant.product.status !== 'ACTIVE') {
      throw new ValidationError(`${piece.name} is not available in that size`, {
        code: 'SET_PIECE_UNAVAILABLE',
      })
    }
  }

  const shares = allocateSetPrice(
    set.price,
    pieces.map((piece) => piece.price),
  )

  return {
    setName: set.name,
    lines: pieces.map((piece, index) => ({
      variantId: wanted.get(piece.productId)!,
      productId: piece.productId,
      unitPrice: shares[index]!,
    })),
  }
}

/**
 * What a set may be made of.
 *
 * A set cannot contain itself — the database refuses that — and it cannot
 * contain another set, which is the rule that keeps the bag flat. Allowing it
 * would mean a line that is a set inside a set, and every screen that renders a
 * bag would have to recurse.
 */
export async function assertUsableComponents(
  setProductId: string,
  componentIds: string[],
): Promise<void> {
  if (componentIds.length < 2) {
    throw new ValidationError('A set needs at least two pieces', { code: 'SET_TOO_SMALL' })
  }
  if (new Set(componentIds).size !== componentIds.length) {
    throw new ValidationError('A piece can only be in a set once', { code: 'SET_DUPLICATE_PIECE' })
  }
  if (componentIds.includes(setProductId)) {
    throw new ValidationError('A set cannot contain itself', { code: 'SET_SELF_REFERENCE' })
  }

  const found = await prisma.product.findMany({
    where: { id: { in: componentIds } },
    select: { id: true, name: true, _count: { select: { components: true } } },
  })

  if (found.length !== componentIds.length) {
    throw new ValidationError('One of those pieces no longer exists', { code: 'SET_PIECE_MISSING' })
  }

  const nested = found.filter((p) => p._count.components > 0)
  if (nested.length > 0) {
    throw new ValidationError(
      `${nested.map((n) => n.name).join(' and ')} is itself a set. A set is made of single pieces.`,
      { code: 'SET_NESTED' },
    )
  }
}

/** Replaces a set's line-up in one go, in the order given. */
export async function writeComponents(
  setProductId: string,
  componentIds: string[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.productComponent.deleteMany({ where: { setProductId } })
  await tx.productComponent.createMany({
    data: componentIds.map((componentProductId, position) => ({
      setProductId,
      componentProductId,
      position,
    })),
  })
}
