import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { pinoHttp } from 'pino-http'
import { env, isProduction } from './config/env.js'
import { logger } from './config/logger.js'
import { prisma } from './config/db.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'
import { generalLimiter } from './middleware/rate-limit.js'
import { ok } from './utils/response.js'
import { apiRouter } from './routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export function createApp() {
  const app = express()

  // We sit behind a proxy in production; needed for correct client IPs in
  // rate limiting and for `secure` cookies to be set.
  app.set('trust proxy', isProduction ? 1 : false)
  app.disable('x-powered-by')

  app.use(
    helmet({
      // Images are served cross-origin to the Next.js dev server.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: isProduction ? undefined : false,
    }),
  )

  // Credentials are cookies, so the origin must be explicit — never '*' (spec §65).
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  )

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req: { url?: string }) => req.url === '/health' },
    }),
  )

  /**
   * The Razorpay webhook signature is computed over the exact raw bytes, so it
   * must be mounted before the JSON parser can rewrite the body (spec §32).
   */
  app.use(
    '/api/v1/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
  )

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))
  app.use(cookieParser())

  app.use(generalLimiter)

  // Local file storage. Swapped out entirely when STORAGE_PROVIDER is s3/r2.
  if (env.STORAGE_PROVIDER === 'local') {
    app.use(
      '/uploads',
      express.static(path.resolve(here, '..', env.STORAGE_LOCAL_DIR), {
        maxAge: isProduction ? '30d' : 0,
        index: false,
        dotfiles: 'deny',
      }),
    )
  }

  app.get('/health', async (_req, res, next) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      ok(res, { status: 'ok', database: 'up', env: env.NODE_ENV })
    } catch (err) {
      next(err)
    }
  })

  app.use('/api/v1', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
