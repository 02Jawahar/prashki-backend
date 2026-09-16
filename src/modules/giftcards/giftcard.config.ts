import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'

/**
 * What the gift card page offers, and what it says — held in settings rather
 * than in this file (M13, M25).
 *
 * The amounts and the copy travel together because they contradict each other
 * so easily. A store that changes its cards to five-year validity and leaves
 * "valid for three years" in the prose has published a promise it will not
 * honour, and the two live one screen apart in admin precisely so that cannot
 * happen unnoticed.
 *
 * The validity line is generated from `validForYears` rather than typed, for
 * the same reason: it is the one sentence that must always agree with the
 * number, so it is not a sentence anyone can get wrong.
 */

export const GIFT_CARD_SETTING_KEY = 'giftcard.config'

export interface GiftCardConfig {
  /** Paise. The buttons on the page, and the amounts the server will accept. */
  denominations: number[]
  custom: { min: number; max: number }
  validForYears: number
  heading: string
  intro: string
  /** The "Good to know" list. Validity is added to it automatically. */
  terms: string[]
}

/**
 * The values the store shipped with. These are also the fallback when the
 * stored row is unreadable — deliberately, because the alternative is a page
 * that either breaks or accepts amounts nobody agreed to sell.
 */
export const DEFAULT_GIFT_CARD_CONFIG: GiftCardConfig = {
  denominations: [200_000, 500_000, 1_000_000, 1_500_000],
  custom: { min: 50_000, max: 5_000_000 },
  validForYears: 3,
  heading: 'Gift card',
  intro:
    'Let them choose. Pick a value, write a note, and we will send the card by email once your order is paid for. It can be spent on anything in the shop.',
  terms: [
    'Can be spent across several orders until the balance runs out.',
    'If an order paid with a card is cancelled, the balance goes back on the card.',
    'Not exchangeable for cash.',
  ],
}

/**
 * Whole rupees only. A card for ₹2,000.37 is a rounding error someone typed,
 * and it would be printed on something a customer keeps.
 */
const rupeeAmount = z
  .number()
  .int('Amounts must be whole')
  .positive('Amounts must be more than nothing')
  .max(100_000_000, 'That is above the ₹10,00,000 ceiling')
  .refine((v) => v % 100 === 0, { message: 'Enter a whole number of rupees' })

export const giftCardConfigSchema = z
  .object({
    denominations: z.array(rupeeAmount).min(1, 'Offer at least one amount').max(8),
    custom: z.object({ min: rupeeAmount, max: rupeeAmount }),
    validForYears: z.number().int().min(1).max(10),
    heading: z.string().trim().min(1).max(80),
    intro: z.string().trim().min(1).max(600),
    terms: z.array(z.string().trim().min(1).max(200)).max(8),
  })
  .refine((c) => c.custom.min <= c.custom.max, {
    message: 'The smallest custom amount cannot be above the largest',
    path: ['custom', 'min'],
  })

export type GiftCardConfigInput = z.infer<typeof giftCardConfigSchema>

/** Sorted and de-duplicated, so the buttons render in a sensible order however they were typed. */
export function normaliseConfig(input: GiftCardConfigInput): GiftCardConfig {
  return {
    ...input,
    denominations: [...new Set(input.denominations)].sort((a, b) => a - b),
  }
}

/**
 * Read fresh on every call rather than cached.
 *
 * It is one indexed lookup on a row that is read a few times a minute, and a
 * cache here would mean an editor changing a price and not believing the site
 * had taken it. That trade is not worth a millisecond.
 */
export async function readGiftCardConfig(): Promise<GiftCardConfig> {
  const row = await prisma.setting.findUnique({ where: { key: GIFT_CARD_SETTING_KEY } })
  if (!row?.value) return DEFAULT_GIFT_CARD_CONFIG

  try {
    const parsed = giftCardConfigSchema.safeParse(JSON.parse(row.value))
    if (!parsed.success) {
      logger.warn(
        { key: GIFT_CARD_SETTING_KEY, issues: parsed.error.issues },
        'Gift card settings are not usable; falling back to the defaults',
      )
      return DEFAULT_GIFT_CARD_CONFIG
    }
    return normaliseConfig(parsed.data)
  } catch {
    logger.warn({ key: GIFT_CARD_SETTING_KEY }, 'Gift card settings are not valid JSON')
    return DEFAULT_GIFT_CARD_CONFIG
  }
}

export async function writeGiftCardConfig(input: GiftCardConfigInput): Promise<GiftCardConfig> {
  const config = normaliseConfig(input)
  await prisma.setting.upsert({
    where: { key: GIFT_CARD_SETTING_KEY },
    create: {
      key: GIFT_CARD_SETTING_KEY,
      value: JSON.stringify(config),
      type: 'JSON',
      group: 'giftcards',
      label: 'Gift card page',
    },
    update: { value: JSON.stringify(config) },
  })
  return config
}

/**
 * The validity sentence, in the store's own voice.
 *
 * Note for anyone changing the number: it applies to cards issued from that
 * moment on. Cards already in customers' inboxes keep the expiry they were
 * sold with, which is stored on the card itself.
 */
export function validityLine(years: number): string {
  const word = years === 1 ? 'one year' : `${years} years`
  return `Valid for ${word} from the day it is issued.`
}
