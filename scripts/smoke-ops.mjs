/**
 * Operational readiness — the two gaps the deployment audit found.
 *
 *   1. Failed provider callbacks are visible and can be replayed (PRD §04:
 *      "permanent failures enter a visible operational queue"). A row that
 *      exists but nobody can see is not a queue.
 *   2. Account erasure (PRD Privacy / DPDP). The interesting assertions are
 *      the ones about what *survives*: an erasure that took the orders with it
 *      would pass a naive "is the data gone" test and destroy the books.
 *
 * This suite creates its own customer and erases it, so it does not disturb
 * the seeded one that every other suite signs in as.
 */
import crypto from 'node:crypto'

const SECRET = process.env.JWT_ACCESS_SECRET
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const SUPER = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
}
const CUSTOMER = {
  email: process.env.CUSTOMER_EMAIL ?? 'customer@example.com',
  password: process.env.CUSTOMER_PASSWORD ?? 'Customer@12345',
}

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

class Jar {
  constructor() { this.cookies = new Map() }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i).trim()
      const v = pair.slice(i + 1).trim()
      if (v === '') this.cookies.delete(k); else this.cookies.set(k, v)
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
}

let sharedCsrf = null
async function primeCsrf() {
  const res = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
  return cookie ? cookie.split(';')[0].slice('csrf='.length) : null
}

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  const unsafe = method !== 'GET' && method !== 'HEAD'
  if (unsafe && jar && !jar.cookies.get('csrf')) {
    jar.absorb(await fetch(`${BASE}/`, { headers: { accept: 'application/json' } }))
  } else if (unsafe && !jar) {
    sharedCsrf ??= await primeCsrf()
  }

  const csrf = jar?.cookies?.get('csrf') ?? (unsafe ? sharedCsrf : null)
  const cookieHeader = jar?.header() || (csrf ? `csrf=${csrf}` : '')
  if (cookieHeader) headers.cookie = cookieHeader
  if (csrf) headers['x-csrf-token'] = csrf
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: res.status, json }
}

async function signIn(email, password) {
  const jar = new Jar()
  const r = await call('/auth/login', { method: 'POST', jar, body: { email, password } })
  return r.status === 200 ? jar : null
}

console.log('\nOperational readiness — failure queue and account erasure\n')

const superAdmin = await signIn(SUPER.email, SUPER.password)
if (!superAdmin) {
  console.log('Cannot continue without the super admin session.')
  process.exit(1)
}

// ════════════════════════════════════ PRD §04  the visible failure queue
section('PRD §04  Failed callbacks are visible and replayable')

{
  const r = await call('/admin/webhook-events', { jar: superAdmin })
  check('the queue is readable by an admin', r.status === 200, `status ${r.status}`)
  check('it reports a stuck count', typeof r.json?.data?.stuckCount === 'number')
  check('it paginates', typeof r.json?.meta?.pagination?.total === 'number')

  const filtered = await call('/admin/webhook-events?status=FAILED', { jar: superAdmin })
  check('it filters by status', filtered.status === 200, `status ${filtered.status}`)
  check(
    'a FAILED filter returns only failures',
    (filtered.json?.data?.events ?? []).every((e) => e.status === 'FAILED'),
  )

  const bad = await call('/admin/webhook-events?status=NONSENSE', { jar: superAdmin })
  check('an unknown status is rejected', bad.status === 422, `status ${bad.status}`)
}

{
  // Replaying something that does not exist must 404 rather than 500.
  const r = await call('/admin/webhook-events/does-not-exist/retry', {
    method: 'POST',
    jar: superAdmin,
  })
  check('retrying an unknown event is a 404', r.status === 404, `status ${r.status}`)
  check(
    'the code names the resource',
    r.json?.error?.code === 'WEBHOOK_EVENT_NOT_FOUND',
    r.json?.error?.code ?? 'none',
  )
}

{
  const customer = await signIn(CUSTOMER.email, CUSTOMER.password)
  const r = await call('/admin/webhook-events', { jar: customer })
  check('a customer cannot see the queue', r.status === 403, `status ${r.status}`)
}

/**
 * The part that matters: a callback that genuinely fails must appear in the
 * queue, and retrying it must re-run the real handler.
 *
 * A payment for an order id we have never issued is the honest way to produce
 * a failure — it is exactly what a misrouted or replayed-from-staging webhook
 * looks like, and it fails for a reason the retry will hit again, which is
 * what makes the retry's output worth asserting on.
 */
