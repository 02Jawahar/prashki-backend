import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Node loads .env for us (20.6+). Prisma's CLI does its own loading.
try {
  const here = path.dirname(fileURLToPath(import.meta.url))
  process.loadEnvFile(path.resolve(here, '..', '..', '.env'))
} catch {
  // no .env file — fall back to the real environment
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * Admin sessions are deliberately shorter than customer sessions (M10:
   * "Admin sessions use shorter expiry ... than public sessions").
   *
   * A stolen customer session can place an order. A stolen admin session can
   * empty the catalogue, read every customer's address and issue refunds — so
   * it gets a fraction of the lifetime.
   */
  ADMIN_ACCESS_TOKEN_TTL: z.string().default('10m'),
  ADMIN_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),

  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Cookie scope.
   *
   * Session cookies are set by the API host. If the storefront and the API sit
   * on different subdomains of one registrable domain (shop.example.com and
   * api.example.com), they are still the *same site*, so SameSite=Lax works and
   * COOKIE_DOMAIN=.example.com lets one cookie cover both.
   *
   * If they end up on genuinely different domains, the browser treats the
   * session cookie as third-party: SameSite must be `none` (which forces
   * Secure, so HTTPS only) and modern browsers may still block it. Sharing a
   * domain is much the better arrangement.
   */
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().min(8).default('change-me'),
  CUSTOMER_EMAIL: z.string().email().default('customer@example.com'),
  CUSTOMER_PASSWORD: z.string().min(8).default('change-me'),
  /// Shared by the seeded demo staff, one per role.
  STAFF_PASSWORD: z.string().min(8).default('change-me'),

  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['console', 'resend', 'sendgrid', 'ses']).default('console'),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('orders@example.com'),

  SMS_PROVIDER: z.enum(['noop', 'msg91', 'twilio']).default('noop'),
  WHATSAPP_PROVIDER: z.enum(['noop', 'meta', 'twilio']).default('noop'),

  /**
   * Carrier integration. `manual` means parcels are booked by hand — the
   * inbound status webhook still works, verified with the shared secret below.
   */
  SHIPPING_PROVIDER: z.string().default('manual'),
  SHIPPING_WEBHOOK_SECRET: z.string().optional(),
  /// Fallback parcel weight per unit when a variant has none, in grams.
  SHIPPING_DEFAULT_ITEM_WEIGHT_GRAMS: z.coerce.number().int().min(0).default(500),

  REDIS_URL: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3', 'r2']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('uploads'),
  STORAGE_PUBLIC_URL: z.string().default('http://localhost:4000/uploads'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail loudly at boot rather than mysteriously at the first request.
  console.error('Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = parsed.data
export const isProduction = env.NODE_ENV === 'production'
export const isDevelopment = env.NODE_ENV === 'development'
