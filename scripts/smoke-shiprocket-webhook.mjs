/**
 * The adapter against Shiprocket's own published payload.
 *
 * Everything else about the carrier was tested against a stand-in, which
 * proves our half and says nothing about theirs. This is the other half: the
 * exact JSON Shiprocket publishes as its webhook sample, run through the code
 * that will receive the real thing.
 *
 * It was worth doing. Their sample sends `awb` as a number — 59629792084, not
 * "59629792084" — and our tracking number is a text column. A number reaching
 * that lookup does not fail to match, it throws: the update is recorded as
 * failed, the parcel never moves, and the customer never hears that their
 * order shipped. Nothing in the sandbox surfaced it, because the sandbox
 * never sent a webhook at all.
 *
 *   node scripts/smoke-shiprocket-webhook.mjs
 *
 * The fixture is their file, kept verbatim:
 *   src/integrations/shipping/__fixtures__/shiprocket-webhook.sample.json
 *   https://kr-multichannel.s3.ap-southeast-1.amazonaws.com/webhook/docs/sample.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

// The adapter refuses to parse without one; the signature path is covered
// elsewhere and is not what this is about.
process.env.SHIPROCKET_WEBHOOK_TOKEN ??= 'smoke-token'

const { ShiprocketProvider } = await import('../src/integrations/shipping/shiprocket.provider.ts')
const { PrismaClient } = await import('@prisma/client')

let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (t, n) => console.log(`\n${t}${n ? `  ${n}` : ''}`)

const sample = JSON.parse(
  fs.readFileSync(
    path.resolve(here, '..', 'src/integrations/shipping/__fixtures__/shiprocket-webhook.sample.json'),
    'utf8',
  ),
)

const provider = new ShiprocketProvider()

console.log(`\n  Shiprocket's published webhook sample`)

// ══════════════════════════════════════════════════ shape
section('What they send', 'And what we make of it')

check('their AWB really is a number', typeof sample.awb === 'number', `awb: ${sample.awb}`)

const event = provider.normalizeWebhook(sample)

check(
  'we hand the database a string',
  typeof event.trackingNumber === 'string',
  `${JSON.stringify(event.trackingNumber)} (${typeof event.trackingNumber})`,
)
check('the order id is a string too', typeof event.providerShipmentId === 'string', event.providerShipmentId)
check('the status maps', event.status === 'DELIVERED', `${event.providerStatus} -> ${event.status}`)

/**
 * Their sample carries neither a top-level location nor a status label. Both
 * live on the scans, and without them the customer's timeline is a row of
 * blank lines with timestamps.
 */
check('the location comes off the newest scan', event.location === 'PATIALA', event.location ?? 'null')
check('so does the wording', event.message === 'SHIPMENT DELIVERED', event.message ?? 'null')
check('the time is theirs, not ours', event.occurredAt instanceof Date && !Number.isNaN(event.occurredAt.getTime()),
  event.occurredAt?.toISOString())

// ══════════════════════════════════════════════════ the lookup
section('Finding the parcel', 'The step that used to throw')

const db = new PrismaClient()
let threw = null
try {
  await db.shipment.findFirst({ where: { trackingNumber: event.trackingNumber } })
} catch (err) {
  threw = err instanceof Error ? err.message.split('\n').find((l) => l.trim()) : String(err)
}
check('looking it up does not throw', threw === null, threw ?? 'clean')

// ══════════════════════════════════════════════════ idempotency
section('Saying it twice', 'Carriers redeliver')

check('the same scan is the same event', provider.normalizeWebhook(sample).eventId === event.eventId)

const later = provider.normalizeWebhook({ ...sample, scans: [], current_timestamp: '2021-07-03 10:00:00' })
check('a later scan is a different one', later.eventId !== event.eventId)

const otherParcel = provider.normalizeWebhook({ ...sample, awb: 99999999999 })
check('another parcel is a different one', otherParcel.eventId !== event.eventId)

// ══════════════════════════════════════════════════ the shapes around it
section('Variations', 'The same payload, differently spelled')

const asString = provider.normalizeWebhook({ ...sample, awb: '59629792084' })
check('an AWB already a string is unharmed', asString.trackingNumber === '59629792084')

const noScans = provider.normalizeWebhook({ ...sample, scans: undefined })
check('a payload with no scans still parses', noScans.status === 'DELIVERED' && noScans.location === null)

const oldestFirst = provider.normalizeWebhook({ ...sample, scans: [...sample.scans].reverse() })
check(
  'scan order does not matter',
  oldestFirst.location === 'PATIALA' && oldestFirst.message === 'SHIPMENT DELIVERED',
  'sorted by date, not by position',
)

let unmapped = null
try {
  provider.normalizeWebhook({ ...sample, shipment_status: 'Something New', current_status: 'Something New' })
} catch (err) {
  unmapped = err.code ?? err.message
}
check('an unknown status is refused, not guessed', unmapped === 'SHIPROCKET_UNMAPPED_STATUS', String(unmapped))

await db.$disconnect()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
