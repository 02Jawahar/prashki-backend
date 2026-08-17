import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { prisma, setDatabaseUrl } from './config/db.js'
import { ensureDatabase, waitForDatabase } from './config/embedded-db.js'
import { registerEventHandlers } from './events/handlers.js'
import { assertConsoleEmailIsSafe, verifyEmailProvider } from './integrations/notifications/index.js'
import { assertShippingConfigured } from './integrations/shipping/index.js'
import { startScheduler, stopScheduler } from './jobs/scheduler.js'

// In development the API owns the database lifecycle, so `npm run dev` is the
// only command needed. In production DATABASE_URL is used as-is.
const db = await ensureDatabase()

// The resolved URL may differ from the configured one when a port was taken.
setDatabaseUrl(db.url)

// Refuse to serve traffic we cannot fulfil.
try {
  await waitForDatabase(() => prisma.$queryRaw`SELECT 1`)
} catch (err) {
  logger.fatal(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// A carrier named in the environment but not registered is a configuration
// error, and it should surface at boot rather than when the first parcel is
// packed.
try {
  assertShippingConfigured()
} catch (err) {
  logger.fatal(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// Subscribe side effects (email, SMS) to business events before serving.
registerEventHandlers()

// Says so at boot if production is not actually delivering mail.
assertConsoleEmailIsSafe()
void verifyEmailProvider()

// Flips SCHEDULED products and pages to live once their moment passes.
startScheduler()

const app = createApp()

const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT}/api/v1`)
  logger.info(`CORS origin: ${env.FRONTEND_URL}`)
})

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`${signal} received — shutting down`)

  stopScheduler()

  server.close(async () => {
    await prisma.$disconnect()
    // The database is deliberately left running. It is shared across API
    // restarts, and a postmaster killed rather than shut down leaves a bound
    // socket and a held shared-memory block that block the next start.
    // Use `npm run db:stop` to shut it down explicitly.
    process.exit(0)
  })

  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'))
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception')
  void shutdown('uncaughtException')
})
