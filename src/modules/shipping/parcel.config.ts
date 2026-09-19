import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'

/**
 * What a parcel is assumed to be when nobody has said otherwise (M21).
 *
 * Every garment ought to carry its own weight and every packed parcel its own
 * measurements, but there is always a piece nobody has weighed and an evening
 * when the box goes out without anyone typing its size. These are the numbers
 * used then.
 *
 * They were constants in the adapter, which was wrong in a way that costs
 * money. Couriers charge on the greater of actual and volumetric weight —
 * (L x W x H) / 5000 — so an under-declared box is re-weighed at the hub and
 * the difference is taken from the wallet days later, with nothing tying it
 * back to the order that caused it. A number with that consequence should be
 * changeable by the person paying it, without a deploy.
 *
 * Held in settings rather than the environment for the same reason: the
 * studio knows what its boxes are, and that knowledge should not have to
 * travel through anyone else to reach the shop.
 */

export const PARCEL_DEFAULTS_SETTING_KEY = 'shipping.parcel_defaults'

export interface ParcelDefaults {
  /** Per unit, in grams. Used when a variant has no weight of its own. */
  weightGrams: number
  /** The box, in millimetres. Used when a parcel was packed without measurements. */
  lengthMm: number
  widthMm: number
  heightMm: number
}

/**
 * What the shop starts with.
 *
 * The dimensions are the ones that used to be hardcoded, so nothing changes
 * for a store that never opens the screen. The weight follows
 * SHIPPING_DEFAULT_ITEM_WEIGHT_GRAMS, so an environment that already set it
 * keeps its answer until somebody overrides it in admin.
 */
export function defaultParcel(): ParcelDefaults {
  return {
    weightGrams: env.SHIPPING_DEFAULT_ITEM_WEIGHT_GRAMS,
    lengthMm: 300,
    widthMm: 250,
    heightMm: 80,
  }
}

/**
 * Bounds rather than opinions. A 50 kg parcel is a mistake and so is a 1 g
 * one, but where a studio sits between those is its own business.
 */
export const parcelDefaultsSchema = z.object({
  weightGrams: z.coerce.number().int().min(10).max(50_000),
  lengthMm: z.coerce.number().int().min(10).max(3_000),
  widthMm: z.coerce.number().int().min(10).max(3_000),
  heightMm: z.coerce.number().int().min(10).max(3_000),
})

export type ParcelDefaultsInput = z.infer<typeof parcelDefaultsSchema>

/**
 * What the courier will bill this box at, in grams.
 *
 * Couriers charge the greater of what a parcel weighs and what it takes up,
 * and for clothing the second usually wins — a lehenga is light and large.
 * Shown in admin next to the inputs so the consequence of a box size is
 * visible while it is being typed, rather than in a passbook a week later.
 */
export function volumetricGrams(
  d: Pick<ParcelDefaults, 'lengthMm' | 'widthMm' | 'heightMm'>,
): number {
  const cm3 = (d.lengthMm / 10) * (d.widthMm / 10) * (d.heightMm / 10)
  return Math.round((cm3 / 5000) * 1000)
}

/**
 * Read fresh each time, like the gift card config and for the same reason: it
 * is one indexed lookup, and a cache would mean an operator changing a box
 * size and not believing the shop had taken it.
 */
export async function readParcelDefaults(): Promise<ParcelDefaults> {
  const row = await prisma.setting
    .findUnique({ where: { key: PARCEL_DEFAULTS_SETTING_KEY } })
    .catch(() => null)

  if (!row?.value) return defaultParcel()

  try {
    const parsed = parcelDefaultsSchema.safeParse(JSON.parse(row.value))
    if (!parsed.success) {
      logger.warn(
        { key: PARCEL_DEFAULTS_SETTING_KEY, issues: parsed.error.issues },
        'Parcel defaults are not usable; falling back to the built-in ones',
      )
      return defaultParcel()
    }
    return parsed.data
  } catch {
    logger.warn({ key: PARCEL_DEFAULTS_SETTING_KEY }, 'Parcel defaults are not valid JSON')
    return defaultParcel()
  }
}
