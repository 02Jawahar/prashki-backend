import rateLimit, { type Options } from 'express-rate-limit'
import { fail } from '../utils/response.js'
import { isProduction } from '../config/env.js'

const handler: Options['handler'] = (_req, res) =>
  fail(res, 429, 'RATE_LIMITED', 'Too many requests, please slow down')

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
} as const

/** Broad protection for the whole API surface. */
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: isProduction ? 300 : 5_000,
})

/**
 * Credential endpoints get a much tighter budget — this is the brute-force
 * protection Express's production guidance calls for (spec §48).
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: isProduction ? 10 : 200,
  skipSuccessfulRequests: true,
})

/** Writes are cheaper to abuse than reads. */
export const writeLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: isProduction ? 60 : 1_000,
})
