import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Response } from 'express'
import type { UserRole } from '@prisma/client'
import { env, isProduction } from '../config/env.js'

/**
 * Two-token session (spec §34).
 *
 *   access  — short-lived signed JWT, carries identity, never stored server-side
 *   refresh — long-lived opaque random string, stored HASHED, rotated on use
 *
 * Both travel as httpOnly cookies so no token is ever readable from JavaScript,
 * which takes XSS-driven token theft off the table.
 */
export const ACCESS_COOKIE = 'at'
export const REFRESH_COOKIE = 'rt'

export interface AccessTokenPayload {
  sub: string
  role: UserRole
  type: 'access'
}

/**
 * Session lifetimes, by role.
 *
 * Admin sessions are shorter than customer sessions (M10). Everything that
 * issues or renews a session reads these, so the two never drift apart.
 */
export function accessTtl(role: UserRole): string {
  return role === 'ADMIN' ? env.ADMIN_ACCESS_TOKEN_TTL : env.ACCESS_TOKEN_TTL
}

export function refreshTtlDays(role: UserRole): number {
  return role === 'ADMIN' ? env.ADMIN_REFRESH_TOKEN_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS
}

export function signAccessToken(userId: string, role: UserRole): string {
  const payload: AccessTokenPayload = { sub: userId, role, type: 'access' }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: accessTtl(role) as jwt.SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload
    return decoded.type === 'access' && decoded.sub ? decoded : null
  } catch {
    return null
  }
}

/**
 * The refresh token is high-entropy random, so a fast hash is the right tool —
 * it needs pre-image resistance, not the brute-force cost of a password hash.
 */
export function generateRefreshToken(): { token: string; hash: string; family: string } {
  const token = crypto.randomBytes(48).toString('base64url')
  return {
    token,
    hash: hashRefreshToken(token),
    family: crypto.randomUUID(),
  }
}

export function hashRefreshToken(token: string): string {
  return sha256(token)
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * A single-use, high-entropy token for password resets and email verification.
 * Same reasoning as the refresh token: only the hash is stored, so a database
 * leak yields nothing usable.
 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url')
  return { token, hash: sha256(token) }
}

export function refreshExpiry(role: UserRole): Date {
  return new Date(Date.now() + refreshTtlDays(role) * 24 * 60 * 60 * 1000)
}

/**
 * SameSite=none is only honoured on secure cookies, so it implies HTTPS —
 * force `secure` rather than silently producing a cookie browsers discard.
 */
export const baseCookie = {
  httpOnly: true,
  secure: isProduction || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE,
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
} as const

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  role: UserRole = 'CUSTOMER',
) {
  /**
   * The cookie outlives the access token on purpose — the browser keeps
   * sending it, the server rejects it, and the client refreshes once. Tying
   * the cookie to the token's own lifetime would make every expiry look like
   * a logout.
   */
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookie,
    maxAge: refreshTtlDays(role) * 24 * 60 * 60 * 1000,
  })
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie,
    maxAge: refreshTtlDays(role) * 24 * 60 * 60 * 1000,
  })
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie })
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie })
}
