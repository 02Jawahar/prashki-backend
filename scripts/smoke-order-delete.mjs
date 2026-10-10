/**
 * Removing an order, and refusing to.
 *
 * This endpoint exists to clear the test orders a build leaves behind in a
 * production database before real customers arrive. It is the most dangerous
 * route in the system: what it removes cannot be recovered from anywhere here,
 * and an order that took money leaves a payment at the gateway with nothing
 * left to reconcile against.
 *
 * So the refusals are the point. An order with a captured payment must come
 * back 409 rather than vanish, the confirmation must be required verbatim, and
 * everything hanging off a deleted order must go with it rather than leaving
 * half a record behind.
 *
 *   node scripts/smoke-order-delete.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

let passed = 0
let failed = 0
const check = (l, ok, d) => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

const jar = new Map()
let csrf = null
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [n, ...r] = pair.split('=')
    jar.set(n.trim(), r.join('='))
  }
  if (jar.has('csrf')) csrf = jar.get('csrf')
}
async function call(p, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  if (csrf) headers['x-csrf-token'] = csrf
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log(`\n  target ${BASE}`)

const db = new PrismaClient()
await call('/')
const login = await call('/auth/login', { method: 'POST', body: ADMIN })
if (login.status !== 200) {
  console.log(`\n  could not sign in as ${ADMIN.email} (${login.status})\n`)
  process.exit(1)
}

const user = await db.user.findFirst({ where: { email: ADMIN.email } })
const variant = await db.productVariant.findFirst({ select: { id: true, productId: true, price: true } })
if (!user || !variant) {
  console.log('\n  need a user and at least one variant in the local database\n')
  process.exit(1)
}

/** An order with whatever payment state the test needs hung off it. */
async function makeOrder(number, paymentStatus) {
  const order = await db.order.create({
    data: {
      orderNumber: number,
      userId: user.id,
      status: 'PENDING_PAYMENT',
      subtotal: 250000,
      total: 250000,
      shippingAddressSnapshot: { name: 'Smoke', phone: '9000000000' },
      billingAddressSnapshot: { name: 'Smoke', phone: '9000000000' },
      items: {
        create: [
          {
            variantId: variant.id,
            productId: variant.productId,
            productNameSnapshot: 'Smoke item',
            variantNameSnapshot: 'M',
            sku: 'SMOKE-1',
            unitPrice: 250000,
            quantity: 1,
            lineTotal: 250000,
          },
        ],
      },
      statusHistory: { create: [{ toStatus: 'PENDING_PAYMENT', changedById: user.id }] },
      payments: {
        create: [
          {
            provider: 'mock',
            status: paymentStatus,
            amount: 250000,
            providerPaymentId: paymentStatus === 'CAPTURED' ? `pay_smoke_${Date.now()}` : null,
          },
        ],
      },
    },
    include: { items: true, payments: true },
  })
  return order
}

section('An order nobody paid for')
const unpaid = await makeOrder(`ORD-SMOKE-${Date.now()}`, 'CREATED')

const noConfirm = await call(`/admin/orders/${unpaid.id}/delete`, { method: 'POST', body: {} })
check('refuses without the confirmation', noConfirm.status === 422, `got ${noConfirm.status}`)

const wrongConfirm = await call(`/admin/orders/${unpaid.id}/delete`, {
  method: 'POST',
  body: { confirm: 'delete' },
})
check('refuses a lowercase confirmation', wrongConfirm.status === 422, 'verbatim or not at all')

const gone = await call(`/admin/orders/${unpaid.id}/delete`, {
  method: 'POST',
  body: { confirm: 'DELETE' },
})
check('deletes when confirmed', gone.status === 200, gone.json?.data?.orderNumber ?? '')
check('and it is really gone', (await db.order.count({ where: { id: unpaid.id } })) === 0)

section('Nothing is left hanging')
check('its items went too', (await db.orderItem.count({ where: { orderId: unpaid.id } })) === 0)
check('its payments went too', (await db.payment.count({ where: { orderId: unpaid.id } })) === 0)
check(
  'its status history went too',
  (await db.orderStatusHistory.count({ where: { orderId: unpaid.id } })) === 0,
)

section('An order that took real money')
const paid = await makeOrder(`ORD-SMOKE-P-${Date.now()}`, 'CAPTURED')

const refused = await call(`/admin/orders/${paid.id}/delete`, {
  method: 'POST',
  body: { confirm: 'DELETE' },
})
check('is refused even when confirmed', refused.status === 409, `got ${refused.status}`)
check(
  'and says why, naming the payment',
  refused.json?.error?.code === 'ORDER_HAS_CAPTURED_PAYMENT',
  refused.json?.error?.details?.[0]?.providerPaymentId ?? '',
)
check('and is still there', (await db.order.count({ where: { id: paid.id } })) === 1)

const forced = await call(`/admin/orders/${paid.id}/delete`, {
  method: 'POST',
  body: { confirm: 'DELETE', force: true },
})
check('goes only when forced as well', forced.status === 200)
check(
  'and hands back the payment id to reconcile',
  Array.isArray(forced.json?.data?.capturedPayments) &&
    forced.json.data.capturedPayments.length === 1,
  forced.json?.data?.capturedPayments?.[0] ?? '',
)

section('It leaves a trace')
/*
 * The audit row is the only place a deleted order still exists, so it is
 * written before the delete rather than after.
 */
const audit = await db.auditLog.findFirst({
  where: { action: 'ORDER_DELETED', entityId: paid.id },
})
check('an audit entry records what was removed', Boolean(audit))
check('including the money that moved', JSON.stringify(audit?.metadata ?? {}).includes('pay_smoke'))
check('and that it was forced', JSON.stringify(audit?.metadata ?? {}).includes('"forced":true'))

await db.auditLog.deleteMany({ where: { action: 'ORDER_DELETED', entityId: { in: [unpaid.id, paid.id] } } })
await db.$disconnect()

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
