import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { baseCookie } from '../../utils/tokens.js'

/**
 * First-party analytics (M24).
 *
 * Deliberately minimal and deliberately ours: product views, searches and
 * add-to-cart, stored in our own database, so the reports do not depend on a
 * third party and no customer data leaves the server.
 *
 * Two rules:
 *   - writes are fire-and-forget; a tracking failure must never affect a page
 *   - `properties` carries behaviour, never personal data. Search terms and
 *     product ids, not names, emails or addresses.
 */

/** Distinguishes browsers without identifying people. Rotates every 90 days. */
export const ANALYTICS_COOKIE = 'aid'

export function ensureAnonymousId(req: Request, res: Response): string {
  const existing = req.cookies?.[ANALYTICS_COOKIE]
  if (typeof existing === 'string' && existing.length >= 16) return existing

  const id = crypto.randomUUID()
  res.cookie(ANALYTICS_COOKIE, id, {
    ...baseCookie,
    // Not httpOnly-sensitive, but there is no reason for scripts to read it.
    maxAge: 90 * 24 * 60 * 60 * 1000,
  })
  return id
}

export interface TrackInput {
  type: string
  entityType?: string
  entityId?: string
  properties?: Record<string, unknown>
}

export function track(req: Request, input: TrackInput): void {
  void prisma.analyticsEvent
    .create({
      data: {
        type: input.type,
        userId: req.user?.id ?? null,
        anonymousId: req.cookies?.[ANALYTICS_COOKIE] ?? null,
        sessionId: null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        properties: (input.properties ?? undefined) as never,
      },
    })
    .catch((err) => logger.debug({ err, type: input.type }, 'Analytics write failed'))
}
