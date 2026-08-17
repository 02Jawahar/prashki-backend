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

  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend', 'sendgrid', 'ses']).default('console'),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('orders@example.com'),

  /**
   * SMTP, which every mail service speaks — Brevo, Resend, Mailtrap, Gmail,
   * Amazon SES. One adapter rather than one per vendor, so changing provider
   * is four environment variables and no deploy of new code.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().trim().optional(),
  /**
   * Google shows an app password as four groups of four — "msty biow ihan
   * aemh" — because it is easier to read that way. The password is the sixteen
   * characters; the spaces are presentation. Pasted verbatim it authenticates
   * as a nineteen-character string and Gmail rejects it, which reads as a
   * wrong password when the credential is perfectly good.
   *
   * Only that exact shape is collapsed. Another provider's key with a real
   * space in it is left alone.
   */
  SMTP_PASSWORD: z
    .string()
    .optional()
    .transform((value) =>
      value && /^(\w{4}\s){3}\w{4}$/.test(value.trim()) ? value.replace(/\s+/g, '') : value,
    ),
  /**
   * Implicit TLS from the first byte (port 465). Port 587 uses STARTTLS, which
   * is negotiated on a plain connection, so this stays false there — setting
   * it wrong is the usual reason a working password appears to be rejected.
   */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

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

/**
 * Rules that only apply in production.
 *
 * The base schema has to stay permissive enough for local development, where
 * `change-me` is a perfectly good password. In production it is a way in — so
 * the placeholders shipped in `.env.example` are rejected at boot rather than
 * quietly deployed.
 *
 * Boot-time is the right place for this: the alternative is discovering it
 * from an access log.
 */
const PLACEHOLDERS = new Set(['change-me', 'changeme', 'password', 'admin', 'secret', ''])

function productionIssues(env: z.infer<typeof schema>): string[] {
  if (env.NODE_ENV !== 'production') return []

  const issues: string[] = []

  for (const [name, value] of [
    ['ADMIN_PASSWORD', env.ADMIN_PASSWORD],
    ['CUSTOMER_PASSWORD', env.CUSTOMER_PASSWORD],
    ['STAFF_PASSWORD', env.STAFF_PASSWORD],
  ] as const) {
    if (PLACEHOLDERS.has(value.trim().toLowerCase())) {
      issues.push(`${name} is still the placeholder from .env.example`)
    }
  }

  // A shared signing key means a refresh token is a valid access token.
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    issues.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different')
  }

  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
    ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
  ] as const) {
    if (value.length < 32) {
      issues.push(`${name} should be at least 32 characters in production`)
    }
    if (PLACEHOLDERS.has(value.trim().toLowerCase())) {
      issues.push(`${name} is a placeholder value`)
    }
  }

  // Cookies are only sent over HTTPS in production; an http:// frontend means
  // the browser will drop the session and the login loop looks like a bug.
  if (env.FRONTEND_URL.startsWith('http://')) {
    issues.push('FRONTEND_URL must be https:// in production — secure cookies are not sent over http')
  }

  /**
   * A half-configured mail provider is worse than none: the store looks like
   * it is sending, and every order confirmation fails at the moment it
   * matters. Checked here so it surfaces on deploy, not on the first sale.
   */
  if (env.EMAIL_PROVIDER === 'smtp') {
    const missing = (
      [
        ['SMTP_HOST', env.SMTP_HOST],
        ['SMTP_USER', env.SMTP_USER],
        ['SMTP_PASSWORD', env.SMTP_PASSWORD],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name)

    if (missing.length > 0) {
      issues.push(`EMAIL_PROVIDER=smtp requires ${missing.join(', ')}`)
    }

    // Most services reject a From address on a domain you have not verified,
    // and the placeholder is the one nobody remembers to change.
    if (env.EMAIL_FROM.includes('example.com')) {
      issues.push('EMAIL_FROM is still a placeholder — set it to an address on a domain you control')
    }
  }

  if (env.PAYMENT_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      issues.push('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET')
    }
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      issues.push(
        'RAZORPAY_WEBHOOK_SECRET is required — without it a payment webhook cannot be verified',
      )
    }
  }

  return issues
}

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail loudly at boot rather than mysteriously at the first request.
  console.error('Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const unsafe = productionIssues(parsed.data)

if (unsafe.length > 0) {
  console.error('\nRefusing to start in production:\n')
  for (const issue of unsafe) console.error(`  • ${issue}`)
  console.error('\nFix these in the environment and redeploy.\n')
  process.exit(1)
}

export const env = parsed.data
export const isProduction = env.NODE_ENV === 'production'
export const isDevelopment = env.NODE_ENV === 'development'
