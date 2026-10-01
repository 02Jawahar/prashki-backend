/**
 * Talking back to a customer on WhatsApp.
 *
 * Until this path existed the studio could only announce things. A customer
 * who replied to the number reached Twilio, matched no callback URL, and was
 * dropped — a real message from a real person, discarded, with nobody aware
 * it had ever been sent.
 *
 * The half worth testing is the refusals, as ever. Delivering a reply inside
 * the window is the easy case; what matters is that an unsigned webhook is
 * turned away, a redelivery does not double a message in the thread, the same
 * number written two ways is one conversation, and a reply outside the
 * 24-hour window is refused rather than handed to Twilio — because WhatsApp
 * accepts that one and silently drops it, which leaves the studio believing
 * it answered someone who never heard anything.
 *
 *   node scripts/smoke-conversation.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const BASE = flag('base', process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1')
const ADMIN = { email: flag('email', 'admin@example.com'), password: flag('password', 'Admin@12345') }
const TOKEN = process.env.TWILIO_AUTH_TOKEN

let passed = 0
let failed = 0
const check = (l, ok, d) => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

const session = () => ({ jar: new Map(), csrf: null })

function absorb(s, res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [n, ...r] = pair.split('=')
    s.jar.set(n.trim(), r.join('='))
  }
  if (s.jar.has('csrf')) s.csrf = s.jar.get('csrf')
}

async function call(s, pathname, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (s.jar.size) headers.cookie = [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  if (s.csrf) headers['x-csrf-token'] = s.csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  absorb(s, res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** Posts a form to the webhook the way Twilio does, signature and all. */
async function inbound(params, { sign = true } = {}) {
  const url = `${BASE}/webhooks/whatsapp`
  const payload = Object.keys(params)
    .sort()
    .reduce((a, k) => a + k + params[k], url)

  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (sign) {
    headers['x-twilio-signature'] = createHmac('sha1', TOKEN)
      .update(Buffer.from(payload, 'utf8'))
      .digest('base64')
  }

  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params) })
  return res.status
}

console.log(`\n  target ${BASE}`)
if (!TOKEN) {
  console.log('\n  TWILIO_AUTH_TOKEN is not set, so the signature cannot be built.\n')
  process.exit(1)
}

/**
 * This test sends a reply, and the numbers below are invented. Against the
 * live provider that is a real WhatsApp message to a real stranger who never
 * contacted the studio. The server has to be the one running on a pretend
 * seam, not just this script.
 */
const SEAM = process.env.WHATSAPP_PROVIDER ?? 'noop'
if (SEAM !== 'log' && SEAM !== 'noop') {
  console.log(`\n  WHATSAPP_PROVIDER is "${SEAM}", not "log" or "noop".`)
  console.log('  Refusing to run: this sends to invented numbers, and a live')
  console.log('  provider would deliver them to whoever owns them.\n')
  process.exit(1)
}

const db = new PrismaClient()
const adm = session()
await call(adm, '/')
const login = await call(adm, '/auth/login', { method: 'POST', body: ADMIN })
if (login.status !== 200) {
  console.log(`\n  could not sign in as ${ADMIN.email} (${login.status})\n`)
  process.exit(1)
}

// A booking whose phone is written WITHOUT a country code, which is how most
// people type their own mobile. WhatsApp will hand it back with one.
const phoneLocal = '9876500001'
const phoneE164 = '+919876500001'

const appointment = await db.appointment.create({
  data: {
    reference: `PK-C-SMK${Math.floor(Math.random() * 900 + 100)}`,
    name: 'Conversation smoke',
    email: 'conversation-smoke@example.com',
    phone: phoneLocal,
    preferredAt: new Date(Date.now() + 864e5),
    notes: 'Delete me.',
  },
})
await db.whatsAppMessage.deleteMany({ where: { phone: phoneE164 } })

section('the webhook')

check(
  'an unsigned request is refused',
  (await inbound(
    { From: `whatsapp:${phoneE164}`, Body: 'nope', MessageSid: 'SM-unsigned' },
    { sign: false },
  )) === 403,
)

