import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'

/**
 * The messages a consultation sends, and the code that makes sure they exist.
 *
 * Templates live in the database so an admin can reword them, which means a
 * newly added one has to get there somehow. The seed only runs on a fresh
 * database and the bootstrap script is something a person remembers to run —
 * so a template added in a release would be missing in production, and
 * `sendToAllChannels` would find nothing active on any channel and send
 * nothing at all. Silently: a customer asks for a consultation, hears nothing
 * back, and assumes the form is broken.
 *
 * Ensured at boot instead. It creates what is absent and never touches what is
 * there, so an admin's rewording survives every deploy.
 */

export const APPOINTMENT_TEMPLATES = [
  {
    key: 'appointment.requested',
    channel: 'EMAIL' as const,
    name: 'Consultation requested',
    subject: 'Your consultation request — {{reference}}',
    body:
      'Hello {{name}},\n\n' +
      'Thank you for asking to see us about a commission. We have your request for {{preferredAt}}.\n\n' +
      'Nothing is confirmed yet — we will write again once we have checked the diary, usually within a day. ' +
      'Quote {{reference}} if you need to reach us about it.\n\n' +
      'Prash & Ki',
    variables: ['name', 'reference', 'preferredAt'],
  },
  {
    key: 'appointment.requested',
    channel: 'WHATSAPP' as const,
    name: 'Consultation requested (WhatsApp)',
    subject: null,
    body:
      'Hi {{name}}, thank you — we have your consultation request for {{preferredAt}}. ' +
      'We will confirm shortly. Reference {{reference}}. prashandki.in',
    variables: ['name', 'reference', 'preferredAt'],
  },
  {
    key: 'appointment.confirmed',
    channel: 'EMAIL' as const,
    name: 'Consultation confirmed',
    subject: 'Your consultation is confirmed — {{preferredAt}}',
    body:
      'Hello {{name}},\n\n' +
      'Your consultation is confirmed for {{preferredAt}}.\n\n' +
      'We are at 104, 17th Cross Street, Besant Nagar, Chennai 600090. ' +
      'Bring anything that helps — a photograph, a fabric, a rough idea is plenty.\n\n' +
      'Reference {{reference}}.\n\n' +
      'Prash & Ki',
    variables: ['name', 'reference', 'preferredAt'],
  },
  {
    key: 'appointment.confirmed',
    channel: 'WHATSAPP' as const,
    name: 'Consultation confirmed (WhatsApp)',
    subject: null,
    body:
      'Hi {{name}}, your Prash & Ki consultation is confirmed for {{preferredAt}}, ' +
      'at 104, 17th Cross Street, Besant Nagar, Chennai. Reference {{reference}}.',
    variables: ['name', 'reference', 'preferredAt'],
  },
]

/**
 * Creates any template that is missing. Never updates one that exists — an
 * admin who rewrote the wording meant it, and a deploy is not a reason to
 * overrule them.
 */
export async function ensureAppointmentTemplates(): Promise<void> {
  let added = 0

  for (const template of APPOINTMENT_TEMPLATES) {
    const existing = await prisma.messageTemplate.findUnique({
      where: { key_channel: { key: template.key, channel: template.channel } },
      select: { id: true },
    })
    if (existing) continue

    await prisma.messageTemplate.create({
      data: {
        key: template.key,
        channel: template.channel,
        name: template.name,
        subject: template.subject,
        body: template.body,
        variables: template.variables,
        /**
         * WhatsApp starts inactive. It cannot deliver without an approved
         * Content SID against it, and an active template with none would send
         * free-form — which only arrives inside a 24-hour reply window and
         * otherwise vanishes. Email carries the message meanwhile; an
         * operator turns this on once the SID is set.
         */
        isActive: template.channel !== 'WHATSAPP',
      },
    })
    added++
  }

  if (added > 0) logger.info({ added }, 'Created missing consultation message templates')
}
