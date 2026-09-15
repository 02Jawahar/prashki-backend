import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { ok } from '../../utils/response.js'
import { recordAudit } from '../../utils/audit.js'

/**
 * Main navigation (M25).
 *
 * The menu lives in the `nav.main` setting, which the storefront header reads
 * on every render. It was reachable only by editing that row directly: the
 * Settings screen filters JSON values out on purpose, because a free-text box
 * holding the whole menu is one stray comma away from a header that renders
 * nothing on every page of the store.
 *
 * So this is a dedicated endpoint rather than a generic setting write. The
 * shape is validated here, which is the only place it can be — the storefront
 * reads this blind and has no opportunity to reject it.
 */

/**
 * Four levels, matching what the header can actually draw:
 *
 *   Ready to Wear              a top-level item
 *     Women's                  a column in the mega menu
 *       Luxury Pret            a group heading inside that column
 *         Salwar Suits         a link in that group
 *
 * The limit is enforced rather than left to the renderer. A fifth level saved
 * happily and then silently vanished from the menu would be indistinguishable
 * from a bug, and the admin would have no way to tell which of the two it was.
 *
 * Four is where it stops for a reason that is visual, not technical: a column
 * deep enough to need a fifth level is taller than the dropdown it lives in.
 */
const MAX_DEPTH = 4

const leaf = z.object({
  label: z.string().trim().min(1).max(60),
  /**
   * Internal paths only. An admin menu that can point at an external host is a
   * stored-redirect primitive: anyone who can edit the menu could aim the whole
   * store's navigation at a lookalike checkout. Relative, no scheme, no
   * protocol-relative "//evil.example".
   */
  href: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((v) => v.startsWith('/') && !v.startsWith('//'), {
      message: 'Links must be a path on this site, starting with a single /',
    }),
})

type NavInput = z.infer<typeof leaf> & { children?: NavInput[] }

const navItem: z.ZodType<NavInput> = leaf.extend({
  children: z.lazy(() => z.array(navItem).max(24)).optional(),
})

const navSchema = z.object({ items: z.array(navItem).max(12) })

function depthOf(items: NavInput[]): number {
  return items.reduce(
    (deepest, item) => Math.max(deepest, 1 + (item.children?.length ? depthOf(item.children) : 0)),
    0,
  )
}

/** Empty children arrays read as "has a dropdown" to the header. Drop them. */
function prune(items: NavInput[]): NavInput[] {
  return items.map((item) => {
    const children = item.children?.length ? prune(item.children) : undefined
    return children?.length ? { ...item, children } : { label: item.label, href: item.href }
  })
}

export const adminNavigationRouter: Router = Router()

adminNavigationRouter.get('/', requirePermission('settings.read'), async (_req, res) => {
  const row = await prisma.setting.findUnique({ where: { key: 'nav.main' } })

  let items: unknown = []
  try {
    items = row ? JSON.parse(row.value) : []
  } catch {
    // A row hand-edited into invalid JSON should not take the admin screen down
    // with it — that screen is where it gets fixed.
    items = []
  }

  return ok(res, { items: Array.isArray(items) ? items : [], maxDepth: MAX_DEPTH })
})

adminNavigationRouter.put(
  '/',
  writeLimiter,
  requirePermission('settings.update'),
  validate({ body: navSchema }),
  async (req, res) => {
    const { items } = req.validated!.body as z.infer<typeof navSchema>

    const cleaned = prune(items)
    const depth = depthOf(cleaned)

    if (depth > MAX_DEPTH) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'NAV_TOO_DEEP',
          message: `The menu goes ${depth} levels deep; the header can draw ${MAX_DEPTH}. Flatten the deepest items.`,
        },
      })
    }

    await prisma.setting.upsert({
      where: { key: 'nav.main' },
      create: {
        key: 'nav.main',
        value: JSON.stringify(cleaned),
        type: 'JSON',
        group: 'navigation',
        label: 'Main navigation',
      },
      update: { value: JSON.stringify(cleaned) },
    })

    recordAudit({
      action: 'NAVIGATION_UPDATED',
      entityType: 'Setting',
      entityId: 'nav.main',
      metadata: { topLevel: cleaned.length, depth },
      req,
    })

    return ok(res, { items: cleaned })
  },
)
