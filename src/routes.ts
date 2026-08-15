import { Router } from 'express'
import { prisma } from './config/db.js'
import { ok } from './utils/response.js'
import { attachUser, requireAdmin, requireAuth } from './middleware/auth.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { categoryRouter, productRouter } from './modules/products/product.routes.js'
import { cartRouter } from './modules/cart/cart.routes.js'
import { addressRouter } from './modules/addresses/address.routes.js'
import { adminOrderRouter, orderRouter } from './modules/orders/order.routes.js'
import { paymentRouter } from './modules/payments/payment.routes.js'
import { webhookRouter } from './modules/webhooks/webhook.routes.js'
import { adminProductRouter } from './modules/products/admin-product.routes.js'
import { adminCategoryRouter } from './modules/categories/admin-category.routes.js'
import { adminMediaRouter } from './modules/media/media.routes.js'
import {
  adminCustomerRouter,
  adminDashboardRouter,
  adminInventoryRouter,
  adminSettingsRouter,
} from './modules/admin/admin.routes.js'

/**
 * Every route lives under /api/v1 (spec §45), and the versioned prefix is
 * applied in exactly one place — in app.ts, where this router is mounted.
 */
export const apiRouter: Router = Router()

// Populates req.user when a valid session cookie is present. Does not reject;
// individual guards decide what each route requires.
apiRouter.use(attachUser)

apiRouter.get('/', (_req, res) => ok(res, { name: 'ecommerce-api', version: 'v1' }))

// ------------------------------------------------------------------- public
apiRouter.use('/auth', authRouter)
apiRouter.use('/products', productRouter)
apiRouter.use('/categories', categoryRouter)
apiRouter.use('/cart', cartRouter)

// ------------------------------------------------------ authenticated only
apiRouter.use('/addresses', addressRouter)
apiRouter.use('/orders', orderRouter)
apiRouter.use('/payments', paymentRouter)

// Authenticated by signature, not by session — see the router for why.
apiRouter.use('/webhooks', webhookRouter)

/**
 * Store configuration the storefront needs (currency, shipping thresholds,
 * navigation, homepage layout). Only non-sensitive groups are exposed.
 */
apiRouter.get('/settings', async (_req, res) => {
  const settings = await prisma.setting.findMany({
    where: { group: { in: ['general', 'checkout', 'navigation', 'homepage'] } },
  })

  const map: Record<string, unknown> = {}
  for (const s of settings) {
    map[s.key] =
      s.type === 'NUMBER'
        ? Number(s.value)
        : s.type === 'BOOLEAN'
          ? s.value === 'true'
          : s.type === 'JSON'
            ? safeJson(s.value)
            : s.value
  }

  return ok(res, { settings: map })
})

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// -------------------------------------------------------------------- admin
// Authentication and the ADMIN role gate the whole subtree; each route then
// declares the specific permission it needs.
const adminRouter: Router = Router()
adminRouter.use(requireAuth, requireAdmin)

adminRouter.use('/', adminDashboardRouter)
adminRouter.use('/products', adminProductRouter)
adminRouter.use('/categories', adminCategoryRouter)
adminRouter.use('/media', adminMediaRouter)
adminRouter.use('/inventory', adminInventoryRouter)
adminRouter.use('/orders', adminOrderRouter)
adminRouter.use('/customers', adminCustomerRouter)
adminRouter.use('/settings', adminSettingsRouter)

apiRouter.use('/admin', adminRouter)
