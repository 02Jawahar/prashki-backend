/**
 * Personal-data masking.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   mask*        — for logs and audit metadata. Enough of the value survives
 *                  that a human can correlate records, not enough to identify
 *                  anyone from the log alone.
 *   maskFor(role)— for API responses. Staff without the customer.read_pii
 *                  permission see masked contact details on order and customer
 *                  screens; the full value never leaves the server for them.
 *
 * Masking is not a substitute for access control — it is the second layer
 * behind it, so a permission mistake leaks a shape rather than a phone number.
 */

/** jane.doe@example.com → j******e@example.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'

  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return `${local[0]}*${domain}`

  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 8))}${local.at(-1)}${domain}`
}

/** +91 98765 43210 → +91 ***** 43210 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '*'.repeat(digits.length)
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

/** Keeps the house number out of the log while leaving the locality readable. */
export function maskAddressLine(line: string | null | undefined): string | null {
  if (!line) return null
  return line.length <= 4 ? '***' : `${line.slice(0, 2)}${'*'.repeat(Math.min(line.length - 2, 12))}`
}

export interface Maskable {
  email?: string | null
  phone?: string | null
  name?: string | null
}

/**
 * Applies masking unless the caller holds the permission that grants raw PII.
 * `permissions` is the set already attached to the request by the auth
 * middleware, so this never re-queries.
 */
export function maskContact<T extends Maskable>(
  record: T,
  permissions: Set<string> | undefined,
): T {
  if (permissions?.has('customer.read_pii')) return record
  return {
    ...record,
    ...(record.email !== undefined ? { email: maskEmail(record.email) } : {}),
    ...(record.phone !== undefined ? { phone: maskPhone(record.phone) } : {}),
  }
}

/** Same idea for the frozen address snapshot stored on an order. */
export function maskAddressSnapshot(
  snapshot: unknown,
  permissions: Set<string> | undefined,
): unknown {
  if (permissions?.has('customer.read_pii')) return snapshot
  if (!snapshot || typeof snapshot !== 'object') return snapshot

  const a = snapshot as Record<string, unknown>
  return {
    ...a,
    phone: maskPhone(a.phone as string | null),
    addressLine1: maskAddressLine(a.addressLine1 as string | null),
    addressLine2: maskAddressLine(a.addressLine2 as string | null),
  }
}
