import type { Prisma, ShowcaseItem } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'

/**
 * The customer showcase — photos and videos of real people wearing the pieces.
 *
 * Two rules run through everything here, and both exist because this surface
 * publishes other people's faces:
 *
 *   1. Nothing goes live without recorded consent. The customer owns both the
 *      video and their own likeness, so publishing without permission is a
 *      copyright and personality-rights problem, not an etiquette one. The
 *      guard is at the service layer rather than in the UI so it holds however
 *      the row is reached.
 *   2. A video must have a poster. Four autoplaying videos with no still frame
 *      means the biggest element on the homepage is blank until the first frame
 *      decodes — the difference between meeting the LCP target and missing it.
 */

/**
 * What the storefront is allowed to see. Never the consent notes, never the
 * source URL — how permission was obtained is an internal record.
 *
 * Kept as one `satisfies`-checked object rather than composed from parts:
 * spreading two separately-inferred selects into `findMany` widens them enough
 * that a misspelled field compiles and fails at runtime instead.
 *
 * Products are resolved through the join and filtered to ACTIVE, so a piece
 * that has since been unpublished drops out of "shop this look" rather than
 * linking to a 404.
 */
const PUBLIC_SELECT = {
  id: true,
  mediaType: true,
  mediaUrl: true,
  posterUrl: true,
  altText: true,
  caption: true,
  creditName: true,
  creditHandle: true,
  position: true,
  products: {
    where: { product: { status: 'ACTIVE' } },
    orderBy: { position: 'asc' },
    select: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          compareAtPrice: true,
          images: {
            orderBy: { sortOrder: 'asc' },
            take: 1,
            select: { url: true, altText: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ShowcaseItemSelect

export interface PublicShowcaseItem {
  id: string
  mediaType: 'VIDEO' | 'IMAGE'
  mediaUrl: string
  posterUrl: string | null
  altText: string
  caption: string | null
  creditName: string | null
  creditHandle: string | null
  products: Array<{
    id: string
    name: string
    slug: string
    price: number
    compareAtPrice: number | null
    image: string | null
  }>
}

/** The published wall, in display order. */
export async function listPublicShowcase(limit = 12): Promise<PublicShowcaseItem[]> {
  const items = await prisma.showcaseItem.findMany({
    where: { status: 'ACTIVE' },
    // createdAt breaks position ties so the order is total and therefore
    // stable between requests — otherwise the wall reshuffles on reload.
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    select: PUBLIC_SELECT,
  })

  return items.map((item) => ({
    id: item.id,
    mediaType: item.mediaType,
    mediaUrl: item.mediaUrl,
    posterUrl: item.posterUrl,
    altText: item.altText,
    caption: item.caption,
    creditName: item.creditName,
    creditHandle: item.creditHandle,
    products: item.products.map(({ product }) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      compareAtPrice: product.compareAtPrice,
      image: product.images[0]?.url ?? null,
    })),
  }))
}

// ────────────────────────────────────────────────────────────────── admin

export const adminInclude = {
  products: {
    orderBy: { position: 'asc' as const },
    select: {
      position: true,
      product: { select: { id: true, name: true, slug: true, status: true } },
    },
  },
}

export interface ShowcaseInput {
  mediaType?: 'VIDEO' | 'IMAGE'
  mediaUrl?: string
  posterUrl?: string | null
  altText?: string
  caption?: string | null
  creditName?: string | null
  creditHandle?: string | null
  sourceUrl?: string | null
  consentGrantedAt?: string | null
  consentNote?: string | null
  status?: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ARCHIVED'
  scheduledFor?: string | null
  productIds?: string[]
}

/**
 * The publishing guards, applied to whatever the row will look like *after*
 * the change rather than to the patch.
 *
 * Checking the patch is the classic version of this bug: clearing consent in
 * one request and publishing in the next would pass a naive check twice.
 */
function assertPublishable(next: {
  status: string
  mediaType: string
  posterUrl: string | null
  consentGrantedAt: Date | null
  scheduledFor: Date | null
}): void {
  const goingLive = next.status === 'ACTIVE' || next.status === 'SCHEDULED'
  if (!goingLive) return

  if (!next.consentGrantedAt) {
    throw new ValidationError(
      'Record the customer’s permission before publishing this. It is their video and their face.',
      { code: 'CONSENT_REQUIRED' },
    )
  }

  if (next.mediaType === 'VIDEO' && !next.posterUrl) {
    throw new ValidationError(
      'A video needs a poster image before it can go live — without one the homepage renders blank while it loads.',
      { code: 'POSTER_REQUIRED' },
    )
  }

  if (next.status === 'SCHEDULED' && !next.scheduledFor) {
    throw new ValidationError('Scheduled items need a date to publish on', {
      code: 'SCHEDULE_REQUIRED',
    })
  }
}

/** Rejects product ids that do not exist, rather than silently dropping them. */
async function assertProductsExist(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return

  const found = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true },
  })

  const missing = productIds.filter((id) => !found.some((p) => p.id === id))
  if (missing.length > 0) {
    throw new ValidationError('Some of those products do not exist', {
      code: 'PRODUCT_NOT_FOUND',
      missing,
    })
  }
}

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ValidationError('That is not a valid date')
  return date
}

