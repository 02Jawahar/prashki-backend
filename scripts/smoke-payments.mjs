/**
 * STEP 9 verification — the payment rules from spec §31–33 and §70.
 *
 * Runs against the development provider, which signs with the same HMAC shape
 * Razorpay uses, so the server-side verification path is genuinely exercised.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'

// The mock provider signs with JWT_ACCESS_SECRET; read it the same way the app does.
const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))
const SECRET = process.env.JWT_ACCESS_SECRET

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

/** A CSRF token for calls made without a cookie jar. Fetched once. */
let sharedCsrf = null
async function primeCsrf() {
  const res = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
  return cookie ? cookie.split(';')[0].slice('csrf='.length) : null
}
async function call(path, { method = 'GET', body, jar, rawBody, headers: extra } = {}) {
  const headers = { accept: 'application/json', ...extra }
  if (body) headers['content-type'] = 'application/json'
  if (rawBody) headers['content-type'] = 'application/json'
  // Signed double-submit. The token arrives on the first response and login
  // is itself a write, so an unsafe request primes one before it goes out —
  // whether or not this particular call is carrying a cookie jar.
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
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

const sign = (a, b) => crypto.createHmac('sha256', SECRET).update(`${a}|${b}`).digest('hex')
const signBody = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex')

console.log('\nSTEP 9 — payments\n')
check('signing secret loaded from the environment', Boolean(SECRET))

// Place a fresh order to pay for.
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
const addresses = await call('/addresses', { jar })
const addressId = addresses.json.data.addresses[0].id
const orderRes = await call('/orders', { method: 'POST', jar, body: { addressId } })
const order = orderRes.json.data.order
check('order created for the payment test', orderRes.status === 201, order?.orderNumber)

// --------------------------------------------------------- create intent
let intent
{
  const r = await call('/payments/create', { method: 'POST', jar, body: { orderId: order.id } })
  intent = r.json?.data
  check('payment intent is created server-side', r.status === 200, `${intent?.provider}`)
  check('amount comes from the order, not the client', intent?.amount === order.total, `${intent?.amount} vs ${order.total}`)
  check('no secret key is returned to the client', !JSON.stringify(r.json).match(/secret/i))
}

// A guest must not be able to start a payment for someone else's order.
{
  const anon = new Jar()
  const r = await call('/payments/create', { method: 'POST', jar: anon, body: { orderId: order.id } })
  check('anonymous cannot create a payment', r.status === 401, `${r.status}`)

  const other = new Jar()
  await call('/auth/register', { method: 'POST', jar: other, body: { name: 'Third Party', email: `tp_${Date.now()}@example.com`, password: 'Password@123', acceptedTerms: true } })
  const r2 = await call('/payments/create', { method: 'POST', jar: other, body: { orderId: order.id } })
  check("another customer cannot pay for someone else's order", r2.status === 404, `${r2.status}`)
}

// ------------------------------------------------------------- verify
{
  // Forged signature must be rejected — this is the whole point of spec §31.
  const bad = await call('/payments/verify', {
    method: 'POST', jar,
    body: {
      orderId: order.id,
      providerOrderId: intent.providerOrderId,
      providerPaymentId: 'pay_forged',
      signature: 'not-a-real-signature',
    },
  })
  check('a forged signature is rejected', bad.status === 402 && bad.json?.error?.code === 'SIGNATURE_INVALID', `${bad.status} ${bad.json?.error?.code}`)

  const stillPending = await call(`/orders/${order.id}`, { jar })
  check('order is NOT paid after a forged callback', stillPending.json?.data?.order?.status === 'PENDING_PAYMENT')
}

{
  const paymentId = `pay_${crypto.randomBytes(8).toString('hex')}`
  const good = await call('/payments/verify', {
    method: 'POST', jar,
    body: {
      orderId: order.id,
      providerOrderId: intent.providerOrderId,
      providerPaymentId: paymentId,
      signature: sign(intent.providerOrderId, paymentId),
    },
  })
  check('a valid signature is accepted', good.status === 200 && good.json?.data?.verified === true, `${good.status}`)
  check('order becomes PAID only after verification', good.json?.data?.status === 'PAID', good.json?.data?.status)

  const detail = await call(`/orders/${order.id}`, { jar })
  check('payment is recorded as CAPTURED', detail.json?.data?.order?.payments?.[0]?.status === 'CAPTURED')
  check('status history records the payment', detail.json?.data?.order?.statusHistory?.some((h) => h.toStatus === 'PAID'))
}

// ------------------------------------------------------------ webhooks
{
  // Unsigned webhook must be refused.
  const raw = JSON.stringify({ id: `evt_${Date.now()}`, event: 'payment.captured', providerOrderId: intent.providerOrderId })
  const unsigned = await call('/webhooks/razorpay', { method: 'POST', rawBody: raw })
  check('unsigned webhook is rejected', unsigned.status === 400, `${unsigned.status} ${unsigned.json?.error?.code}`)

  const wrongSig = await call('/webhooks/razorpay', {
    method: 'POST', rawBody: raw,
    headers: { 'x-razorpay-signature': 'deadbeef' },
  })
  check('webhook with a bad signature is rejected', wrongSig.status === 400, `${wrongSig.status}`)
}

// Idempotency: same event id twice must only be processed once.
{
  const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`
  const raw = JSON.stringify({
    id: eventId,
    event: 'payment.captured',
    providerOrderId: intent.providerOrderId,
    providerPaymentId: 'pay_webhook_1',
    amount: order.total,
  })
  const signature = signBody(raw)

  const first = await call('/webhooks/razorpay', { method: 'POST', rawBody: raw, headers: { 'x-razorpay-signature': signature } })
  check('signed webhook is accepted', first.status === 200 && first.json?.data?.received === true, `${first.status}`)
  check('first delivery is not flagged duplicate', first.json?.data?.duplicate !== true)

  const second = await call('/webhooks/razorpay', { method: 'POST', rawBody: raw, headers: { 'x-razorpay-signature': signature } })
  check('redelivery is acknowledged as a duplicate', second.status === 200 && second.json?.data?.duplicate === true, `${second.status}`)

  // Let the async processing settle, then confirm nothing was double-applied.
  await new Promise((r) => setTimeout(r, 800))
  const detail = await call(`/orders/${order.id}`, { jar })
  const paidTransitions = detail.json.data.order.statusHistory.filter((h) => h.toStatus === 'PAID')
  check('order was marked PAID exactly once', paidTransitions.length === 1, `${paidTransitions.length} PAID transitions`)
}

// An amount that disagrees with the order must not mark it paid.
{
  // New order to test against.
  await call('/cart/items', { method: 'POST', jar, body: { variantId: target.id, quantity: 1 } })
  const o2 = (await call('/orders', { method: 'POST', jar, body: { addressId } })).json.data.order
  const i2 = (await call('/payments/create', { method: 'POST', jar, body: { orderId: o2.id } })).json.data

  const raw = JSON.stringify({
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    event: 'payment.captured',
    providerOrderId: i2.providerOrderId,
    providerPaymentId: 'pay_underpaid',
    amount: 1, // one paisa
  })
  await call('/webhooks/razorpay', { method: 'POST', rawBody: raw, headers: { 'x-razorpay-signature': signBody(raw) } })
  await new Promise((r) => setTimeout(r, 800))

  const detail = await call(`/orders/${o2.id}`, { jar })
  check('an underpaid webhook does not mark the order paid', detail.json?.data?.order?.status === 'PENDING_PAYMENT', detail.json?.data?.order?.status)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
