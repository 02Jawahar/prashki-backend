import type { Request } from 'express'
import type { User } from '@prisma/client'
import { hash, verify } from '@node-rs/argon2'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
  signAccessToken,
} from '../../utils/tokens.js'
import { AuthenticationError, ConflictError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import type { LoginInput, RegisterInput } from './auth.schemas.js'

export interface SessionTokens {
  accessToken: string
  refreshToken: string
}

export interface PublicUser {
  id: string
  name: string
  email: string
  phone: string | null
  role: User['role']
  emailVerified: boolean
  permissions: string[]
}

export function toPublicUser(user: User, permissions: string[] = []): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    emailVerified: user.emailVerified,
    permissions,
  }
}

export async function permissionsFor(userId: string): Promise<string[]> {
  const rows = await prisma.userRoleAssignment.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  const set = new Set<string>()
  for (const row of rows) for (const rp of row.role.permissions) set.add(rp.permission.key)
  return [...set]
}

async function issueSession(
  user: User,
  req: Request,
  family?: string,
): Promise<SessionTokens> {
  const accessToken = signAccessToken(user.id, user.role)
  const refresh = generateRefreshToken()

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      // Reusing the family keeps a rotation chain linked so token reuse is detectable.
      family: family ?? refresh.family,
      expiresAt: refreshExpiry(),
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    },
  })

  return { accessToken, refreshToken: refresh.token }
}

export async function register(
  input: RegisterInput,
  req: Request,
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) throw new ConflictError('An account with that email already exists', 'EMAIL_TAKEN')

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone?.trim() || null,
      passwordHash: await hash(input.password),
      // Self-service registration can only ever create a customer. Admin
      // accounts are made by other admins or by the seed — never by this route.
      role: 'CUSTOMER',
    },
  })

  recordAudit({ userId: user.id, action: 'USER_REGISTERED', entityType: 'User', entityId: user.id, req })

  return { user: toPublicUser(user), tokens: await issueSession(user, req) }
}

export async function login(
  input: LoginInput,
  req: Request,
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } })

  // Same failure for "no such user" and "wrong password" so the endpoint can't
  // be used to enumerate which emails have accounts.
  const invalid = new AuthenticationError('Email or password is incorrect', 'INVALID_CREDENTIALS')
  if (!user) {
    // Burn comparable time so timing doesn't leak account existence either.
    await hash(input.password).catch(() => undefined)
    throw invalid
  }

  const passwordOk = await verify(user.passwordHash, input.password).catch(() => false)
  if (!passwordOk) throw invalid

  if (user.status !== 'ACTIVE') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED')
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  if (user.role === 'ADMIN') {
    recordAudit({ userId: user.id, action: 'ADMIN_LOGIN', entityType: 'User', entityId: user.id, req })
  }

  const permissions = user.role === 'ADMIN' ? await permissionsFor(user.id) : []
  return { user: toPublicUser(user, permissions), tokens: await issueSession(user, req) }
}

/**
 * Rotates a refresh token.
 *
 * If a token that has already been rotated is presented again, that is the
 * signature of a stolen token being replayed — the whole family is revoked so
 * both the attacker and the victim are logged out and the theft surfaces.
 */
export async function refresh(
  rawToken: string,
  req: Request,
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const tokenHash = hashRefreshToken(rawToken)
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })

  if (!stored) throw new AuthenticationError('Session expired, please sign in again', 'INVALID_REFRESH_TOKEN')

  if (stored.revokedAt) {
    logger.warn({ userId: stored.userId, family: stored.family }, 'Refresh token reuse detected')
    await prisma.refreshToken.updateMany({
      where: { family: stored.family, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    recordAudit({
      userId: stored.userId,
      action: 'REFRESH_TOKEN_REUSE',
      entityType: 'User',
      entityId: stored.userId,
      metadata: { family: stored.family },
      req,
    })
    throw new AuthenticationError('Session expired, please sign in again', 'TOKEN_REUSE_DETECTED')
  }

  if (stored.expiresAt < new Date()) {
    throw new AuthenticationError('Session expired, please sign in again', 'REFRESH_TOKEN_EXPIRED')
  }

  if (stored.user.status !== 'ACTIVE') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED')
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  })

  const permissions = stored.user.role === 'ADMIN' ? await permissionsFor(stored.user.id) : []
  return {
    user: toPublicUser(stored.user, permissions),
    tokens: await issueSession(stored.user, req, stored.family),
  }
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Signs the user out of every device. */
export async function logoutAll(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  req: Request,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })

  const ok = await verify(user.passwordHash, currentPassword).catch(() => false)
  if (!ok) throw new AuthenticationError('Current password is incorrect', 'INVALID_CREDENTIALS')

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hash(newPassword) },
  })

  // Changing a password should end every other session.
  await logoutAll(userId)
  recordAudit({ userId, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: userId, req })
}
