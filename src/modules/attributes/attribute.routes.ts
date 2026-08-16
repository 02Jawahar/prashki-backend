import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'

/**
 * Attribute administration (M12).
 *
 * Attributes describe variants; they never price them. Editing a value renames
 * it everywhere it is used, which is the point — "Med" becoming "Medium" should
 * not orphan the variants already carrying it.
 */
export const adminAttributeRouter: Router = Router()

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const attributeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isSwatch: z.boolean().default(false),
  isFilterable: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
})

const valueSchema = z.object({
  value: z.string().trim().min(1).max(80),
  colorHex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, e.g. #838E5E')
    .optional()
    .nullable(),
  position: z.coerce.number().int().min(0).default(0),
})

adminAttributeRouter.get('/', requirePermission('product.read'), async (_req, res) => {
  const attributes = await prisma.attribute.findMany({
    orderBy: { position: 'asc' },
    include: {
      values: {
        orderBy: { position: 'asc' },
        include: { _count: { select: { variants: true } } },
      },
    },
  })

  return ok(res, {
    attributes: attributes.map((a) => ({
      ...a,
      values: a.values.map((v) => ({ ...v, usageCount: v._count.variants })),
    })),
  })
})

adminAttributeRouter.post(
  '/',
  writeLimiter,
  requirePermission('attribute.manage'),
  validate({ body: attributeSchema }),
  async (req, res) => {
    const body = req.validated!.body as z.infer<typeof attributeSchema>
    const slug = slugify(body.name)

    const clash = await prisma.attribute.findFirst({
      where: { OR: [{ name: body.name }, { slug }] },
    })
    if (clash) throw new ConflictError('An attribute with that name already exists', 'ATTRIBUTE_EXISTS')

    const attribute = await prisma.attribute.create({
      data: { ...body, slug },
      include: { values: true },
    })

    recordAudit({
      action: 'ATTRIBUTE_CREATED',
      entityType: 'Attribute',
      entityId: attribute.id,
      req,
    })

    return created(res, { attribute })
  },
)

adminAttributeRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('attribute.manage'),
  validate({ body: attributeSchema.partial() }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as Partial<z.infer<typeof attributeSchema>>

    const existing = await prisma.attribute.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Attribute', 'ATTRIBUTE_NOT_FOUND')

    const attribute = await prisma.attribute.update({
      where: { id },
      // The slug is left alone on rename: it is in storefront filter URLs, and
      // changing it would break every saved or shared link.
      data: body,
      include: { values: { orderBy: { position: 'asc' } } },
    })

    return ok(res, { attribute })
  },
)

adminAttributeRouter.delete(
  '/:id',
  writeLimiter,
  requirePermission('attribute.manage'),
  async (req, res) => {
    const { id } = req.params as { id: string }

    const attribute = await prisma.attribute.findUnique({
      where: { id },
      include: { values: { include: { _count: { select: { variants: true } } } } },
    })
    if (!attribute) throw new NotFoundError('Attribute', 'ATTRIBUTE_NOT_FOUND')

    const inUse = attribute.values.reduce((sum, v) => sum + v._count.variants, 0)
    if (inUse > 0) {
      throw new ConflictError(
        `That attribute is used by ${inUse} variant${inUse === 1 ? '' : 's'}. Remove it from those first.`,
        'ATTRIBUTE_IN_USE',
      )
    }

    await prisma.attribute.delete({ where: { id } })
    recordAudit({ action: 'ATTRIBUTE_DELETED', entityType: 'Attribute', entityId: id, req })

    return ok(res, { deleted: true })
  },
)

adminAttributeRouter.post(
  '/:id/values',
  writeLimiter,
  requirePermission('attribute.manage'),
  validate({ body: valueSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const body = req.validated!.body as z.infer<typeof valueSchema>

    const attribute = await prisma.attribute.findUnique({ where: { id } })
    if (!attribute) throw new NotFoundError('Attribute', 'ATTRIBUTE_NOT_FOUND')

    const slug = slugify(body.value)
    const clash = await prisma.attributeValue.findUnique({
      where: { attributeId_slug: { attributeId: id, slug } },
    })
    if (clash) throw new ConflictError('That value already exists', 'VALUE_EXISTS')

    const value = await prisma.attributeValue.create({
      data: {
        attributeId: id,
        value: body.value,
        slug,
        // A swatch colour on a non-swatch attribute would never be rendered.
        colorHex: attribute.isSwatch ? (body.colorHex ?? null) : null,
        position: body.position,
      },
    })

    return created(res, { value })
  },
)

adminAttributeRouter.patch(
  '/values/:valueId',
  writeLimiter,
  requirePermission('attribute.manage'),
  validate({ body: valueSchema.partial() }),
  async (req, res) => {
    const { valueId } = req.params as { valueId: string }
    const body = req.validated!.body as Partial<z.infer<typeof valueSchema>>

    const existing = await prisma.attributeValue.findUnique({ where: { id: valueId } })
    if (!existing) throw new NotFoundError('Value', 'VALUE_NOT_FOUND')

    const value = await prisma.attributeValue.update({
      where: { id: valueId },
      // Same reasoning as the attribute slug: filter URLs depend on it.
      data: body,
    })

    return ok(res, { value })
  },
)

adminAttributeRouter.delete(
  '/values/:valueId',
  writeLimiter,
  requirePermission('attribute.manage'),
  async (req, res) => {
    const { valueId } = req.params as { valueId: string }

    const value = await prisma.attributeValue.findUnique({
      where: { id: valueId },
      include: { _count: { select: { variants: true } } },
    })
    if (!value) throw new NotFoundError('Value', 'VALUE_NOT_FOUND')

    if (value._count.variants > 0) {
      throw new ConflictError(
        `That value is used by ${value._count.variants} variant${value._count.variants === 1 ? '' : 's'}.`,
        'VALUE_IN_USE',
      )
    }

    await prisma.attributeValue.delete({ where: { id: valueId } })
    return ok(res, { deleted: true })
  },
)

// ------------------------------------------------- assigning to variants

const assignSchema = z.object({
  attributeValueIds: z.array(z.string().trim().min(1)).max(20),
})

/**
 * Replaces a variant's options wholesale. The form always sends the full set,
 * so a removed tick is a removed row rather than something left behind.
 */
adminAttributeRouter.put(
  '/variants/:variantId',
  writeLimiter,
  requirePermission('attribute.manage'),
  validate({ body: assignSchema }),
  async (req, res) => {
    const { variantId } = req.params as { variantId: string }
    const { attributeValueIds } = req.validated!.body as z.infer<typeof assignSchema>

    const variant = await prisma.productVariant.findUnique({ where: { id: variantId } })
    if (!variant) throw new NotFoundError('Variant', 'VARIANT_NOT_FOUND')

    if (attributeValueIds.length > 0) {
      const found = await prisma.attributeValue.count({ where: { id: { in: attributeValueIds } } })
      if (found !== attributeValueIds.length) {
        throw new NotFoundError('Attribute value', 'VALUE_NOT_FOUND')
      }
    }

    await prisma.$transaction([
      prisma.variantAttributeValue.deleteMany({ where: { variantId } }),
      prisma.variantAttributeValue.createMany({
        data: attributeValueIds.map((attributeValueId) => ({ variantId, attributeValueId })),
      }),
    ])

    const attributes = await prisma.variantAttributeValue.findMany({
      where: { variantId },
      include: { attributeValue: { include: { attribute: true } } },
    })

    return ok(res, { variantId, attributes })
  },
)
