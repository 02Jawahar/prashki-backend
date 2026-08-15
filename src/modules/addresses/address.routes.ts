import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok } from '../../utils/response.js'
import { NotFoundError } from '../../utils/errors.js'

/**
 * Address book. Every query is scoped to the session's user — an address id
 * from someone else's account must never resolve.
 */
export const addressRouter: Router = Router()

addressRouter.use(requireAuth)

const addressSchema = z.object({
  label: z.string().trim().max(40).optional().or(z.literal('')),
  name: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Enter a 6-digit PIN code'),
  country: z.string().trim().length(2).default('IN'),
  isDefault: z.boolean().default(false),
})

addressRouter.get('/', async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  return ok(res, { addresses })
})

addressRouter.post('/', writeLimiter, validate({ body: addressSchema }), async (req, res) => {
  const input = req.validated!.body as z.infer<typeof addressSchema>
  const userId = req.user!.id

  const existing = await prisma.address.count({ where: { userId } })
  // The first address is always the default, whatever was asked for.
  const isDefault = input.isDefault || existing === 0

  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } })
    }
    return tx.address.create({
      data: {
        userId,
        label: input.label || null,
        name: input.name,
        phone: input.phone,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 || null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        isDefault,
      },
    })
  })

  return created(res, { address })
})

addressRouter.patch(
  '/:id',
  writeLimiter,
  validate({ body: addressSchema.partial() }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const userId = req.user!.id
    const input = req.validated!.body as Partial<z.infer<typeof addressSchema>>

    const owned = await prisma.address.findFirst({ where: { id, userId } })
    if (!owned) throw new NotFoundError('Address', 'ADDRESS_NOT_FOUND')

    const address = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } })
      }
      return tx.address.update({
        where: { id },
        data: {
          ...input,
          label: input.label === undefined ? undefined : input.label || null,
          addressLine2: input.addressLine2 === undefined ? undefined : input.addressLine2 || null,
        },
      })
    })

    return ok(res, { address })
  },
)

addressRouter.delete('/:id', writeLimiter, async (req, res) => {
  const { id } = req.params as { id: string }
  const userId = req.user!.id

  const owned = await prisma.address.findFirst({ where: { id, userId } })
  if (!owned) throw new NotFoundError('Address', 'ADDRESS_NOT_FOUND')

  await prisma.address.delete({ where: { id } })

  // Never leave the book without a default.
  if (owned.isDefault) {
    const next = await prisma.address.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (next) await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } })
  }

  return ok(res, { deleted: true })
})
