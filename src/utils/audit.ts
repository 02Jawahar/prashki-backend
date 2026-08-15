import type { Request } from 'express'
import { prisma } from '../config/db.js'
import { logger } from '../config/logger.js'

/**
 * Audit trail (spec §44).
 *
 * Deliberately fire-and-forget: an audit write must never be the reason a
 * customer's order fails. Failures are logged loudly instead.
 *
 * Never pass secrets, tokens or password hashes in `metadata`.
 */
export interface AuditInput {
  userId?: string | null
  action: string
  entityType: string
  entityId: string
  metadata?: Record<string, unknown>
  req?: Request
}

export function recordAudit({ userId, action, entityType, entityId, metadata, req }: AuditInput) {
  const data = {
    userId: userId ?? req?.user?.id ?? null,
    action,
    entityType,
    entityId,
    metadata: (metadata ?? undefined) as never,
    ip: req?.ip ?? null,
    userAgent: req?.get('user-agent') ?? null,
  }

  void prisma.auditLog
    .create({ data })
    .catch((err) => logger.error({ err, action, entityType, entityId }, 'Audit write failed'))
}

/** Diff helper so update logs record what actually changed, not the whole row. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {}
  for (const [key, value] of Object.entries(after)) {
    if (value !== undefined && before[key] !== value) {
      diff[key] = { from: before[key], to: value }
    }
  }
  return diff
}
