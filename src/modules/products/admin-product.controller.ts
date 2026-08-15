import type { Request, Response } from 'express'
import { prisma } from '../../config/db.js'
import { created, noContent, ok, pageMeta } from '../../utils/response.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { changedFields, recordAudit } from '../../utils/audit.js'
import { getStorage } from '../../integrations/storage/index.js'
import { applyMovement, setStock } from '../inventory/inventory.service.js'
import { emit } from '../../events/bus.js'
import {
  getAdminProductById,
  listAdminProducts,
  uniqueSlug,
} from './product.service.js'
import type {
  AdminListQuery,
  CreateProductInput,
  UpdateProductInput,
} from './product.schemas.js'

export async function listHandler(req: Request, res: Response) {
  const q = req.validated!.query as AdminListQuery
  const { products, total } = await listAdminProducts(q)
  return ok(res, { products }, { pagination: pageMeta(q.page, q.perPage, total) })
}

export async function getHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  return ok(res, { product: await getAdminProductById(id) })
}

export async function createHandler(req: Request, res: Response) {
  const input = req.validated!.body as CreateProductInput

  const slug = input.slug ?? (await uniqueSlug(input.name))

  const product = await prisma.$transaction(async (tx) => {
    const createdProduct = await tx.product.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        shortDescription: input.shortDescription || null,
        sku: input.sku,
        price: input.price,
        compareAtPrice: input.compareAtPrice ?? null,
        status: input.status,
        featured: input.featured,
        categoryId: input.categoryId ?? null,
        publishedAt: input.status === 'ACTIVE' ? new Date() : null,
      },
    })

    // Every product gets at least one variant so cart, order and inventory
    // logic never has to branch on "does this product have variants?".
    const variantDefs =
      input.variants?.length
        ? input.variants
        : [{ name: 'Default', sku: `${input.sku}-OS`, price: null, stock: 0 }]

    for (const [i, def] of variantDefs.entries()) {
      const variant = await tx.productVariant.create({
        data: {
          productId: createdProduct.id,
          name: def.name,
          sku: def.sku,
          price: def.price ?? null,
          position: i,
        },
      })

      const inventory = await tx.inventory.create({
        data: { variantId: variant.id, availableStock: 0 },
      })

      if (def.stock > 0) {
        await tx.inventory.update({
          where: { id: inventory.id },
          data: { availableStock: def.stock },
        })
        await tx.inventoryMovement.create({
          data: {
            inventoryId: inventory.id,
            type: 'INITIAL_STOCK',
            quantity: def.stock,
            balanceAfter: def.stock,
            reason: 'Opening stock',
            createdById: req.user!.id,
          },
        })
      }
    }

    return createdProduct
  })

  recordAudit({
    action: 'PRODUCT_CREATED',
    entityType: 'Product',
    entityId: product.id,
    metadata: { name: product.name, sku: product.sku, price: product.price, status: product.status },
    req,
  })
  emit('PRODUCT_CREATED', { productId: product.id, name: product.name })

  return created(res, { product: await getAdminProductById(product.id) })
}

export async function updateHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  const input = req.validated!.body as UpdateProductInput

  const before = await prisma.product.findUnique({ where: { id } })
  if (!before) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  // compareAtPrice is validated against price within a single request; when only
  // one of them is being changed, check against the stored value too.
  const nextPrice = input.price ?? before.price
  const nextCompare = input.compareAtPrice === undefined ? before.compareAtPrice : input.compareAtPrice
  if (nextCompare != null && nextCompare <= nextPrice) {
    throw new ValidationError('Compare-at price must be higher than the price', [
      { path: 'body.compareAtPrice', message: 'Must be higher than the price' },
    ])
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      ...input,
      shortDescription: input.shortDescription === undefined ? undefined : input.shortDescription || null,
      // Stamp the first publish so "newest" ordering is meaningful.
      publishedAt:
        input.status === 'ACTIVE' && !before.publishedAt ? new Date() : undefined,
    },
  })

  const diff = changedFields(before as unknown as Record<string, unknown>, input)
  recordAudit({
    action: 'PRODUCT_UPDATED',
    entityType: 'Product',
    entityId: id,
    metadata: { changes: diff },
    req,
  })
  if (diff.price) {
    recordAudit({
      action: 'PRODUCT_PRICE_CHANGED',
      entityType: 'Product',
      entityId: id,
      metadata: diff.price,
      req,
    })
  }
  emit('PRODUCT_UPDATED', { productId: id, changes: Object.keys(diff) })

  return ok(res, { product: await getAdminProductById(product.id) })
}

