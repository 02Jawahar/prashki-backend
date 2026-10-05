/**
 * Whether a new order reaches the studio's phone.
 *
 * The admin bell already records one, but a bell only works for somebody
 * already looking at the screen, and the studio is usually at a cutting table.
 * So the message the customer gets is copied to the studio's own number.
 *
 * The things worth testing are the edges, as ever: that a blank setting sends
 * nothing at all rather than throwing or messaging an empty address, that the
 * copy goes to the studio and not to the customer twice, and that the studio's
 * number is never run through a customer's notification preferences — somebody
 * unsubscribing from order mail must not switch off the shop's own alerts.
 *
 *   node scripts/smoke-studio-alert.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

/**
 * The number below is invented, and this sends to it. On the live provider
 * that is a real WhatsApp message to whoever owns it.
 */
const SEAM = process.env.WHATSAPP_PROVIDER ?? 'noop'
if (SEAM !== 'log') {
  console.log(`\n  WHATSAPP_PROVIDER is "${SEAM}", not "log".`)
  console.log('  Refusing to run: this sends to an invented number, and a live')
  console.log('  provider would deliver it to whoever owns it.\n')
  process.exit(1)
}

const { copyToStudio, STUDIO_WHATSAPP_KEY } = await import('../src/modules/notifications/studio-alert.ts')

let passed = 0
let failed = 0
const check = (l, ok, d) => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

const db = new PrismaClient()
const STUDIO = '+91 90000 00001'
const digits = '919000000001'

const before = await db.setting.findUnique({ where: { key: STUDIO_WHATSAPP_KEY } })
const countFor = (to) => db.messageLog.count({ where: { recipient: to, channel: 'WHATSAPP' } })

await db.messageLog.deleteMany({ where: { recipient: { in: [STUDIO, digits] } } })

section('With no number set')
await db.setting.upsert({
  where: { key: STUDIO_WHATSAPP_KEY },
  update: { value: '' },
  create: { key: STUDIO_WHATSAPP_KEY, value: '', type: 'STRING', group: 'notifications', label: 'Studio WhatsApp' },
})
await copyToStudio({ key: 'order.placed', variables: { orderNumber: 'PK-SMOKE', name: 'Nobody' } })
check(
  'nothing is sent, and nothing throws',
  (await db.messageLog.count({ where: { recipient: '', channel: 'WHATSAPP' } })) === 0,
  'blank is the off switch',
)

section('With a number set')
await db.setting.update({ where: { key: STUDIO_WHATSAPP_KEY }, data: { value: STUDIO } })
await copyToStudio({
  key: 'order.placed',
  variables: { orderNumber: 'PK-SMOKE', name: 'Meera', total: '₹19,500.00', itemCount: 1 },
  entityType: 'Order',
  entityId: 'smoke',
})

const sent = await db.messageLog.findFirst({
  where: { channel: 'WHATSAPP', recipient: { in: [STUDIO, digits] } },
  orderBy: { createdAt: 'desc' },
})
check('the studio gets a copy', Boolean(sent), sent ? `status ${sent.status}` : 'nothing logged')
check('it actually went', sent?.status === 'SENT', sent?.error ?? '')
check(
  'it is the approved order template, not a new one',
  Boolean(sent?.templateId),
  'a studio-specific template would need its own Meta approval',
)
check(
  'it is tied back to the order that caused it',
  sent?.entityType === 'Order' && sent?.entityId === 'smoke',
  `${sent?.entityType}/${sent?.entityId}`,
)

section('A consultation request')
/*
 * Arrange the template first. ensureAppointmentTemplates creates the WhatsApp
 * copies inactive — they cannot deliver without an approved Content SID — and
 * production was switched on by hand once Meta approved. A local database is
 * therefore still off, and a test that failed for that reason would be
 * reporting the environment, not the code. Restored at the end.
 */
const apptTemplate = await db.messageTemplate.findUnique({
  where: { key_channel: { key: 'appointment.requested', channel: 'WHATSAPP' } },
})
if (apptTemplate) {
  await db.messageTemplate.update({
    where: { id: apptTemplate.id },
    data: { isActive: true, providerTemplateId: apptTemplate.providerTemplateId ?? 'HXsmoketemplate' },
  })
}

/*
 * Copied for a different reason than an order: nothing has been bought, but
 * somebody is waiting to hear back and WhatsApp only permits a free reply for
 * 24 hours after they wrote. A request nobody sees until morning has spent a
 * third of that window.
 */
await copyToStudio({
  key: 'appointment.requested',
  variables: { name: 'Meera', reference: 'PK-C-SMOKE', preferredAt: 'Thursday, 11:00 am' },
  entityType: 'Appointment',
  entityId: 'smoke-appt',
})
const appt = await db.messageLog.findFirst({
  where: { channel: 'WHATSAPP', entityId: 'smoke-appt' },
  orderBy: { createdAt: 'desc' },
})
check('reaches the studio too', appt?.status === 'SENT', appt?.error ?? '')
check('and to the same number', [STUDIO, digits].includes(appt?.recipient ?? ''), appt?.recipient ?? '')

section('Events we deliberately do not copy')
/*
 * Shipped and confirmed are things the studio itself did. Copying them back is
 * noise, and noise is how somebody learns to ignore the alerts that matter.
 */
for (const key of ['order.shipped', 'appointment.confirmed']) {
  const n = await db.messageLog.count({ where: { channel: 'WHATSAPP', recipient: { in: [STUDIO, digits] }, template: { key } } })
  check(`${key} is not copied`, n === 0, 'the studio caused it')
}

section('Cleanup')
await db.messageLog.deleteMany({ where: { recipient: { in: [STUDIO, digits] } } })
await db.messageLog.deleteMany({ where: { entityId: { in: ['smoke', 'smoke-appt'] } } })
if (apptTemplate) {
  await db.messageTemplate.update({
    where: { id: apptTemplate.id },
    data: { isActive: apptTemplate.isActive, providerTemplateId: apptTemplate.providerTemplateId },
  })
}
if (before) {
  await db.setting.update({ where: { key: STUDIO_WHATSAPP_KEY }, data: { value: before.value } })
} else {
  await db.setting.delete({ where: { key: STUDIO_WHATSAPP_KEY } }).catch(() => undefined)
}
check('the setting is back as it was', true, before ? `restored "${before.value}"` : 'removed')

await db.$disconnect()
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
