/**
 * A parcel from the shop floor to a label, without a carrier account.
 *
 * The real carrier's sandbox cannot prove the one thing an operator depends
 * on. Shiprocket mints an AWB and then produces no document behind it —
 * `label_created: 0`, "Failed to create label", no reason given; manifests and
 * invoices fail the same way. Testing against the live account instead debits
 * the wallet on every booking and leaves entries in the passbook. So the path
 * that matters most is exactly the one their test environment cannot run.
 *
 * This runs it against the `fake` carrier, which books, labels, tracks and
 * refuses the way a carrier does. What it proves is ours: that a booking is
 * stored, a label reaches the screen, a status update moves the parcel, and a
 * redelivered event does not move it twice. What it cannot prove is that
 * Shiprocket's own payloads match what the adapter expects — a different
 * question, and the only one that needs an account.
 *
 *   SHIPPING_PROVIDER=fake npm run dev      # in one terminal
 *   node scripts/smoke-carrier.mjs
 *
 * Refuses to run against a server on any other carrier: this books parcels,
 * and against a live carrier that costs money.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const BASE = flag('base', process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1')
const CUSTOMER = { email: 'customer@example.com', password: 'Customer@12345' }
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

const section = (title, note) => console.log(`\n${title}${note ? `  ${note}` : ''}`)
const brief = (value) => JSON.stringify(value ?? '').slice(0, 150)
const settle = () => new Promise((resolve) => setTimeout(resolve, 900))

// ─────────────────────────────────────────────────────────────── plumbing

const session = () => ({ jar: new Map(), csrf: null })

function absorb(s, res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.split('=')
    s.jar.set(name.trim(), rest.join('='))
  }
  if (s.jar.has('csrf')) s.csrf = s.jar.get('csrf')
}

async function call(s, pathname, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { accept: 'application/json', ...headers }
  if (body || raw) h['content-type'] = 'application/json'
  if (s.jar.size) h.cookie = [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  if (s.csrf) h['x-csrf-token'] = s.csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  absorb(s, res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function signIn(s, who) {
  await call(s, '/')
  return call(s, '/auth/login', { method: 'POST', body: who })
}

/** The mock payment provider's signature, so the order can reach PAID. */
const paymentSignature = (orderId, paymentId) =>
  crypto.createHmac('sha256', process.env.JWT_ACCESS_SECRET).update(`${orderId}|${paymentId}`).digest('hex')

console.log(`\n  target ${BASE}`)

// ══════════════════════════════════════════════════ which carrier
section('The carrier under test')

if ((process.env.SHIPPING_PROVIDER ?? '') !== 'fake') {
  console.log(`\n  SHIPPING_PROVIDER is "${process.env.SHIPPING_PROVIDER ?? 'unset'}", not "fake".`)
  console.log('  Refusing to run: this books parcels, and a live carrier charges for that.\n')
  process.exit(1)
}
check('the test carrier is the one configured', true, 'SHIPPING_PROVIDER=fake')

// ══════════════════════════════════════════════════ the customer
section('The customer', 'Quoting and paying')

const cust = session()
await signIn(cust, CUSTOMER)

const products = await call(cust, '/products?perPage=12')
const product = (products.json?.data?.products ?? []).find((p) => p.inStock)
const detail = await call(cust, `/products/${product.slug}`)
const variant = (detail.json?.data?.product?.variants ?? []).find((v) => v.inStock)

const added = await call(cust, '/cart/items', { method: 'POST', body: { variantId: variant.id, quantity: 1 } })
check('a piece goes in the bag', added.status < 300, `${product.name} — ${variant.name}`)

const address = (await call(cust, '/addresses')).json?.data?.addresses?.[0]
const region = `country=IN&state=${encodeURIComponent(address.state)}`

/** A PIN nobody serves must be refused outright, not priced at the flat rate. */
const nowhere = await call(cust, `/shipping/quote?${region}&postalCode=999999`)
check(
  'an unserved PIN code is refused, not quoted',
  nowhere.json?.data?.serviceable === false && (nowhere.json?.data?.methods ?? []).length === 0,
  nowhere.json?.data?.reason ?? brief(nowhere.json?.data),
)

const quote = await call(cust, `/shipping/quote?${region}&postalCode=${address.postalCode}`)
const methods = quote.json?.data?.methods ?? []
check(
  'the carrier prices the delivery options',
  methods.length > 0,
  methods
    .map((m) => `${m.name} ${m.cost === 0 ? 'Free' : `Rs${m.cost / 100}`}${m.rateBand ? ` [${m.rateBand}]` : ''}`)
    .join(' / '),
)
check('each option names the courier behind it', methods.every((m) => m.rateBand))

const method = methods[0]
const placed = await call(cust, '/orders', {
  method: 'POST',
  body: { addressId: address.id, shippingMethodId: method.id },
})
const order = placed.json?.data?.order
check('the order is placed', placed.status === 201, order?.orderNumber ?? brief(placed.json?.error))

if (!order) {
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(1)
}

