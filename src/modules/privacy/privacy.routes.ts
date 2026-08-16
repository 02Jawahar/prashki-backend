import { Router } from 'express'
import { z } from 'zod'
import { verify } from '@node-rs/argon2'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth, requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { ok } from '../../utils/response.js'
import { AuthenticationError, NotFoundError } from '../../utils/errors.js'
import { clearAuthCookies } from '../../utils/tokens.js'
import { eraseAccount, erasureBlockers, exportAccountData } from './privacy.service.js'

/**
 * The customer's own data rights (DPDP: access and erasure).
 *
 * Both routes act on `req.user.id` only. There is no id parameter to change,
 * because the whole risk with these two endpoints is one customer reaching
 * another's data — the admin equivalents live below, behind a permission.
 */
export const privacyRouter: Router = Router()

privacyRouter.use(requireAuth)

/** Right of access — everything we hold, as JSON. */
privacyRouter.get('/export', writeLimiter, async (req, res) => {
  const data = await exportAccountData(req.user!.id)

  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"')
  return ok(res, data)
})

/**
 * Whether erasure is available, and if not, why.
 *
 * Offered separately from the erasure itself so the UI can explain the wait
 * before the customer commits to something irreversible.
 */
privacyRouter.get('/erasure', async (req, res) => {
  const blockers = await erasureBlockers(req.user!.id)
  return ok(res, { canErase: blockers.length === 0, blockers })
})

const eraseSchema = z.object({
  /**
   * Re-authentication. This is the one action with no undo, so a borrowed
   * session is not enough — the person at the keyboard has to know the
   * password.
   */
  password: z.string().min(1, 'Confirm your password to continue'),
  reason: z.string().trim().max(500).optional(),
})

privacyRouter.post(
  '/erasure',
  writeLimiter,
  validate({ body: eraseSchema }),
  async (req, res) => {
    const { password, reason } = req.validated!.body as z.infer<typeof eraseSchema>
    const userId = req.user!.id

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundError('Account', 'USER_NOT_FOUND')

    const correct = await verify(user.passwordHash, password).catch(() => false)
    if (!correct) throw new AuthenticationError('That password is not correct', 'INVALID_CREDENTIALS')

    const result = await eraseAccount(userId, { performedBy: userId, reason })

    // The session is already dead — every refresh token was revoked inside the
    // transaction. Clearing the cookies stops the browser retrying with them.
    clearAuthCookies(res)

    return ok(res, {
      erased: true,
      anonymisedAt: result.anonymisedAt,
      ordersRedacted: result.ordersRedacted,
      message:
        'Your personal details have been removed. Order records are kept without them, as the law requires.',
    })
  },
)

// ─────────────────────────────────────────────────────────────────── admin

/**
 * Erasure carried out on the customer's behalf — a request over email or the
 * phone, which is how most of them arrive.
 */
export const adminPrivacyRouter: Router = Router()

const adminEraseSchema = z.object({
  reason: z.string().trim().min(1, 'Record why this was done').max(500),
})

adminPrivacyRouter.get('/:id/erasure', requirePermission('customer.read'), async (req, res) => {
  const { id } = req.params as { id: string }
  const blockers = await erasureBlockers(id)
  return ok(res, { canErase: blockers.length === 0, blockers })
})

adminPrivacyRouter.post(
  '/:id/erasure',
  writeLimiter,
  // Deliberately the update permission rather than a delete one: this is the
  // most destructive thing an admin can do to a customer record, and it should
  // sit with the people who already manage those records rather than in a
  // separate permission that gets handed out casually.
  requirePermission('customer.update'),
  validate({ body: adminEraseSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { reason } = req.validated!.body as z.infer<typeof adminEraseSchema>

    const result = await eraseAccount(id, { performedBy: req.user!.id, reason })

    return ok(res, result)
  },
)