export async function publishHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  const { status } = req.validated!.body as { status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }

  const before = await prisma.product.findUnique({ where: { id } })
  if (!before) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  await prisma.product.update({
    where: { id },
    data: {
      status,
      publishedAt: status === 'ACTIVE' && !before.publishedAt ? new Date() : undefined,
    },
  })

  recordAudit({
    action: status === 'ACTIVE' ? 'PRODUCT_PUBLISHED' : 'PRODUCT_UNPUBLISHED',
    entityType: 'Product',
    entityId: id,
    metadata: { from: before.status, to: status },
    req,
  })

  return ok(res, { product: await getAdminProductById(id) })
}

export async function deleteHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }

  const product = await prisma.product.findUnique({
    where: { id },
    include: { images: true, variants: { select: { id: true, _count: { select: { orderItems: true } } } } },
  })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  // A product that appears on an order must not vanish — archive it instead, so
  // order history stays intact.
  const soldUnits = product.variants.reduce((n, v) => n + v._count.orderItems, 0)
  if (soldUnits > 0) {
    await prisma.product.update({ where: { id }, data: { status: 'ARCHIVED' } })
    recordAudit({
      action: 'PRODUCT_ARCHIVED',
      entityType: 'Product',
      entityId: id,
      metadata: { reason: 'Has order history', orderItems: soldUnits },
      req,
    })
    return ok(res, {
      archived: true,
      message: 'This product appears on existing orders, so it was archived rather than deleted.',
    })
  }

  const storage = getStorage()
  for (const image of product.images) {
    await storage.delete(keyFromUrl(image.url)).catch(() => undefined)
  }

  await prisma.product.delete({ where: { id } })

  recordAudit({
    action: 'PRODUCT_DELETED',
    entityType: 'Product',
    entityId: id,
    metadata: { name: product.name, sku: product.sku },
    req,
  })

  return ok(res, { deleted: true })
}

// ----------------------------------------------------------------- variants

export async function createVariantHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  const input = req.validated!.body as {
    name: string
    sku: string
    price?: number | null
    stock: number
    status: 'ACTIVE' | 'INACTIVE'
  }

  const product = await prisma.product.findUnique({ where: { id }, include: { variants: true } })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  const variant = await prisma.$transaction(async (tx) => {
    const v = await tx.productVariant.create({
      data: {
        productId: id,
        name: input.name,
        sku: input.sku,
        price: input.price ?? null,
        status: input.status,
        position: product.variants.length,
      },
    })
    const inv = await tx.inventory.create({ data: { variantId: v.id, availableStock: 0 } })
    if (input.stock > 0) {
      await tx.inventory.update({ where: { id: inv.id }, data: { availableStock: input.stock } })
      await tx.inventoryMovement.create({
        data: {
          inventoryId: inv.id,
          type: 'INITIAL_STOCK',
          quantity: input.stock,
          balanceAfter: input.stock,
          reason: 'Opening stock',
          createdById: req.user!.id,
        },
      })
    }
    return v
  })

  recordAudit({
    action: 'VARIANT_CREATED',
    entityType: 'ProductVariant',
    entityId: variant.id,
    metadata: { productId: id, sku: variant.sku },
    req,
  })

  return created(res, { product: await getAdminProductById(id) })
}

export async function updateVariantHandler(req: Request, res: Response) {
  const { id, variantId } = req.params as { id: string; variantId: string }

  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } })
  if (!variant || variant.productId !== id) throw new NotFoundError('Variant', 'VARIANT_NOT_FOUND')

  await prisma.productVariant.update({
    where: { id: variantId },
    data: req.validated!.body as Record<string, unknown>,
  })

  recordAudit({
    action: 'VARIANT_UPDATED',
    entityType: 'ProductVariant',
    entityId: variantId,
    metadata: { productId: id },
    req,
  })

  return ok(res, { product: await getAdminProductById(id) })
}

