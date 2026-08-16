import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.js'
import { generalLimiter } from '../../middleware/rate-limit.js'
import { noContent } from '../../utils/response.js'
import { ensureAnonymousId, track } from './analytics.service.js'

/**
 * Client-side event ingest (M24).
 *
 * The server already records what it sees (product views, searches). This
 * endpoint is for the events only the browser knows about — add-to-cart from a
 * listing card, checkout step reached, banner clicked.
 *
 * An allow-list of event types, a size cap on the payload, and no PII: the
 * endpoint is public, so it must not be usable as a free write to our database
 * or as a place to stash somebody's data.
 */
export const analyticsRouter: Router = Router()

const EVENT_TYPES = [
  'cart.add',
  'cart.remove',
  'checkout.start',
  'checkout.step',
  'banner.click',
  'filter.apply',
  'wishlist.add',
] as const

const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  entityType: z.enum(['Product', 'Variant', 'Category', 'Page']).optional(),
  entityId: z.string().trim().max(60).optional(),
  properties: z
    .record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .refine((v) => Object.keys(v).length <= 12, 'Too many properties')
    .optional(),
})

analyticsRouter.post('/', generalLimiter, validate({ body: eventSchema }), (req, res) => {
  const body = req.validated!.body as z.infer<typeof eventSchema>

  ensureAnonymousId(req, res)
  track(req, body)

  // Nothing to say back — the client should not wait on analytics.
  return noContent(res)
})
