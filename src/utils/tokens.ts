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

export function signAccessToken(userId: string, role: UserRole): string {
  const payload: AccessTokenPayload = { sub: userId, role, type: 'access' }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
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
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
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

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookie,
    maxAge: 15 * 60 * 1000,
  })
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  })
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie })
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie })
}