export async function deleteVariantHandler(req: Request, res: Response) {
  const { id, variantId } = req.params as { id: string; variantId: string }

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { _count: { select: { orderItems: true } }, product: { include: { variants: true } } },
  })
  if (!variant || variant.productId !== id) throw new NotFoundError('Variant', 'VARIANT_NOT_FOUND')

  if (variant.product.variants.length <= 1) {
    throw new ConflictError('A product must keep at least one variant', 'LAST_VARIANT')
  }
  if (variant._count.orderItems > 0) {
    await prisma.productVariant.update({ where: { id: variantId }, data: { status: 'INACTIVE' } })
    return ok(res, {
      deactivated: true,
      message: 'This variant appears on existing orders, so it was deactivated rather than deleted.',
    })
  }

  await prisma.productVariant.delete({ where: { id: variantId } })
  recordAudit({ action: 'VARIANT_DELETED', entityType: 'ProductVariant', entityId: variantId, req })

  return ok(res, { product: await getAdminProductById(id) })
}

// ------------------------------------------------------------------- stock

export async function adjustStockHandler(req: Request, res: Response) {
  const { variantId } = req.params as { variantId: string }
  const input = req.validated!.body as
    | { mode: 'set'; stock: number; reason?: string }
    | { mode: 'delta'; quantity: number; type: 'PURCHASE' | 'RETURN' | 'ADJUSTMENT' | 'DAMAGE'; reason?: string }

  const balance =
    input.mode === 'set'
      ? await setStock(variantId, input.stock, { reason: input.reason, createdById: req.user!.id })
      : await applyMovement({
          variantId,
          type: input.type,
          quantity: input.quantity,
          reason: input.reason,
          createdById: req.user!.id,
        })

  recordAudit({
    action: 'STOCK_CHANGED',
    entityType: 'ProductVariant',
    entityId: variantId,
    metadata: { ...input, balanceAfter: balance },
    req,
  })
  emit('INVENTORY_UPDATED', { variantId, availableStock: balance })

  return ok(res, { variantId, availableStock: balance })
}

// ------------------------------------------------------------------ images

export async function uploadImagesHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  const files = (req.files as Express.Multer.File[] | undefined) ?? []

  if (files.length === 0) throw new ValidationError('No files were uploaded')

  const product = await prisma.product.findUnique({
    where: { id },
    include: { images: { orderBy: { sortOrder: 'desc' }, take: 1 } },
  })
  if (!product) throw new NotFoundError('Product', 'PRODUCT_NOT_FOUND')

  const storage = getStorage()
  let nextOrder = (product.images[0]?.sortOrder ?? -1) + 1

  const saved = []
  for (const file of files) {
    const stored = await storage.put({
      folder: 'products',
      filename: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    })
    saved.push(
      await prisma.productImage.create({
        data: {
          productId: id,
          url: stored.url,
          altText: product.name,
          sortOrder: nextOrder++,
        },
      }),
    )
  }

  recordAudit({
    action: 'PRODUCT_IMAGES_UPLOADED',
    entityType: 'Product',
    entityId: id,
    metadata: { count: saved.length },
    req,
  })

  return created(res, { images: saved })
}

export async function deleteImageHandler(req: Request, res: Response) {
  const { id, imageId } = req.params as { id: string; imageId: string }

  const image = await prisma.productImage.findUnique({ where: { id: imageId } })
  if (!image || image.productId !== id) throw new NotFoundError('Image', 'IMAGE_NOT_FOUND')

  await prisma.productImage.delete({ where: { id: imageId } })
  await getStorage().delete(keyFromUrl(image.url)).catch(() => undefined)

  recordAudit({ action: 'PRODUCT_IMAGE_DELETED', entityType: 'Product', entityId: id, req })
  return noContent(res)
}

export async function reorderImagesHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string }
  const { imageIds } = req.validated!.body as { imageIds: string[] }

  const images = await prisma.productImage.findMany({ where: { productId: id }, select: { id: true } })
  const known = new Set(images.map((i) => i.id))
  if (imageIds.length !== images.length || imageIds.some((i) => !known.has(i))) {
    throw new ValidationError('The image list must contain every image for this product exactly once')
  }

  await prisma.$transaction(
    imageIds.map((imageId, index) =>
      prisma.productImage.update({ where: { id: imageId }, data: { sortOrder: index } }),
    ),
  )

  return ok(res, { product: await getAdminProductById(id) })
}

/** Storage keys are persisted inside the public URL; recover them for deletes. */
function keyFromUrl(url: string): string {
  const marker = '/uploads/'
  const idx = url.indexOf(marker)
  return idx === -1 ? url : url.slice(idx + marker.length)
}