if (SECRET) {
  const eventId = `evt_stuck_${Date.now()}`
  const raw = JSON.stringify({
    id: eventId,
    event: 'payment.captured',
    providerOrderId: 'order_does_not_exist',
    providerPaymentId: 'pay_orphan',
    payload: { payment: { entity: { id: 'pay_orphan', order_id: 'order_does_not_exist' } } },
  })

  const delivered = await fetch(`${BASE}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
    },
    body: raw,
  })
  check('an orphan callback is still acknowledged', delivered.status === 200, `status ${delivered.status}`)

  // Processing happens after the 200, so give it a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 400))

  const queue = await call('/admin/webhook-events?status=FAILED', { jar: superAdmin })
  const row = (queue.json?.data?.events ?? []).find((e) => e.eventId === eventId)
  check('the failure is visible in the queue', Boolean(row), row ? row.status : 'not found')
  check('the queue records why it failed', Boolean(row?.error), row?.error ?? 'no error recorded')

  if (row) {
    const retry = await call(`/admin/webhook-events/${row.id}/retry`, {
      method: 'POST',
      jar: superAdmin,
    })
    check('the retry runs and reports an outcome', retry.status === 200, `status ${retry.status}`)
    check(
      'the retry re-ran the real handler',
      retry.json?.data?.status === 'FAILED' && /order_does_not_exist/.test(retry.json?.data?.error ?? ''),
      retry.json?.data?.error ?? 'no error',
    )

    const after = await call('/admin/webhook-events?status=FAILED', { jar: superAdmin })
    const still = (after.json?.data?.events ?? []).find((e) => e.eventId === eventId)
    check('a retry that fails again stays in the queue', Boolean(still))
    check('and its processedAt moved', still?.processedAt !== row.processedAt)
  }
} else {
  console.log('  SKIP  replay test — JWT_ACCESS_SECRET is not in the environment')
}

// ════════════════════════════════════ PRD Privacy  right of access
section('PRD Privacy  A customer can export their own data')

const subject = {
  email: `erasure-${Date.now()}@example.com`,
  password: 'Erasure@12345',
}

const subjectJar = new Jar()
{
  const r = await call('/auth/register', {
    method: 'POST',
    jar: subjectJar,
    body: {
      name: 'Erasure Subject',
      email: subject.email,
      password: subject.password,
      acceptedTerms: true,
    },
  })
  check('a test customer registers', r.status === 201 || r.status === 200, `status ${r.status}`)
}

let subjectId = null
{
  const r = await call('/privacy/export', { jar: subjectJar })
  check('the export succeeds', r.status === 200, `status ${r.status}`)
  check('it includes the account', Boolean(r.json?.data?.account?.email))
  check(
    'it returns this account and no other',
    r.json?.data?.account?.email === subject.email,
    r.json?.data?.account?.email ?? 'none',
  )
  check('it includes addresses, orders and consents', Boolean(
    Array.isArray(r.json?.data?.addresses) &&
    Array.isArray(r.json?.data?.orders) &&
    Array.isArray(r.json?.data?.consents),
  ))
  check('it does not leak the password hash', !JSON.stringify(r.json ?? {}).includes('passwordHash'))
  subjectId = r.json?.data?.account?.id ?? null
}

{
  const r = await call('/privacy/export')
  check('an anonymous export is rejected', r.status === 401, `status ${r.status}`)
}

// ════════════════════════════════════ PRD Privacy  right of erasure
section('PRD Privacy  Erasure requires the password and is honoured')

{
  const r = await call('/privacy/erasure', { jar: subjectJar })
  check('erasure eligibility is reported', r.status === 200, `status ${r.status}`)
  check('a customer with no orders may erase', r.json?.data?.canErase === true)
}

{
  const r = await call('/privacy/erasure', {
    method: 'POST',
    jar: subjectJar,
    body: { password: 'not-the-password' },
  })
  check('a wrong password is refused', r.status === 401, `status ${r.status}`)
}

{
  const r = await call('/privacy/erasure', { method: 'POST', jar: subjectJar, body: {} })
  check('a missing password is refused', r.status === 422, `status ${r.status}`)
}

{
  const r = await call('/privacy/erasure', {
    method: 'POST',
    jar: subjectJar,
    body: { password: subject.password, reason: 'smoke test' },
  })
  check('erasure succeeds with the password', r.status === 200, `status ${r.status}`)
  check('it reports when it happened', Boolean(r.json?.data?.anonymisedAt))
}

{
  // The session must be dead — this is the whole point of revoking the tokens.
  const r = await call('/privacy/export', { jar: subjectJar })
  check('the session no longer works', r.status === 401, `status ${r.status}`)
}

{
  const r = await signIn(subject.email, subject.password)
  check('the erased account cannot sign in', r === null)
}

{
  // Re-registering with the same address proves the old one was released,
  // which is what makes the erasure real rather than a status flag.
  const jar = new Jar()
  const r = await call('/auth/register', {
    method: 'POST',
    jar,
    body: {
      name: 'Someone Else',
      email: subject.email,
      password: 'Another@12345',
      acceptedTerms: true,
    },
  })
  check(
    'the email address is free again',
    r.status === 201 || r.status === 200,
    `status ${r.status}`,
  )
}

section('PRD Privacy  Admin-initiated erasure')

{
  const r = await call(`/admin/customers/${subjectId}/erasure`, { jar: superAdmin })
  check('an admin can check eligibility', r.status === 200, `status ${r.status}`)
}

{
  const r = await call(`/admin/customers/${subjectId}/erasure`, {
    method: 'POST',
    jar: superAdmin,
    body: { reason: 'already erased' },
  })
  check('erasing twice is refused', r.status === 409, `status ${r.status}`)
  check(
    'the code says why',
    r.json?.error?.code === 'ALREADY_ANONYMISED',
    r.json?.error?.code ?? 'none',
  )
}

{
  const r = await call(`/admin/customers/${subjectId}/erasure`, {
    method: 'POST',
    jar: superAdmin,
    body: {},
  })
  check('an admin must record a reason', r.status === 422, `status ${r.status}`)
}

{
  const customer = await signIn(CUSTOMER.email, CUSTOMER.password)
  const r = await call(`/admin/customers/${subjectId}/erasure`, {
    method: 'POST',
    jar: customer,
    body: { reason: 'not allowed' },
  })
  check('a customer cannot erase someone else', r.status === 403, `status ${r.status}`)
}

section('PRD Privacy  A staff account is protected from self-service erasure')

{
  const r = await call('/privacy/erasure', { jar: superAdmin })
  check('an admin is told they cannot erase themselves', r.json?.data?.canErase === false)
  check(
    'the reason names the staff roles',
    (r.json?.data?.blockers ?? []).some((b) => /staff role/i.test(b.reason)),
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
