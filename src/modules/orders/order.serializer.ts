import { maskAddressSnapshot, maskContact } from '../../utils/pii.js'

/**
 * Two audiences, two shapes.
 *
 * The customer owns their own data, so nothing about their order is masked —
 * but staff-only fields must never appear in a response they can read. Admins
 * see everything except raw contact details, unless they hold
 * `customer.read_pii`.
 */

/** Drops staff-only fields before an order goes to the customer who placed it. */
export function forCustomer<T extends Record<string, unknown>>(order: T): Omit<T, 'internalNotes'> {
  const { internalNotes: _staffOnly, ...rest } = order
  return rest
}

export function forAdmin<T extends Record<string, any>>(order: T, permissions: Set<string> | undefined): T {
  return {
    ...order,
    ...(order.user ? { user: maskContact(order.user, permissions) } : {}),
    ...(order.shippingAddressSnapshot
      ? { shippingAddressSnapshot: maskAddressSnapshot(order.shippingAddressSnapshot, permissions) }
      : {}),
    ...(order.billingAddressSnapshot
      ? { billingAddressSnapshot: maskAddressSnapshot(order.billingAddressSnapshot, permissions) }
      : {}),
  }
}
