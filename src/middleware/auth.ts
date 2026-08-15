import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { UserRole, UserStatus } from '@prisma/client'
import { prisma } from '../config/db.js'
import { ACCESS_COOKIE, verifyAccessToken } from '../utils/tokens.js'
import { AuthenticationError, AuthorizationError } from '../utils/errors.js'

/**
 * Authorization is enforced here, on the server, for every protected endpoint.
 * The admin UI hides controls the user cannot use, but that is cosmetic — this
 * file is what actually stops a hand-rolled request (spec §5).
 *
 * Four things are checked, in order:
 *   1. authentication  — is the access token valid?
 *   2. status          — is the account still active?
 *   3. role            — is this an admin at all?
 *   4. permission      — does this admin hold the specific capability?
 */

export interface AuthedUser {
  id: string
  email: string
  name: string
  role: UserRole
  status: UserStatus
  permissions: Set<string>
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

function readAccessToken(req: Request): string | null {
  const fromCookie = req.cookies?.[ACCESS_COOKIE]
  if (fromCookie) return fromCookie

  // Bearer is supported for non-browser clients and integration tests.
  const header = req.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7)

  return null
}

async function loadUser(userId: string): Promise<AuthedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  })
  if (!user) return null

  // A user's effective permissions are the union across all assigned roles.
  const permissions = new Set<string>()
  for (const assignment of user.roles) {
    for (const rp of assignment.role.permissions) permissions.add(rp.permission.key)
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    permissions,
  }
}

/** Populates req.user when a valid session exists; never rejects. */
export const attachUser: RequestHandler = async (req, _res, next) => {
  const token = readAccessToken(req)
  if (!token) return next()

  const payload = verifyAccessToken(token)
  if (!payload) return next()

  const user = await loadUser(payload.sub)
  // A suspended account must lose access immediately, not at token expiry.
  if (user && user.status === 'ACTIVE') req.user = user

  next()
}

/** Rejects anonymous requests. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new AuthenticationError('You must be signed in to do that'))
  next()
}

/** Rejects anyone who is not an admin account. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new AuthenticationError('You must be signed in to do that'))
  if (req.user.role !== 'ADMIN') return next(new AuthorizationError('Admin access required'))
  next()
}

/**
 * Requires every listed permission. Use the most specific capability that fits
 * the endpoint — `requireAdmin` alone is not sufficient for write operations.
 */
export function requirePermission(...required: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AuthenticationError('You must be signed in to do that'))
    if (req.user.role !== 'ADMIN') return next(new AuthorizationError('Admin access required'))

    const missing = required.filter((p) => !req.user!.permissions.has(p))
    if (missing.length > 0) {
      return next(new AuthorizationError('You do not have permission to do that', { missing }))
    }
    next()
  }
}

/** Convenience stack for admin routers. */
export const adminOnly: RequestHandler[] = [requireAuth, requireAdmin]
