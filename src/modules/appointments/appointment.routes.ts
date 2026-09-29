import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/db.js'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, ok, pageMeta } from '../../utils/response.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { emit } from '../../events/bus.js'

/**
 * Consultations for a piece that does not exist yet (M27).
 *
 * Open to guests on purpose. Somebody commissioning a wedding lehenga is
 * usually doing it before they have bought anything, and an enquiry form that
 * demands an account first is an enquiry that does not happen. The contact
 * details are therefore snapshotted onto the booking, the way a delivery
 * address is snapshotted onto an order.
 */

export const appointmentRouter: Router = Router()
export const adminAppointmentRouter: Router = Router()

/**
 * Short, sayable, and unique. A customer reads this down the phone, so it
 * avoids the characters that sound alike — no O against 0, no I against 1.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeReference(): string {
  const random = Array.from(
    { length: 6 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join('')
  return `PK-C-${random}`
}

const bookingSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name').max(120),
  email: z.string().trim().email('That email does not look right').max(200),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a phone number we can reach you on'),
  /**
   * An ISO instant from the browser, which sends the customer's own timezone
   * with it. Storing the instant rather than a wall-clock time means a studio
   * in Chennai and a customer abroad are talking about the same moment.
   */
  preferredAt: z.coerce.date(),
  notes: z.string().trim().max(2000).optional(),
})

appointmentRouter.post(
  '/',
  writeLimiter,
  validate({ body: bookingSchema }),
  async (req, res) => {
    const input = req.validated!.body as z.infer<typeof bookingSchema>

    /**
     * A time already past is a typo, not a request. Refused here rather than
     * accepted and left for somebody to notice — an appointment for last
     * Tuesday sits in the list looking real.
     */
    if (input.preferredAt.getTime() < Date.now() - 60_000) {
      throw new ValidationError('Choose a time in the future', { path: ['preferredAt'] })
    }

    /**
     * A year out is not a consultation, it is a mistake with a date picker.
     */
    const aYearOut = Date.now() + 365 * 24 * 60 * 60 * 1000
    if (input.preferredAt.getTime() > aYearOut) {
      throw new ValidationError('Choose a time within the next year', { path: ['preferredAt'] })
    }

    /**
     * The same person asking twice in a minute is a double-submitted form, not
     * two consultations. Matched on email and time rather than on a token,
     * because a guest has nothing else that identifies them.
     */
    const duplicate = await prisma.appointment.findFirst({
      where: {
        email: input.email.toLowerCase(),
        preferredAt: input.preferredAt,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    })
    if (duplicate) {
      return created(res, { appointment: publicView(duplicate) })
    }

    const appointment = await prisma.appointment.create({
      data: {
        reference: makeReference(),
        name: input.name,
        email: input.email.toLowerCase(),
        phone: input.phone,
        preferredAt: input.preferredAt,
        notes: input.notes || null,
        // Set when a signed-in customer books, so their account can show it.
        userId: req.user?.id ?? null,
      },
    })

    emit('APPOINTMENT_REQUESTED', {
      appointmentId: appointment.id,
      reference: appointment.reference,
      name: appointment.name,
      email: appointment.email,
      phone: appointment.phone,
      preferredAt: appointment.preferredAt,
      notes: appointment.notes,
    })

    return created(res, { appointment: publicView(appointment) })
  },
)

/** What a customer may see back — never the staff note. */
function publicView(a: {
  reference: string
  name: string
  preferredAt: Date
  status: string
}) {
  return {
    reference: a.reference,
    name: a.name,
    preferredAt: a.preferredAt,
    status: a.status,
  }
}

// ------------------------------------------------------------------- admin

const listQuery = z.object({
  status: z.enum(['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
})

adminAppointmentRouter.get(
  '/',
  requirePermission('order.read'),
  validate({ query: listQuery }),
  async (req, res) => {
    const q = req.validated!.query as z.infer<typeof listQuery>
    const where = q.status ? { status: q.status } : {}

    const [total, appointments] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        /**
         * Soonest first among the ones still waiting, because those are the
         * ones with a deadline. Newest-first would bury a consultation
         * happening tomorrow under one requested for next month.
         */
        orderBy: [{ status: 'asc' }, { preferredAt: 'asc' }],
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
    ])

    return ok(res, { appointments }, { pagination: pageMeta(q.page, q.perPage, total) })
  },
)

const updateSchema = z.object({
  status: z.enum(['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']),
  staffNote: z.string().trim().max(1000).optional(),
})

adminAppointmentRouter.patch(
  '/:id',
  writeLimiter,
  requirePermission('order.update'),
  validate({ body: updateSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const input = req.validated!.body as z.infer<typeof updateSchema>

    const existing = await prisma.appointment.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Appointment', 'APPOINTMENT_NOT_FOUND')

    const appointment = await prisma.appointment.update({
      where: { id },
      data: { status: input.status, staffNote: input.staffNote ?? existing.staffNote },
    })

    recordAudit({
      action: 'APPOINTMENT_UPDATED',
      entityType: 'Appointment',
      entityId: id,
      metadata: { from: existing.status, to: input.status },
      req,
    })

    /**
     * Confirming is the only change the customer hears about. Completing one
     * is a note to ourselves, and cancelling is usually the customer's own
     * doing — telling them what they just asked for is noise.
     */
    if (input.status === 'CONFIRMED' && existing.status !== 'CONFIRMED') {
      emit('APPOINTMENT_CONFIRMED', {
        appointmentId: appointment.id,
        reference: appointment.reference,
        name: appointment.name,
        email: appointment.email,
        phone: appointment.phone,
        preferredAt: appointment.preferredAt,
      })
    }

    return ok(res, { appointment })
  },
)
