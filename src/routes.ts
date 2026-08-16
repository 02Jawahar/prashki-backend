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
import { adminCouponRouter } from './modules/coupons/admin-coupon.routes.js'
import { adminShippingRouter, shippingRouter } from './modules/shipping/shipping.routes.js'
import { adminShipmentRouter, trackingRouter } from './modules/shipments/shipment.routes.js'
import {
  adminRefundRouter,
  adminReturnRouter,
  returnRouter,
} from './modules/returns/return.routes.js'
import { adminPageRouter, pageRouter } from './modules/content/page.routes.js'
import { adminRedirectRouter, redirectRouter } from './modules/content/redirect.routes.js'
import { seoRouter } from './modules/content/seo.routes.js'
import {
  adminMessageRouter,
  notificationRouter,
  preferenceRouter,
} from './modules/notifications/notification.routes.js'
import { wishlistRouter } from './modules/wishlist/wishlist.routes.js'
import { adminReviewRouter, reviewRouter } from './modules/reviews/review.routes.js'
import { adminAttributeRouter } from './modules/attributes/attribute.routes.js'
import { adminReportRouter } from './modules/reports/report.routes.js'
import {
  adminAuditRouter,
  adminPermissionRouter,
  adminRoleRouter,
  adminStaffRouter,
} from './modules/rbac/rbac.routes.js'
import { analyticsRouter } from './modules/analytics/analytics.routes.js'
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
apiRouter.use('/shipping', shippingRouter)
apiRouter.use('/pages', pageRouter)
apiRouter.use('/redirects', redirectRouter)
apiRouter.use('/seo', seoRouter)
apiRouter.use('/reviews', reviewRouter)
apiRouter.use('/analytics', analyticsRouter)

// ------------------------------------------------------ authenticated only
apiRouter.use('/addresses', addressRouter)
apiRouter.use('/orders', orderRouter)
apiRouter.use('/payments', paymentRouter)
apiRouter.use('/tracking', trackingRouter)
apiRouter.use('/returns', returnRouter)
apiRouter.use('/notifications', notificationRouter)
apiRouter.use('/notification-preferences', preferenceRouter)
apiRouter.use('/wishlist', wishlistRouter)

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
adminRouter.use('/coupons', adminCouponRouter)
adminRouter.use('/shipping', adminShippingRouter)
adminRouter.use('/shipments', adminShipmentRouter)
adminRouter.use('/returns', adminReturnRouter)
adminRouter.use('/refunds', adminRefundRouter)
adminRouter.use('/pages', adminPageRouter)
adminRouter.use('/redirects', adminRedirectRouter)
adminRouter.use('/messaging', adminMessageRouter)
adminRouter.use('/reviews', adminReviewRouter)
adminRouter.use('/attributes', adminAttributeRouter)
adminRouter.use('/reports', adminReportRouter)

// Access control administration (M10, M24). Each router declares its own
// permission — `role.manage`, `user.manage`, `audit.read`.
adminRouter.use('/permissions', adminPermissionRouter)
adminRouter.use('/roles', adminRoleRouter)
adminRouter.use('/staff', adminStaffRouter)
adminRouter.use('/audit', adminAuditRouter)
adminRouter.use('/customers', adminCustomerRouter)
adminRouter.use('/settings', adminSettingsRouter)

apiRouter.use('/admin', adminRouter)
