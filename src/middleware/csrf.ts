import crypto from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { env, isProduction } from '../config/env.js'
import { AuthorizationError } from '../utils/errors.js'

/**
 * CSRF protection (FR-24.3).
 *
 * Sessions live in httpOnly cookies, which browsers attach automatically —
 * that is what makes them convenient and also what makes cross-site request
 * forgery possible. `SameSite=lax` already blocks the classic case, but it
 * stops being protection the moment the storefront and API sit on genuinely
 * different domains and `COOKIE_SAMESITE=none` is required. This is the
 * control that does not depend on that deployment choice.
 *
 * Signed double-submit:
 *
 *   cookie   csrf = <random>.<hmac(random, secret)>   readable by JavaScript
 *   header   x-csrf-token = <the same value>
 *
 * An attacker can make a browser *send* our cookie, but cannot read it to
 * copy into a header — the same-origin policy stops that, and it is the whole
 * basis of the pattern. The HMAC is what stops a plain double-submit being
 * defeated by an attacker who can write cookies from a sibling subdomain: a
 * value they invent will not carry our signature.
 */
export const CSRF_COOKIE = 'csrf'
export const CSRF_HEADER = 'x-csrf-token'

/** GET/HEAD/OPTIONS do not change state, so they are not forgeable in a way that matters. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Paths that authenticate by something other than a cookie, so a browser
 * cannot be tricked into calling them on a user's behalf.
 *
 *   /webhooks  the provider signature is the authentication, and the caller is
 *              a server that has no cookie jar
 */
const EXEMPT_PREFIXES = ['/webhooks']

function sign(value: string): string {
  return crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(value).digest('base64url')
}

export function issueToken(): string {
  const random = crypto.randomBytes(24).toString('base64url')
  return `${random}.${sign(random)}`
}

function isWellFormed(token: string): boolean {
  const [random, signature] = token.split('.')
  if (!random || !signature) return false

  const expected = sign(random)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function equal(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Ensures every browser has a token to send back.
 *
 * Deliberately NOT httpOnly — the client has to read it to put it in a header,
 * and that is safe: knowing your own token is useless to an attacker who
 * cannot read it from another origin. It is bound to nothing else, so it can
 * be issued before sign-in and survive it.
 */
export const issueCsrfToken: RequestHandler = (req, res, next) => {
  const existing = req.cookies?.[CSRF_COOKIE]

  if (typeof existing !== 'string' || !isWellFormed(existing)) {
    const token = issueToken()
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: isProduction || env.COOKIE_SAMESITE === 'none',
      sameSite: env.COOKIE_SAMESITE,
      path: '/',
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
      maxAge: 24 * 60 * 60 * 1000,
    })
    // Make it readable to the rest of this request, not just the next one.
    req.cookies = { ...(req.cookies ?? {}), [CSRF_COOKIE]: token }
  }

  next()
}

/** Rejects a state-changing request whose header does not match its cookie. */
export function verifyCsrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next()
  if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next()

  /**
   * A Bearer token is never attached automatically by a browser, so a request
   * carrying one cannot have been forged by a third-party site. Integration
   * tests and non-browser clients use this path.
   */
  if (req.get('authorization')?.startsWith('Bearer ')) return next()

  const cookie = req.cookies?.[CSRF_COOKIE]
  const header = req.get(CSRF_HEADER)

  if (typeof cookie !== 'string' || typeof header !== 'string' || !cookie || !header) {
    return next(
      new AuthorizationError(
        'Your session could not be verified. Refresh the page and try again.',
        { reason: 'CSRF_TOKEN_MISSING' },
      ),
    )
  }

  if (!isWellFormed(cookie) || !equal(cookie, header)) {
    return next(
      new AuthorizationError(
        'Your session could not be verified. Refresh the page and try again.',
        { reason: 'CSRF_TOKEN_INVALID' },
      ),
    )
  }

  next()
}
