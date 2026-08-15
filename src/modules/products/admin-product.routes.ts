import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { imageUpload } from '../../middleware/upload.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import {
  adminListQuery,
  createProductSchema,
  createVariantSchema,
  publishSchema,
  reorderImagesSchema,
  updateProductSchema,
  updateVariantSchema,
} from './product.schemas.js'
import {
  adjustStockHandler,
  createHandler,
  createVariantHandler,
  deleteHandler,
  deleteImageHandler,
  deleteVariantHandler,
  getHandler,
  listHandler,
  publishHandler,
  reorderImagesHandler,
  updateHandler,
  updateVariantHandler,
  uploadImagesHandler,
} from './admin-product.controller.js'

/**
 * Admin catalogue routes.
 *
 * Every single one carries an explicit permission check. Mounting under an
 * admin-guarded router is not enough on its own — the capability required
 * differs per endpoint (spec §5).
 */
export const adminProductRouter: Router = Router()

adminProductRouter.get(
  '/',
  requirePermission('product.read'),
  validate({ query: adminListQuery }),
  listHandler,
)

adminProductRouter.get('/:id', requirePermission('product.read'), getHandler)

adminProductRouter.post(
  '/',
  writeLimiter,
  requirePermission('product.create'),
  validate({ body: createProductSchema }),
  createHandler,
)

adminProductRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('product.update'),
  validate({ body: updateProductSchema }),
  updateHandler,
)

adminProductRouter.patch(
  '/:id/status',
  writeLimiter,
  requirePermission('product.publish'),
  validate({ body: publishSchema }),
  publishHandler,
)

adminProductRouter.delete('/:id', writeLimiter, requirePermission('product.delete'), deleteHandler)

// ---------------------------------------------------------------- variants

adminProductRouter.post(
  '/:id/variants',
  writeLimiter,
  requirePermission('product.update'),
  validate({ body: createVariantSchema }),
  createVariantHandler,
)

adminProductRouter.patch(
  '/:id/variants/:variantId',
  writeLimiter,
  requirePermission('product.update'),
  validate({ body: updateVariantSchema }),
  updateVariantHandler,
)

adminProductRouter.delete(
  '/:id/variants/:variantId',
  writeLimiter,
  requirePermission('product.update'),
  deleteVariantHandler,
)

// ------------------------------------------------------------------ images

adminProductRouter.post(
  '/:id/images',
  writeLimiter,
  requirePermission('media.upload'),
  imageUpload.array('images', 8),
  uploadImagesHandler,
)

adminProductRouter.delete(
  '/:id/images/:imageId',
  writeLimiter,
  requirePermission('media.upload'),
  deleteImageHandler,
)

adminProductRouter.patch(
  '/:id/images/order',
  writeLimiter,
  requirePermission('media.upload'),
  validate({ body: reorderImagesSchema }),
  reorderImagesHandler,
)

// ------------------------------------------------------------------- stock

const adjustStockSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('set'),
    stock: z.coerce.number().int().min(0),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    mode: z.literal('delta'),
    quantity: z.coerce.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'),
    type: z.enum(['PURCHASE', 'RETURN', 'ADJUSTMENT', 'DAMAGE']),
    reason: z.string().trim().max(200).optional(),
  }),
])

adminProductRouter.post(
  '/variants/:variantId/stock',
  writeLimiter,
  requirePermission('inventory.adjust'),
  validate({ body: adjustStockSchema }),
  adjustStockHandler,
)
