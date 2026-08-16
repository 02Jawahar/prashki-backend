import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * Account erasure (PRD Privacy — DPDP right to erasure).
 *
 * The account is anonymised rather than deleted, for two reasons that pull in
 * the same direction:
 *
 *   - Orders reference the user without a cascade, and they have to survive.
 *     Sales records are what the books are built from, and India's tax rules
 *     require keeping them for years after the customer has gone.
 *   - Deleting the row would also delete the evidence that the erasure was
 *     performed, which is the one thing worth keeping.
 *
 * So every field that identifies a person is overwritten, everything that only
 * exists to serve that person is deleted, and the financial skeleton stays. An
 * erased account cannot be signed into: the password hash is replaced with a
 * value no password produces and every refresh token is revoked.
 *
 * This is irreversible on purpose. There is no undo, because an undo would
 * mean the data was still there.
 */

/// Orders in these states still need a customer we can contact.
const OPEN_ORDER_STATUSES: Prisma.OrderWhereInput['status'] = {
  in: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'],
}

const OPEN_RETURN_STATUSES: Prisma.ReturnRequestWhereInput['status'] = {
  in: ['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED'],
}

export interface ErasureBlocker {
  reason: string
  count: number
}

/**
 * Reasons this account cannot be erased right now.
 *
 * An in-flight order is the main one: erasing the address a parcel is being
 * delivered to does not stop the parcel, it just means nobody can answer a
 * question about it. These resolve on their own once the order completes, so
 * the customer is told to wait rather than refused outright.
 */
export async function erasureBlockers(userId: string): Promise<ErasureBlocker[]> {
  const [openOrders, openReturns, staffRoles] = await Promise.all([
    prisma.order.count({ where: { userId, status: OPEN_ORDER_STATUSES } }),
    prisma.returnRequest.count({ where: { userId, status: OPEN_RETURN_STATUSES } }),
    prisma.userRoleAssignment.count({ where: { userId } }),
  ])

  const blockers: ErasureBlocker[] = []

  if (openOrders > 0) {
    blockers.push({
      reason: 'There are orders still in progress. Erasure is available once they complete.',
      count: openOrders,
    })
  }

  if (openReturns > 0) {
    blockers.push({
      reason: 'There is an open return. Erasure is available once it is resolved.',
      count: openReturns,
    })
  }

  if (staffRoles > 0) {
    // A staff account's audit trail is the point of it. Remove the roles first,
    // deliberately, rather than as a side effect of a self-service button.
    blockers.push({
      reason: 'This account holds staff roles. Remove them before erasing it.',
      count: staffRoles,
    })
  }

  return blockers
}

/** Placeholder text written over an address snapshot's personal fields. */
const REDACTED = '[erased]'

/**
 * Redacts the personal fields inside a frozen order address.
 *
 * The snapshot is not replaced wholesale: city, state and postcode drive the
 * tax and shipping figures on the order, so removing them would make the
 * order's own arithmetic unverifiable. Name, phone and street are what
 * identify a person, and those go.
 */
function redactAddressSnapshot(snapshot: Prisma.JsonValue): Prisma.InputJsonValue {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {} as Prisma.InputJsonValue
  }

  return {
    ...(snapshot as Record<string, unknown>),
    name: REDACTED,
    phone: REDACTED,
    email: REDACTED,
    addressLine1: REDACTED,
    addressLine2: null,
    label: null,
  } as Prisma.InputJsonValue
}

export interface ErasureResult {
  userId: string
  anonymisedAt: Date
  ordersRedacted: number
  addressesDeleted: number
  reviewsDeleted: number
}

/**
 * Performs the erasure.
 *
 * One transaction: a half-erased account is worse than either outcome, because
 * the customer is told it is done and the data is still there.
 */
