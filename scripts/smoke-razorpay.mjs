/**
 * Razorpay test-mode verification — exercises the real gateway.
 *
 * Unlike smoke-payments.mjs (which uses the dev provider), this talks to
 * Razorpay's actual test API: the order is created on their side, and the
 * callback signature is verified against the real key secret.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))
const KEY_ID = process.env.RAZORPAY_KEY_ID
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
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
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('csrf='))
  return c ? c.split(';')[0].slice('csrf='.length) : null
}

async function call(p, { method = 'GET', body, jar, rawBody, headers: extra } = {}) {
  const headers = { accept: 'application/json', ...extra }
  if (body || rawBody) headers['content-type'] = 'application/json'
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
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nRAZORPAY (test mode) — live gateway\n')
check('test-mode key id loaded', Boolean(KEY_ID), KEY_ID)
check('key is TEST mode, not live', Boolean(KEY_ID?.startsWith('rzp_test_')), KEY_ID?.slice(0, 9))
check('key secret loaded', Boolean(KEY_SECRET), `${KEY_SECRET?.length} chars`)
check('webhook secret set', Boolean(WEBHOOK_SECRET))

// ---- place an order -------------------------------------------------------
const jar = new Jar()
await call('/auth/login', { method: 'POST', jar, body: { email: 'customer@example.com', password: 'Customer@12345' } })

const listing = await call('/products?perPage=12&inStock=true')
let target = null
for (const p of listing.json.data.products) {
  const d = await call(`/products/${p.slug}`)
  const v = d.json.data.product.variants.find((x) => x.stock >= 2)
  if (v) { target = v; break }
}

await call('/cart', { method: 'DELETE', jar })
await call('/cart/items', { method: 'POST', jar, body: { variantId: target.id, quantity: 1 } })
const addressId = (await call('/addresses', { jar })).json.data.addresses[0].id
const orderRes = await call('/orders', { method: 'POST', jar, body: { addressId } })
const order = orderRes.json.data.order
check('order placed locally', orderRes.status === 201, order?.orderNumber)

// ---- create the order ON RAZORPAY ----------------------------------------
const intentRes = await call('/payments/create', { method: 'POST', jar, body: { orderId: order.id } })
const intent = intentRes.json?.data
check('payment intent created', intentRes.status === 200, JSON.stringify(intentRes.json?.error ?? '').slice(0, 140))
check('provider is razorpay, not mock', intent?.provider === 'razorpay', intent?.provider)
check('Razorpay returned a real order id', /^order_[A-Za-z0-9]+$/.test(intent?.providerOrderId ?? ''), intent?.providerOrderId)
check('amount matches our order total', intent?.amount === order.total, `${intent?.amount} vs ${order.total}`)
check('publishable key reaches the client', intent?.publicKey === KEY_ID, intent?.publicKey)
check('key SECRET never reaches the client', !JSON.stringify(intentRes.json).includes(KEY_SECRET))

// ---- confirm the order exists on Razorpay's side --------------------------
if (intent?.providerOrderId) {
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')
  const rz = await fetch(`https://api.razorpay.com/v1/orders/${intent.providerOrderId}`, {
    headers: { authorization: `Basic ${auth}` },
  })
  const rzOrder = await rz.json().catch(() => null)
  check('order is retrievable from Razorpay API', rz.status === 200, `HTTP ${rz.status}`)
  check('Razorpay agrees on the amount', rzOrder?.amount === order.total, `${rzOrder?.amount} vs ${order.total}`)
  check('Razorpay receipt is our order number', rzOrder?.receipt === order.orderNumber, rzOrder?.receipt)
  check('our orderId travelled in notes', rzOrder?.notes?.orderId === order.id)
  check('order opens in created state', rzOrder?.status === 'created', rzOrder?.status)
}

// ---- signature verification, against the REAL secret ----------------------
const fakePaymentId = 'pay_TESTFORGERY0001'
const forged = await call('/payments/verify', {
  method: 'POST',
  jar,
  body: {
    orderId: order.id,
    providerOrderId: intent.providerOrderId,
    providerPaymentId: fakePaymentId,
    signature: 'deadbeef'.repeat(8),
  },
})
check('forged signature rejected by the real verifier', forged.status === 402, forged.json?.error?.code)

const pending = await call(`/orders/${order.id}`, { jar })
check('order not paid after a forged callback', pending.json?.data?.order?.status === 'PENDING_PAYMENT', pending.json?.data?.order?.status)

const realSig = crypto.createHmac('sha256', KEY_SECRET).update(`${intent.providerOrderId}|${fakePaymentId}`).digest('hex')
const accepted = await call('/payments/verify', {
  method: 'POST',
  jar,
  body: {
    orderId: order.id,
    providerOrderId: intent.providerOrderId,
    providerPaymentId: fakePaymentId,
    signature: realSig,
  },
})
check('correctly-signed callback accepted', accepted.status === 200, accepted.json?.data?.status)

const after = await call(`/orders/${order.id}`, { jar })
check('order moves to PAID only after verification', after.json?.data?.order?.status === 'PAID', after.json?.data?.order?.status)

// ---- webhook, signed with the real webhook secret -------------------------
const evt = JSON.stringify({
  id: `evt_test_${crypto.randomBytes(6).toString('hex')}`,
  event: 'payment.captured',
  payload: {
    payment: {
      entity: { id: fakePaymentId, order_id: intent.providerOrderId, amount: order.total, status: 'captured' },
    },
  },
})

const bad = await call('/webhooks/razorpay', {
  method: 'POST',
  rawBody: evt,
  headers: { 'x-razorpay-signature': 'nope' },
})
check('webhook with a bad signature rejected', bad.status === 400, bad.json?.error?.code)

const whSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(evt).digest('hex')
const good = await call('/webhooks/razorpay', {
  method: 'POST',
  rawBody: evt,
  headers: { 'x-razorpay-signature': whSig },
})
check('correctly-signed webhook accepted', good.status === 200, `duplicate=${good.json?.data?.duplicate}`)

const replay = await call('/webhooks/razorpay', {
  method: 'POST',
  rawBody: evt,
  headers: { 'x-razorpay-signature': whSig },
})
check('replayed webhook is a no-op', replay.status === 200 && replay.json?.data?.duplicate === true)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