export async function createShowcaseItem(input: ShowcaseInput): Promise<ShowcaseItem> {
  const productIds = input.productIds ?? []
  await assertProductsExist(productIds)

  const status = input.status ?? 'DRAFT'
  const consentGrantedAt = toDate(input.consentGrantedAt) ?? null
  const scheduledFor = toDate(input.scheduledFor) ?? null

  assertPublishable({
    status,
    mediaType: input.mediaType ?? 'VIDEO',
    posterUrl: input.posterUrl ?? null,
    consentGrantedAt,
    scheduledFor,
  })

  // New items go to the end of the wall.
  const last = await prisma.showcaseItem.findFirst({
    orderBy: { position: 'desc' },
    select: { position: true },
  })

  return prisma.showcaseItem.create({
    data: {
      mediaType: input.mediaType ?? 'VIDEO',
      mediaUrl: input.mediaUrl!,
      posterUrl: input.posterUrl ?? null,
      altText: input.altText!,
      caption: input.caption ?? null,
      creditName: input.creditName ?? null,
      creditHandle: input.creditHandle ?? null,
      sourceUrl: input.sourceUrl ?? null,
      consentGrantedAt,
      consentNote: input.consentNote ?? null,
      status,
      scheduledFor,
      publishedAt: status === 'ACTIVE' ? new Date() : null,
      position: (last?.position ?? 0) + 1,
      products: {
        create: productIds.map((productId, index) => ({ productId, position: index })),
      },
    },
    include: adminInclude,
  })
}

export async function updateShowcaseItem(
  id: string,
  input: ShowcaseInput,
): Promise<ShowcaseItem> {
  const existing = await prisma.showcaseItem.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError('Showcase item', 'SHOWCASE_ITEM_NOT_FOUND')

  if (input.productIds) await assertProductsExist(input.productIds)

  const consentGrantedAt = toDate(input.consentGrantedAt)
  const scheduledFor = toDate(input.scheduledFor)

  // The row as it will be, not the patch as it arrived.
  const next = {
    status: input.status ?? existing.status,
    mediaType: input.mediaType ?? existing.mediaType,
    posterUrl: input.posterUrl !== undefined ? input.posterUrl : existing.posterUrl,
    consentGrantedAt:
      consentGrantedAt !== undefined ? consentGrantedAt : existing.consentGrantedAt,
    scheduledFor: scheduledFor !== undefined ? scheduledFor : existing.scheduledFor,
  }

  assertPublishable(next)

  const becomingActive = next.status === 'ACTIVE' && existing.status !== 'ACTIVE'

  return prisma.$transaction(async (tx) => {
    if (input.productIds) {
      // Replace wholesale — the admin form sends the full list, and diffing a
      // set of at most a handful of rows buys nothing.
      await tx.showcaseProduct.deleteMany({ where: { showcaseItemId: id } })
      await tx.showcaseProduct.createMany({
        data: input.productIds.map((productId, index) => ({
          showcaseItemId: id,
          productId,
          position: index,
        })),
      })
    }

    return tx.showcaseItem.update({
      where: { id },
      data: {
        mediaType: input.mediaType,
        mediaUrl: input.mediaUrl,
        posterUrl: input.posterUrl,
        altText: input.altText,
        caption: input.caption,
        creditName: input.creditName,
        creditHandle: input.creditHandle,
        sourceUrl: input.sourceUrl,
        consentGrantedAt,
        consentNote: input.consentNote,
        status: input.status,
        scheduledFor,
        publishedAt: becomingActive ? new Date() : undefined,
      },
      include: adminInclude,
    })
  })
}

export async function deleteShowcaseItem(id: string): Promise<void> {
  const existing = await prisma.showcaseItem.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError('Showcase item', 'SHOWCASE_ITEM_NOT_FOUND')

  if (existing.status === 'ACTIVE') {
    // Removing something mid-campaign is usually a misclick. Unpublishing is
    // the reversible version of this, so make the admin do that first.
    throw new ConflictError(
      'Unpublish this before deleting it, so a live wall cannot lose an item by accident',
      'SHOWCASE_ITEM_LIVE',
    )
  }

  await prisma.showcaseItem.delete({ where: { id } })
}

/**
 * Applies a new display order.
 *
 * Takes the full ordered list of ids rather than a move instruction: the client
 * already knows the order it wants, and rewriting every position keeps them
 * dense instead of accumulating gaps.
 */
export async function reorderShowcase(ids: string[]): Promise<number> {
  const existing = await prisma.showcaseItem.findMany({ select: { id: true } })
  const known = new Set(existing.map((item) => item.id))

  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new ValidationError('That order refers to items that do not exist', {
      code: 'SHOWCASE_ITEM_NOT_FOUND',
      unknown,
    })
  }

  await prisma.$transaction(
    ids.map((id, index) =>
      prisma.showcaseItem.update({ where: { id }, data: { position: index } }),
    ),
  )

  return ids.length
}
