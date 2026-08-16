import { prisma } from '../config/db.js'
import { logger } from '../config/logger.js'

/**
 * Scheduled publishing (FR-11.2, FR-25.2).
 *
 * A product or page set to SCHEDULED carries the moment it should go live.
 * Something has to notice that moment has passed — without this, `SCHEDULED`
 * is a status that never changes and the feature is a lie told by a dropdown.
 *
 * Deliberately an interval inside the API process rather than a job queue:
 * the work is a single indexed UPDATE, it is idempotent, and running it twice
 * from two instances is harmless because the WHERE clause only matches rows
 * that have not been flipped yet. When this store outgrows one instance, the
 * same function moves behind a cron or a queue unchanged.
 */

/** How often to look. A minute is well inside any sensible publishing SLA. */
const INTERVAL_MS = 60_000

export async function publishDueContent(): Promise<{
  products: number
  pages: number
  showcase: number
}> {
  const now = new Date()

  const [products, pages, showcase] = await Promise.all([
    prisma.product.updateMany({
      where: { status: 'SCHEDULED', scheduledFor: { not: null, lte: now } },
      data: { status: 'ACTIVE', publishedAt: now, scheduledFor: null },
    }),
    prisma.page.updateMany({
      where: { status: 'SCHEDULED', scheduledFor: { not: null, lte: now } },
      data: { status: 'PUBLISHED', publishedAt: now, scheduledFor: null },
    }),
    /**
     * Showcase items carry the same consent guard as the rest of the module,
     * so the WHERE clause repeats it rather than trusting that nothing has
     * changed since the item was scheduled. Consent can be withdrawn between
     * scheduling and the publish window, and this job is the last gate before
     * someone's face appears on the homepage.
     */
    prisma.showcaseItem.updateMany({
      where: {
        status: 'SCHEDULED',
        scheduledFor: { not: null, lte: now },
        consentGrantedAt: { not: null },
      },
      data: { status: 'ACTIVE', publishedAt: now, scheduledFor: null },
    }),
  ])

  if (products.count > 0 || pages.count > 0 || showcase.count > 0) {
    logger.info(
      { products: products.count, pages: pages.count, showcase: showcase.count },
      'Published scheduled content',
    )
  }

  return { products: products.count, pages: pages.count, showcase: showcase.count }
}

let timer: NodeJS.Timeout | null = null

export function startScheduler(): void {
  if (timer) return

  // Run once at boot so a restart after a missed window catches up straight
  // away rather than waiting out the first interval.
  void publishDueContent().catch((err) =>
    logger.error({ err }, 'Scheduled publishing failed at boot'),
  )

  timer = setInterval(() => {
    void publishDueContent().catch((err) =>
      logger.error({ err }, 'Scheduled publishing failed'),
    )
  }, INTERVAL_MS)

  // Must not hold the process open during a graceful shutdown.
  timer.unref()

  logger.info({ everySeconds: INTERVAL_MS / 1000 }, 'Scheduled publishing active')
}

export function stopScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
