import type { Request } from 'express'
import type { User } from '@prisma/client'
import { hash, verify } from '@node-rs/argon2'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import {
  generateOpaqueToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
  sha256,
  signAccessToken,
} from '../../utils/tokens.js'
import { AuthenticationError, ConflictError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { env } from '../../config/env.js'
import { sendMessage } from '../messaging/message.service.js'
import { maskEmail } from '../../utils/pii.js'
import type { LoginInput, RegisterInput, UpdateProfileInput } from './auth.schemas.js'

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
      // Admin sessions are shorter — see accessTtl/refreshTtlDays.
      expiresAt: refreshExpiry(user.role),
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

/** How long a reset link stays usable. Short, because email is not a vault. */
const RESET_TTL_MINUTES = 60

/**
 * Starts a password reset (FR-2.6).
 *
 * The caller is always told the same thing, whether or not the address has an
 * account — otherwise this endpoint becomes an account-enumeration oracle, the
 * exact leak the login endpoint is careful to avoid.
 */
export async function requestPasswordReset(email: string, req: Request): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || user.status !== 'ACTIVE') {
    logger.info({ email: maskEmail(email) }, 'Password reset requested for unknown or inactive account')
    return
  }

  // Any link already in flight is dead the moment a new one is issued, so a
  // forwarded or intercepted older email cannot be used.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { token, hash } = generateOpaqueToken()
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      ip: req.ip ?? null,
    },
  })

  const url = `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=${token}`

  // Goes through the messaging layer so the copy is editable from admin and the
  // send is logged — "I never got the email" needs an answer.
  await sendMessage({
    channel: 'EMAIL',
    key: 'account.password_reset',
    recipient: user.email,
    userId: user.id,
    variables: { name: user.name, url, expiresInMinutes: RESET_TTL_MINUTES },
    entityType: 'User',
    entityId: user.id,
  }).catch((err) => logger.error({ err, userId: user.id }, 'Password reset email failed'))

  recordAudit({
    userId: user.id,
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'User',
    entityId: user.id,
    req,
  })
}

/**
 * Completes a password reset. Every failure mode returns the same error, so a
 * guessed token cannot be distinguished from an expired one.
 */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
  req: Request,
): Promise<void> {
  const invalid = new ValidationError('That reset link is invalid or has expired')

  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { user: true },
  })
  if (!stored || stored.usedAt || stored.expiresAt < new Date()) throw invalid
  if (stored.user.status !== 'ACTIVE') throw invalid

  const passwordHash = await hash(newPassword)

  await prisma.$transaction([
    // Marking used inside the transaction is what makes the link single-use
    // even if two requests arrive together.
    prisma.passwordResetToken.update({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])

  recordAudit({
    userId: stored.userId,
    action: 'PASSWORD_RESET_COMPLETED',
    entityType: 'User',
    entityId: stored.userId,
    req,
  })
}

/**
 * Profile self-service (FR-2.7). Email is deliberately not editable here —
 * changing it is an identity change and needs its own verification flow.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
  req: Request,
): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() || null } : {}),
    },
  })

  recordAudit({
    userId,
    action: 'PROFILE_UPDATED',
    entityType: 'User',
    entityId: userId,
    metadata: { fields: Object.keys(input) },
    req,
  })

  const permissions = user.role === 'ADMIN' ? await permissionsFor(userId) : []
  return toPublicUser(user, permissions)
}
