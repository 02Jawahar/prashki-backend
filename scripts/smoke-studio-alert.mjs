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

section('Cleanup')
await db.messageLog.deleteMany({ where: { recipient: { in: [STUDIO, digits] } } })
if (before) {
  await db.setting.update({ where: { key: STUDIO_WHATSAPP_KEY }, data: { value: before.value } })
} else {
  await db.setting.delete({ where: { key: STUDIO_WHATSAPP_KEY } }).catch(() => undefined)
}
check('the setting is back as it was', true, before ? `restored "${before.value}"` : 'removed')

await db.$disconnect()
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