export async function eraseAccount(
  userId: string,
  options: { performedBy: string; reason?: string },
): Promise<ErasureResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new NotFoundError('Account', 'USER_NOT_FOUND')

  if (user.anonymisedAt) {
    throw new ConflictError('That account has already been erased', 'ALREADY_ANONYMISED')
  }

  const blockers = await erasureBlockers(userId)
  if (blockers.length > 0) {
    throw new ValidationError('This account cannot be erased yet', {
      code: 'ERASURE_BLOCKED',
      blockers: blockers.map((b) => b.reason),
    })
  }

  const anonymisedAt = new Date()

  return prisma.$transaction(async (tx) => {
    // Orders keep their money and their dates; they lose the person.
    const orders = await tx.order.findMany({
      where: { userId },
      select: { id: true, shippingAddressSnapshot: true, billingAddressSnapshot: true },
    })

    for (const order of orders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          shippingAddressSnapshot: redactAddressSnapshot(order.shippingAddressSnapshot),
          billingAddressSnapshot: order.billingAddressSnapshot
            ? redactAddressSnapshot(order.billingAddressSnapshot)
            : undefined,
          notes: null,
          internalNotes: null,
        },
      })
    }

    // Everything that exists only to serve this customer.
    const [addresses, reviews] = await Promise.all([
      tx.address.deleteMany({ where: { userId } }),
      tx.review.deleteMany({ where: { userId } }),
      tx.wishlistItem.deleteMany({ where: { userId } }),
      tx.notification.deleteMany({ where: { userId } }),
      tx.notificationPreference.deleteMany({ where: { userId } }),
      tx.passwordResetToken.deleteMany({ where: { userId } }),
      tx.customerNote.deleteMany({ where: { userId } }),
      tx.cart.deleteMany({ where: { userId } }),
      // Revoking rather than deleting: an active session must stop working
      // immediately, and the refresh-token family is how that is enforced.
      tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: anonymisedAt },
      }),
    ])

    /**
     * Consents are kept, with their subject removed.
     *
     * "This person consented to marketing on this date" is the record that
     * proves we were allowed to send it — deleting it alongside the account
     * destroys our own defence. The user link stays (the row needs it); what it
     * points at no longer identifies anyone.
     *
     * The IP and user agent go, though. Those identify a person on their own,
     * independently of the account they are attached to, and they are not what
     * makes the consent record proof of anything.
     */
    await tx.consent.updateMany({ where: { userId }, data: { ip: null, userAgent: null } })

    await tx.user.update({
      where: { id: userId },
      data: {
        // The email must stay unique and must not be the real one. The user id
        // is already unique and is not derived from anything personal.
        name: 'Erased account',
        email: `erased+${userId}@invalid.local`,
        phone: null,
        // No password produces this hash — argon2 verification fails on it
        // rather than throwing, so sign-in returns the normal wrong-password
        // answer instead of a 500.
        passwordHash: 'erased',
        status: 'ANONYMISED',
        emailVerified: false,
        anonymisedAt,
      },
    })

    // Written inside the transaction so the record cannot outlive a rollback,
    // or the reverse.
    await tx.auditLog.create({
      data: {
        userId: options.performedBy === userId ? null : options.performedBy,
        action: 'ACCOUNT_ANONYMISED',
        entityType: 'User',
        entityId: userId,
        metadata: {
          selfService: options.performedBy === userId,
          reason: options.reason ?? null,
          ordersRedacted: orders.length,
        } as Prisma.InputJsonValue,
      },
    })

    return {
      userId,
      anonymisedAt,
      ordersRedacted: orders.length,
      addressesDeleted: addresses.count,
      reviewsDeleted: reviews.count,
    }
  })
}

/**
 * Everything the store holds about one customer, for the DPDP right of access.
 *
 * Assembled on request rather than stored, so it cannot go stale, and scoped to
 * one user id so it can never be turned into a bulk export by changing a
 * parameter.
 */
export async function exportAccountData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      emailVerified: true,
      createdAt: true,
      lastLoginAt: true,
    },
  })

  if (!user) throw new NotFoundError('Account', 'USER_NOT_FOUND')

  const [addresses, orders, reviews, consents, wishlist, notificationPrefs] = await Promise.all([
    prisma.address.findMany({ where: { userId } }),
    prisma.order.findMany({
      where: { userId },
      include: { items: true, payments: { select: { id: true, status: true, amount: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.findMany({ where: { userId } }),
    prisma.consent.findMany({ where: { userId } }),
    prisma.wishlistItem.findMany({ where: { userId } }),
    prisma.notificationPreference.findMany({ where: { userId } }),
  ])

  return {
    exportedAt: new Date(),
    account: user,
    addresses,
    orders,
    reviews,
    consents,
    wishlist,
    notificationPreferences: notificationPrefs,
  }
}
