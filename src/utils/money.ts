/**
 * Money is integer paise everywhere (spec §10). Never floats — a rounding drift
 * in an order total is a support problem, not a rounding problem.
 *
 *   ₹15,000.00  ->  1500000
 */
export type Paise = number

export const rupeesToPaise = (rupees: number): Paise => Math.round(rupees * 100)
export const paiseToRupees = (paise: Paise): number => paise / 100

/**
 * Discount is always derived from the two prices, never stored (spec §10),
 * so it can't drift out of sync with them.
 */
export function discountPercent(price: Paise, compareAtPrice?: Paise | null): number {
  if (!compareAtPrice || compareAtPrice <= price) return 0
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
}

export function formatPaise(paise: Paise): string {
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100)}`
}

/** Percentage of an amount, rounded to whole paise. */
export function percentOf(amount: Paise, percent: number): Paise {
  return Math.round((amount * percent) / 100)
}
