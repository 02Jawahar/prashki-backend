import type { InventoryMovementType, Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'

/**
 * Inventory (spec §14, §40).
 *
 * Reservation policy — deliberately the simple, documented one:
 *
 *   Stock is decremented at ORDER CREATION, inside the same transaction that
 *   writes the order. There is no separate hold/expiry cycle, so `reservedStock`
 *   stays at zero in this build; the column exists so a two-phase reservation
 *   can be added later without a migration.
 *
 *   If an order is cancelled, the stock is returned by a RETURN movement.
 *
 * Every balance change writes a movement row in the same transaction, so the
 * ledger always explains the balance. Nothing in the codebase may write
 * `availableStock` directly — it goes through applyMovement.
 */

export interface MovementInput {
  variantId: string
  type: InventoryMovementType
  /** Signed: negative consumes stock, positive restores it. */
  quantity: number
  reason?: string
  referenceType?: string
  referenceId?: string
  createdById?: string | null
}

/**
 * Applies one movement and returns the new balance.
 * `tx` must be supplied when this participates in a larger transaction
 * (order creation) so a failure downstream rolls the stock change back too.
 */
export async function applyMovement(
  input: MovementInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  const inventory = await tx.inventory.findUnique({ where: { variantId: input.variantId } })
  if (!inventory) throw new NotFoundError('Inventory record', 'INVENTORY_NOT_FOUND')

  const balanceAfter = inventory.availableStock + input.quantity

  // Negative stock is never a valid state (spec §14).
  if (balanceAfter < 0) {
    throw new ConflictError(
      `Only ${inventory.availableStock} left in stock`,
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
      type: input.type,
      quantity: input.quantity,
      balanceAfter,
      reason: input.reason ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdById: input.createdById ?? null,
    },
  })

  return balanceAfter
}

/**
 * Sets stock to an absolute figure by writing the difference as an ADJUSTMENT.
 * This is what the admin "set stock to N" control uses — the ledger still
 * records the delta rather than a silent overwrite.
 */
export async function setStock(
  variantId: string,
  target: number,
  opts: { reason?: string; createdById?: string | null } = {},
): Promise<number> {
  if (target < 0) throw new ConflictError('Stock cannot be negative', 'INVALID_STOCK')

  const inventory = await prisma.inventory.findUnique({ where: { variantId } })
  if (!inventory) throw new NotFoundError('Inventory record', 'INVENTORY_NOT_FOUND')

  const delta = target - inventory.availableStock
  if (delta === 0) return inventory.availableStock

  return applyMovement({
    variantId,
    type: 'ADJUSTMENT',
    quantity: delta,
    reason: opts.reason ?? 'Manual adjustment',
    createdById: opts.createdById,
  })
}

/** Checks availability without mutating anything. */
export async function availableFor(variantId: string): Promise<number> {
  const inventory = await prisma.inventory.findUnique({
    where: { variantId },
    select: { availableStock: true },
  })
  return inventory?.availableStock ?? 0
}

export async function lowStock(limit = 20) {
  const rows = await prisma.inventory.findMany({
    where: { availableStock: { lte: prisma.inventory.fields.lowStockThreshold } },
    include: {
      variant: { include: { product: { select: { id: true, name: true, slug: true } } } },
    },
    orderBy: { availableStock: 'asc' },
    take: limit,
  })

  return rows.map((r) => ({
    variantId: r.variantId,
    sku: r.variant.sku,
    variantName: r.variant.name,
    productId: r.variant.product.id,
    productName: r.variant.product.name,
    productSlug: r.variant.product.slug,
    availableStock: r.availableStock,
    lowStockThreshold: r.lowStockThreshold,
  }))
}

export async function movementHistory(variantId: string, limit = 50) {
  const inventory = await prisma.inventory.findUnique({
    where: { variantId },
    include: {
      movements: { orderBy: { createdAt: 'desc' }, take: limit },
    },
  })
  if (!inventory) throw new NotFoundError('Inventory record', 'INVENTORY_NOT_FOUND')

  return {
    variantId,
    availableStock: inventory.availableStock,
    reservedStock: inventory.reservedStock,
    lowStockThreshold: inventory.lowStockThreshold,
    movements: inventory.movements,
  }
}