const intent = (await call(cust, '/payments/create', { method: 'POST', body: { orderId: order.id } })).json?.data
const paymentId = `pay_${crypto.randomBytes(8).toString('hex')}`
await call(cust, '/payments/verify', {
  method: 'POST',
  body: {
    orderId: order.id,
    providerOrderId: intent.providerOrderId,
    providerPaymentId: paymentId,
    signature: paymentSignature(intent.providerOrderId, paymentId),
  },
})
const paidState = (await call(cust, `/orders/${order.id}`)).json?.data?.order?.status
check('the order is paid', paidState === 'PAID', paidState)

// ══════════════════════════════════════════════════ the operator
section('The operator', 'Packing, booking, printing')

const adm = session()
await signIn(adm, ADMIN)

const loaded = await call(adm, `/admin/orders/${order.id}`)
const items = (loaded.json?.data?.order?.items ?? []).map((i) => ({ orderItemId: i.id, quantity: i.quantity }))
const packed = await call(adm, `/admin/shipments/orders/${order.id}`, {
  method: 'POST',
  body: { items, weightGrams: 800 },
})
const shipment = packed.json?.data?.shipment
check('a parcel can be packed', packed.status === 201, shipment?.shipmentNumber ?? brief(packed.json?.error))

/** Nothing booked yet, so there is nothing to print — and it says which. */
const early = await call(adm, `/admin/shipments/${shipment.id}/label`, { method: 'POST' })
check('a parcel never booked has no label to fetch', early.status === 409, early.json?.error?.code ?? early.status)

const booked = await call(adm, `/admin/shipments/${shipment.id}/book`, { method: 'POST' })
const carried = booked.json?.data?.shipment
check(
  'the carrier takes the parcel',
  booked.status === 200 && Boolean(carried?.trackingNumber),
  carried?.trackingNumber ? `${carried.carrier} AWB ${carried.trackingNumber}` : brief(booked.json?.error),
)
check('booking moves it to ready to ship', carried?.status === 'READY_TO_SHIP', carried?.status)
check('the label comes back with the booking', Boolean(carried?.labelUrl), carried?.labelUrl ?? 'none')

const label = await call(adm, `/admin/shipments/${shipment.id}/label`, { method: 'POST' })
check(
  'the label is reachable from the order screen',
  label.status === 200 && Boolean(label.json?.data?.shipment?.labelUrl),
  label.json?.data?.shipment?.labelUrl ?? label.json?.error?.message,
)

/** A customer must not be able to print somebody else's label. */
const stolen = await call(cust, `/admin/shipments/${shipment.id}/label`, { method: 'POST' })
check('a customer cannot fetch a label', stolen.status === 403 || stolen.status === 401, stolen.status)

// ══════════════════════════════════════════════════ the carrier calling back
section('The carrier', 'Tracking, and saying it twice')

const secret = process.env.SHIPPING_WEBHOOK_SECRET
const hook = session()

async function deliverEvent(id, status) {
  const body = JSON.stringify({
    id,
    status,
    trackingNumber: carried.trackingNumber,
    providerShipmentId: carried.providerShipmentId ?? null,
    occurredAt: new Date().toISOString(),
  })
  const signature = crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')
  return call(hook, '/webhooks/shipping/fake', {
    method: 'POST',
    raw: body,
    headers: { 'x-shipping-signature': signature },
  })
}

/** There is no single-parcel endpoint; the list filtered by order is the way. */
const parcel = async () => {
  const listed = await call(adm, `/admin/shipments?orderId=${order.id}`)
  return (listed.json?.data?.shipments ?? []).find((s) => s.id === shipment.id) ?? null
}
const parcelStatus = async () => (await parcel())?.status

/** An unsigned event is somebody else's, whatever it claims to be. */
const forged = await call(hook, '/webhooks/shipping/fake', {
  method: 'POST',
  raw: JSON.stringify({ id: 'forged-1', status: 'delivered', trackingNumber: carried.trackingNumber }),
  headers: { 'x-shipping-signature': 'nonsense' },
})
check('an unsigned tracking update is rejected', forged.status === 400 || forged.status === 401, forged.status)
check('and it did not move the parcel', (await parcelStatus()) === 'READY_TO_SHIP')

const run = `evt_${crypto.randomBytes(6).toString('hex')}`

await deliverEvent(`${run}-pickup`, 'picked_up')
await settle()
check('a pickup moves the parcel to in transit', (await parcelStatus()) === 'IN_TRANSIT', await parcelStatus())

await deliverEvent(`${run}-ofd`, 'out_for_delivery')
await settle()
check('out for delivery reaches the parcel', (await parcelStatus()) === 'OUT_FOR_DELIVERY', await parcelStatus())

const deliveredId = `${run}-delivered`
await deliverEvent(deliveredId, 'delivered')
await settle()
check('delivery closes the parcel', (await parcelStatus()) === 'DELIVERED', await parcelStatus())

/** Carriers redeliver. The second copy must change nothing. */
const before = await parcel()
const repeat = await deliverEvent(deliveredId, 'delivered')
await settle()
const after = await parcel()

check('a redelivered event is accepted, not refused', repeat.status === 200, repeat.status)
check(
  'and it does not move the parcel twice',
  (before?.events?.length ?? 0) === (after?.events?.length ?? 0) && before?.deliveredAt === after?.deliveredAt,
  `${before?.events?.length ?? 0} events, unchanged`,
)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