const badSig = await fetch(`${BASE}/webhooks/whatsapp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': 'deadbeefdeadbeefdeadbeefdeadbeef',
  },
  body: new URLSearchParams({ From: `whatsapp:${phoneE164}`, Body: 'nope', MessageSid: 'SM-bad' }),
})
check('a forged signature is refused', badSig.status === 403)

const sid = `SM${Date.now()}`
check(
  'a signed message is accepted',
  (await inbound({ From: `whatsapp:${phoneE164}`, Body: 'Can you make this in navy?', MessageSid: sid })) === 200,
)
check(
  'and stored',
  (await db.whatsAppMessage.count({ where: { phone: phoneE164, direction: 'INBOUND' } })) === 1,
)

await inbound({ From: `whatsapp:${phoneE164}`, Body: 'Can you make this in navy?', MessageSid: sid })
check(
  'a redelivery does not double it',
  (await db.whatsAppMessage.count({ where: { phone: phoneE164 } })) === 1,
  'Twilio retries anything it does not get a prompt 200 for',
)

const statusOk =
  (await inbound({
    MessageSid: `SM-status-${Date.now()}`,
    MessageStatus: 'delivered',
    From: `whatsapp:${phoneE164}`,
  })) === 200
check(
  'a status callback is not stored as a message',
  statusOk && (await db.whatsAppMessage.count({ where: { phone: phoneE164 } })) === 1,
)

section('the thread')

const thread = await call(adm, `/admin/appointments/${appointment.id}/messages`)
check(
  'found from a booking that stored the number without a country code',
  thread.json?.data?.messages?.length === 1,
  `booking has "${phoneLocal}", WhatsApp sent "${phoneE164}"`,
)
check(
  'the window is open',
  thread.json?.data?.canReply === true,
  thread.json?.data?.windowClosesAt
    ? `until ${new Date(thread.json.data.windowClosesAt).toISOString()}`
    : '',
)

section('replying')

const reply = await call(adm, `/admin/appointments/${appointment.id}/messages`, {
  method: 'POST',
  body: { body: 'Navy is lovely — shall we talk Thursday?' },
})
const outbound = await db.whatsAppMessage.findFirst({
  where: { phone: phoneE164, direction: 'OUTBOUND' },
})

if (SEAM === 'log') {
  check(
    'a reply inside the window is sent',
    reply.status === 200,
    `${reply.json?.data?.messages?.length ?? 0} messages in the thread`,
  )
  check('and is recorded against the staff member who sent it', outbound?.sentById != null)
} else {
  /**
   * The invariant that matters more than the happy path: a send the provider
   * did not transmit must never be written to the thread. Otherwise the studio
   * reads a reply it believes went out, and the customer never got anything.
   */
  check(
    'a send the provider refused is reported, not recorded',
    reply.status === 422 && outbound == null,
    'on the noop seam nothing is transmitted',
  )
  check('nothing was written to the thread', outbound == null)
}

const empty = await call(adm, `/admin/appointments/${appointment.id}/messages`, {
  method: 'POST',
  body: { body: '   ' },
})
check('an empty reply is refused', empty.status === 422, `got ${empty.status}`)

// Age the inbound past 24 hours: the window shuts and WhatsApp stops
// delivering free-form text.
await db.whatsAppMessage.updateMany({
  where: { phone: phoneE164, direction: 'INBOUND' },
  data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
})

const shut = await call(adm, `/admin/appointments/${appointment.id}/messages`)
check('once 24 hours pass the window shuts', shut.json?.data?.canReply === false)

const late = await call(adm, `/admin/appointments/${appointment.id}/messages`, {
  method: 'POST',
  body: { body: 'too late' },
})
check(
  'and a late reply is refused rather than silently dropped',
  late.status === 422,
  String(late.json?.error?.message ?? '').slice(0, 64),
)

section('a customer who never wrote')

const quiet = await db.appointment.create({
  data: {
    reference: `PK-C-SMQ${Math.floor(Math.random() * 900 + 100)}`,
    name: 'Never wrote',
    email: 'quiet-smoke@example.com',
    phone: '+919876500002',
    preferredAt: new Date(Date.now() + 864e5),
  },
})
const q = await call(adm, `/admin/appointments/${quiet.id}/messages`)
check(
  'has an empty thread and no reply box',
  q.json?.data?.messages?.length === 0 && q.json?.data?.canReply === false,
)

await db.whatsAppMessage.deleteMany({ where: { phone: { in: [phoneE164, '+919876500002'] } } })
await db.appointment.deleteMany({ where: { id: { in: [appointment.id, quiet.id] } } })
await db.$disconnect()

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
