import { env } from '../config/env.js'

/**
 * One phone number, written one way.
 *
 * The same person books once as "9994411585" and again as "+919994411585",
 * and WhatsApp hands us back "whatsapp:+919994411585". Three spellings of one
 * customer, which is three separate conversations unless they are reduced to
 * a single form first.
 *
 * Returns E.164 with the leading plus, or null for something that cannot be a
 * phone number. Null rather than a best guess: a wrong number silently
 * attaches a stranger's messages to a booking.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null

  const trimmed = raw.trim().replace(/^whatsapp:/i, '')
  if (!trimmed) return null

  const hadPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  if (!hadPlus) {
    // A single leading zero is trunk notation for a domestic call, not part
    // of the number.
    digits = digits.replace(/^0+/, '')
    // Ten digits in India means the country code was left off, which is how
    // most people write their own mobile number.
    if (digits.length <= 10) digits = `${env.WHATSAPP_DEFAULT_COUNTRY_CODE}${digits}`
  }

  // E.164 allows at most fifteen digits, and a country code is at least one.
  if (digits.length < 8 || digits.length > 15) return null

  return `+${digits}`
}
