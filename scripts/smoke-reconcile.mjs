/**
 * Recovering an order whose payment confirmation never arrived.
 *
 * An order reaches "paid" by two routes and both can fail without a trace.
 * The browser callback does not arrive if the customer closes the tab as the
 * payment window shuts; the webhook does not arrive if nobody registered one,
 * or if its secret does not match. Either way the money is in the account and
 * the order sits in pending payment — and the first anyone knows is a
 * customer asking where their dress is. That happened, with a real order and
 * real money.
 *
 * So there is a third way to ask, and it does not depend on anything reaching
 * us: the gateway is the authority on whether it took the money, so ask it.
 *
 * What this checks is mostly the refusals. Marking a paid order paid is the
 * easy half; the half worth testing is that an authorisation nobody captured,
 * or a capture for the wrong amount, is reported rather than acted on. Both
 * would otherwise ship a dress for money that never arrives.
 *
 *   node scripts/smoke-reconcile.mjs
 *
 * Runs against the mock provider, whose lookup answers from the order id. It
 * never touches a real gateway.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const BASE = flag('base', process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1')
const ADMIN = { email: flag('email', 'admin@example.com'), password: flag('password', 'Admin@12345') }

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

const session = () => ({ jar: new Map(), csrf: null })

function absorb(s, res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.split('=')
    s.jar.set(name.trim(), rest.join('='))
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

console.log(`\n  target ${BASE}`)

if ((process.env.PAYMENT_PROVIDER ?? 'mock') !== 'mock') {
  console.log(`\n  PAYMENT_PROVIDER is "${process.env.PAYMENT_PROVIDER}", not "mock".`)
  console.log('  Refusing to run: this asks a gateway about real orders.\n')
  process.exit(1)
}

const adm = session()
await call(adm, '/')
await call(adm, '/auth/login', { method: 'POST', body: ADMIN })

const db = new PrismaClient()

/**
 * A pending order with a payment row, which is what a stranded order looks
 * like: the customer reached the payment window, so a provider order id was
 * written, and nothing came back.
 */
async function strandedOrder(suffix) {
  const order = await db.order.findFirst({
    where: { status: 'PENDING_PAYMENT' },
    orderBy: { createdAt: 'desc' },
  })
  if (!order) return null

  const providerOrderId = `order_mock_${order.total}${suffix}`
  await db.payment.deleteMany({ where: { orderId: order.id } })
  await db.payment.create({
    data: {
      orderId: order.id,
      provider: 'mock',
      providerOrderId,
      amount: order.total,
      currency: 'INR',
      status: 'CREATED',
    },
  })
  return { order, providerOrderId }
}

const reset = async (orderId) => {
  await db.order.update({ where: { id: orderId }, data: { status: 'PENDING_PAYMENT' } })
  await db.orderStatusHistory.deleteMany({ where: { orderId, toStatus: 'PAID' } })
}

const first = await strandedOrder('')
if (!first) {
  console.log('\n  No pending order here to work with.\n')
  await db.$disconnect()
  process.exit(0)
}
console.log(`  using ${first.order.orderNumber}, total Rs${first.order.total / 100}\n`)

// ══════════════════════════════════════════════════ the refusals
section('What it refuses to act on', 'The half that matters')

for (const [suffix, outcome, why] of [
  ['auth', 'authorized', 'money held, never taken — it releases itself in a few days'],
  ['part', 'amount_mismatch', 'captured, but not the whole amount'],
  ['none', 'none', 'the gateway has no payment at all'],
]) {
  const { order } = await strandedOrder(suffix)
  const r = await call(adm, `/admin/orders/${order.id}/reconcile-payment`, { method: 'POST', body: {} })
  const after = await db.order.findUnique({ where: { id: order.id }, select: { status: true } })

  check(`${outcome} is reported, not acted on`, r.json?.data?.outcome === outcome, why)
  check('  and the order is left pending', after.status === 'PENDING_PAYMENT', after.status)
}

// ══════════════════════════════════════════════════ the recovery
section('What it does act on', 'A payment the gateway confirms')

{
  const { order } = await strandedOrder('')
  const r = await call(adm, `/admin/orders/${order.id}/reconcile-payment`, { method: 'POST', body: {} })
  const data = r.json?.data

  check('a captured payment is recognised', data?.outcome === 'paid', data?.message)
  check('the payment id is recorded', Boolean(data?.providerPaymentId), data?.providerPaymentId)

  const after = await db.order.findUnique({
    where: { id: order.id },
    include: { statusHistory: { where: { toStatus: 'PAID' } }, payments: true },
  })
  check('the order is marked paid', after.status === 'PAID', after.status)
  check(
    'the history says it was settled by hand',
    after.statusHistory.some((h) => /reconciliation/i.test(h.note ?? '')),
    after.statusHistory.at(-1)?.note,
  )
  check('the payment row is captured', after.payments.some((p) => p.status === 'CAPTURED'))

  /** Pressing it twice must not pay the order twice. */
  const again = await call(adm, `/admin/orders/${order.id}/reconcile-payment`, { method: 'POST', body: {} })
  const twice = await db.order.findUnique({
    where: { id: order.id },
    include: { statusHistory: { where: { toStatus: 'PAID' } } },
  })
  check('asking again changes nothing', again.json?.data?.outcome === 'already_paid', again.json?.data?.outcome)
  check('and does not record a second payment', twice.statusHistory.length === after.statusHistory.length)

  await reset(order.id)
}

// ══════════════════════════════════════════════════ who may ask
section('Who may ask')

{
  const cust = session()
  await call(cust, '/')
  await call(cust, '/auth/login', {
    method: 'POST',
    body: { email: 'customer@example.com', password: 'Customer@12345' },
  })
  const denied = await call(cust, `/admin/orders/${first.order.id}/reconcile-payment`, {
    method: 'POST',
    body: {},
  })
  check('a customer cannot', denied.status === 403 || denied.status === 401, String(denied.status))
}

await db.payment.deleteMany({ where: { orderId: first.order.id, provider: 'mock' } })
await db.$disconnect()

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
