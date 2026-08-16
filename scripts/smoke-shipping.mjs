/**
 * MODULE 21 — Shipping & Delivery Management.
 *
 * One check per functional requirement and per business rule, plus the three
 * acceptance criteria the PRD names:
 *
 *   - representative addresses receive the correct eligible methods and charges
 *   - shipment creation stores the provider reference and updates the workflow
 *   - duplicate or out-of-order provider events do not corrupt shipment state
 *
 * Run against a freshly seeded database with the API up.
 */
import crypto from 'node:crypto'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
}
const CUSTOMER = {
  email: process.env.CUSTOMER_EMAIL ?? 'customer@example.com',
  password: process.env.CUSTOMER_PASSWORD ?? 'Customer@12345',
}
const WEBHOOK_SECRET = process.env.SHIPPING_WEBHOOK_SECRET ?? ''

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

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()
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

/** Posts a canonical carrier callback, signed the way the adapter expects. */
async function carrierWebhook(payload, { signature } = {}) {
  const raw = JSON.stringify(payload)
  const sig =
    signature ?? crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')

  const res = await fetch(`${BASE}/webhooks/shipping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shipping-signature': sig },
    body: raw,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: res.status, json }
}

/** The webhook responds before processing, so give the write a moment. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

console.log('\nMODULE 21 — Shipping & Delivery Management\n')

if (!WEBHOOK_SECRET) {
  console.log('  SKIP  carrier webhook checks — SHIPPING_WEBHOOK_SECRET is not set\n')
}

const admin = new Jar()
const customer = new Jar()

{
  const a = await call('/auth/login', { method: 'POST', jar: admin, body: ADMIN })
  const c = await call('/auth/login', { method: 'POST', jar: customer, body: CUSTOMER })
  if (a.status !== 200 || c.status !== 200) {
    console.log('Cannot continue without both sessions.')
    process.exit(1)
  }
}

// ══════════════════════════════════ FR-21.1 — zones, methods, serviceability
section('FR-21.1  Zones, methods, charges, thresholds and serviceability')

{
  const r = await call('/admin/shipping/zones', { jar: admin })
  const zones = r.json?.data?.zones ?? []
  const blocked = zones.find((z) => !z.isServiceable)
  const fallback = zones.find((z) => z.isDefault)

  check('zones are configurable from admin', zones.length >= 3, `${zones.length} zones`)
  check('a zone can be marked non-serviceable', Boolean(blocked), blocked?.name)
  check('a default zone catches unmatched addresses', Boolean(fallback), fallback?.name)
  check(
    'the active carrier adapter is reported',
    typeof r.json?.data?.provider?.name === 'string',
    `${r.json?.data?.provider?.name}, canCreateShipments=${r.json?.data?.provider?.canCreateShipments}`,
  )

  const withBands = zones
    .flatMap((z) => z.methods)
    .find((m) => (m.rates?.length ?? 0) > 0)
  check('methods carry rate bands', Boolean(withBands), `${withBands?.rates?.length} bands`)

  const capped = zones.flatMap((z) => z.methods).find((m) => m.maxWeightGrams)
  check('a method can declare a carrier weight ceiling', Boolean(capped), capped?.name)
}

{
  const ok = await call('/shipping/serviceability?postalCode=110003')
  const no = await call('/shipping/serviceability?postalCode=744101')

  check('a serviceable PIN is confirmed', ok.json?.data?.serviceable === true, ok.json?.data?.zone?.name)
  check('a delivery estimate is returned', typeof ok.json?.data?.estimate?.minDays === 'number')
  check('a blocked PIN is refused', no.json?.data?.serviceable === false, no.json?.data?.zone?.name)
  check(
    'the refusal carries a customer-safe message',
    typeof no.json?.data?.reason === 'string' && no.json.data.reason.length > 10,
    no.json?.data?.reason,
  )
}

// ══════════════════════ FR-21.2 — eligible methods for address, cart, parcel
section('FR-21.2  Eligible methods and estimates for address, cart and parcel')

let variant = null
{
  const listing = await call('/products?perPage=12&inStock=true')
  const slug = listing.json?.data?.products?.[0]?.slug
  const detail = await call(`/products/${slug}`)
  variant = detail.json?.data?.product?.variants?.find((v) => v.stock > 3) ?? null
  check('a purchasable variant is available', Boolean(variant))

  await call('/cart/items', { method: 'POST', jar: customer, body: { variantId: variant.id, quantity: 1 } })
}

let metroMethods = []
{
  const metro = await call('/shipping/quote?country=IN&state=Delhi&postalCode=110003', { jar: customer })
  metroMethods = metro.json?.data?.methods ?? []

  check('a metro address resolves to the metro zone', metro.json?.data?.zone?.name === 'Metro cities', metro.json?.data?.zone?.name)
  check('eligible methods are returned', metroMethods.length >= 1, `${metroMethods.length} methods`)
  check('the parcel weight is reported', (metro.json?.data?.weightGrams ?? 0) > 0, `${metro.json?.data?.weightGrams} g`)
  check(
    'the applicable rate band is named',
    metroMethods.some((m) => typeof m.rateBand === 'string' && m.rateBand.length > 0),
    metroMethods.find((m) => m.rateBand)?.rateBand,
  )

  const remote = await call('/shipping/quote?country=IN&state=Assam&postalCode=781001', { jar: customer })
  check('an address outside the metro zone falls back to India', remote.json?.data?.zone?.name === 'India', remote.json?.data?.zone?.name)

  const remoteStandard = (remote.json?.data?.methods ?? []).find((m) => m.name === 'Standard delivery')
  const metroStandard = metroMethods.find((m) => m.name === 'Standard delivery')
  check(
    'the metro zone is cheaper than the national zone',
    metroStandard && remoteStandard && metroStandard.rate < remoteStandard.rate,
    `metro ${metroStandard?.rate} vs india ${remoteStandard?.rate}`,
  )
}

{
  // Weight drives the band: one unit is under 2 kg, twelve is well over 5 kg.
  const light = await call('/shipping/quote?country=IN&state=Delhi&postalCode=110003', { jar: customer })
  const lightRate = (light.json?.data?.methods ?? []).find((m) => m.name === 'Standard delivery')?.rate
  const lightWeight = light.json?.data?.weightGrams

  const item = (await call('/cart', { jar: customer })).json?.data?.cart?.items?.[0]
  await call(`/cart/items/${item.id}`, { method: 'PATCH', jar: customer, body: { quantity: 12 } })

  const heavy = await call('/shipping/quote?country=IN&state=Delhi&postalCode=110003', { jar: customer })
  const heavyRate = (heavy.json?.data?.methods ?? []).find((m) => m.name === 'Standard delivery')?.rate
  const heavyWeight = heavy.json?.data?.weightGrams

  check('parcel weight scales with quantity', heavyWeight > lightWeight, `${lightWeight} g → ${heavyWeight} g`)
  check('a heavier parcel costs more', heavyRate > lightRate, `${lightRate} → ${heavyRate}`)

  const nextDay = (heavy.json?.data?.methods ?? []).find((m) => m.name === 'Next-day delivery')
  check(
    'a method is withdrawn once the parcel exceeds its weight ceiling',
    heavyWeight > 5_000 ? nextDay === undefined : true,
    heavyWeight > 5_000 ? 'next-day withdrawn' : `parcel only ${heavyWeight} g — ceiling not reached`,
  )

  await call(`/cart/items/${item.id}`, { method: 'PATCH', jar: customer, body: { quantity: 1 } })
}

{
  const blocked = await call('/shipping/quote?country=IN&postalCode=744101', { jar: customer })
  check('a non-serviceable address offers nothing', (blocked.json?.data?.methods ?? []).length === 0)
  check('and says so rather than defaulting to free', blocked.json?.data?.serviceable === false)
}

// ═══════════════════ business rule — checkout cannot pick an ineligible method
section('Business rule  Checkout cannot select an ineligible or stale method')

let orderId = null
let orderNumber = null
{
  const addresses = await call('/addresses', { jar: customer })
  const addressId = addresses.json?.data?.addresses?.[0]?.id

  // The seeded address is in Delhi, so a national-zone method must be refused.
  const india = await call('/shipping/quote?country=IN&state=Assam&postalCode=781001', { jar: customer })
  const foreignMethod = (india.json?.data?.methods ?? [])[0]

  const wrongZone = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: { addressId, shippingMethodId: foreignMethod.id, idempotencyKey: `ship-wrong-${Date.now()}` },
  })
  check(
    'a method from another zone is refused at checkout',
    wrongZone.status === 422,
    `status ${wrongZone.status}`,
  )

  const bogus = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: { addressId, shippingMethodId: 'does-not-exist', idempotencyKey: `ship-bogus-${Date.now()}` },
  })
  check('an unknown method id is refused', bogus.status === 404, `status ${bogus.status}`)

  const placed = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: {
      addressId,
      shippingMethodId: metroMethods.find((m) => m.name === 'Standard delivery').id,
      idempotencyKey: `ship-ok-${Date.now()}`,
    },
  })
  const order = placed.json?.data?.order
  orderId = order?.id
  orderNumber = order?.orderNumber

  check('a correctly zoned method is accepted', placed.status === 201, `status ${placed.status}`)
  check('the charge on the order matches the quote', order?.shipping === metroMethods.find((m) => m.name === 'Standard delivery').cost, `order ${order?.shipping}`)
  check('the method name is snapshotted', order?.shippingMethodName === 'Standard delivery', order?.shippingMethodName)
}

// ══════════════════════════════ FR-21.3 / FR-21.4 — creation, label, package
section('FR-21.3 / FR-21.4  Shipment creation, package and dispatch data')

let shipmentId = null
let trackingNumber = `SMOKE${Date.now()}`
{
  await call(`/admin/orders/${orderId}/status`, { method: 'PATCH', jar: admin, body: { status: 'PAID' } })

  const detail = await call(`/admin/orders/${orderId}`, { jar: admin })
  const items = detail.json?.data?.order?.items ?? []

  const created = await call(`/admin/shipments/orders/${orderId}`, {
    method: 'POST',
    jar: admin,
    body: {
      items: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      carrier: 'delhivery',
      trackingNumber,
      lengthMm: 300,
      widthMm: 220,
      heightMm: 90,
      dispatchedBy: 'Studio',
    },
  })
  const shipment = created.json?.data?.shipment
  shipmentId = shipment?.id

  check('a shipment is created', created.status === 201, `status ${created.status}`)
  check('the parcel weight is recorded', (shipment?.weightGrams ?? 0) > 0, `${shipment?.weightGrams} g`)
  check('package dimensions are stored', shipment?.lengthMm === 300 && shipment?.heightMm === 90)
  check('dispatch data is stored', shipment?.dispatchedBy === 'Studio' && Boolean(shipment?.packedAt))
  check('a tracking URL is built from the carrier', shipment?.trackingUrl?.includes(trackingNumber) === true)
  check('shipping everything advances the order', created.json?.data?.fullyShipped === true)
}

{
  // The manual adapter refuses rather than inventing an AWB — a fake reference
  // would let the workflow believe a parcel was booked when it was not.
  const booked = await call(`/admin/shipments/${shipmentId}/book`, { method: 'POST', jar: admin })
  check(
    'the manual adapter refuses to fabricate a carrier booking',
    booked.status === 409,
    `status ${booked.status} ${booked.json?.error?.code ?? ''}`,
  )
}

// ═════════════════════════════════════════ FR-21.5 — provider status updates
section('FR-21.5  Verified, idempotent carrier callbacks')

if (WEBHOOK_SECRET) {
  {
    const bad = await carrierWebhook(
      { id: `evt-forged-${Date.now()}`, trackingNumber, status: 'delivered' },
      { signature: 'f'.repeat(64) },
    )
    check(
      'a forged signature is rejected',
      bad.status === 400 && bad.json?.error?.code === 'WEBHOOK_SIGNATURE_INVALID',
      `status ${bad.status} ${bad.json?.error?.code}`,
    )

    const after = await call(`/admin/shipments?orderId=${orderId}`, { jar: admin })
    check(
      'and the shipment is untouched',
      after.json?.data?.shipments?.[0]?.status !== 'DELIVERED',
      after.json?.data?.shipments?.[0]?.status,
    )
  }

  {
    const unknown = await carrierWebhook({
      id: `evt-unknown-${Date.now()}`,
      trackingNumber,
      status: 'teleported',
    })
    check(
      'an unmapped carrier status is refused rather than guessed',
      unknown.status === 400 && unknown.json?.error?.code === 'WEBHOOK_UNKNOWN_STATUS',
      `status ${unknown.status} ${unknown.json?.error?.code}`,
    )
  }

  const ofdEvent = `evt-ofd-${Date.now()}`
  {
    const r = await carrierWebhook({
      id: ofdEvent,
      trackingNumber,
      status: 'out_for_delivery',
      message: 'Out with the rider',
      location: 'New Delhi',
    })
    check('a valid callback is accepted', r.status === 200, `status ${r.status}`)
    await settle()

    const after = await call(`/admin/shipments?orderId=${orderId}`, { jar: admin })
    const shipment = after.json?.data?.shipments?.[0]
    check('the canonical status is applied', shipment?.status === 'OUT_FOR_DELIVERY', shipment?.status)

    const event = shipment?.events?.find((e) => e.providerEventId === ofdEvent)
    check('the event is recorded with its provider id', Boolean(event))
    check("the carrier's own wording is kept", event?.providerStatus === 'out_for_delivery', event?.providerStatus)
    check('the event is marked as coming from the provider', event?.source === 'provider')
  }

  {
    const replay = await carrierWebhook({
      id: ofdEvent,
      trackingNumber,
      status: 'out_for_delivery',
    })
    check('a redelivered event is a no-op', replay.json?.data?.duplicate === true)
    await settle()

    const after = await call(`/admin/shipments?orderId=${orderId}`, { jar: admin })
    const events = after.json?.data?.shipments?.[0]?.events ?? []
    const matching = events.filter((e) => e.providerEventId === ofdEvent)
    check('and does not duplicate the trail', matching.length === 1, `${matching.length} rows`)
  }

  {
    await carrierWebhook({
      id: `evt-delivered-${Date.now()}`,
      trackingNumber,
      status: 'delivered',
      message: 'Left with the recipient',
    })
    await settle()

    const after = await call(`/admin/shipments?orderId=${orderId}`, { jar: admin })
    const shipment = after.json?.data?.shipments?.[0]
    check('delivery is applied', shipment?.status === 'DELIVERED', shipment?.status)
    check('and the delivery timestamp is set', Boolean(shipment?.deliveredAt))

    const order = await call(`/admin/orders/${orderId}`, { jar: admin })
    check('the order follows its shipments to DELIVERED', order.json?.data?.order?.status === 'DELIVERED', order.json?.data?.order?.status)
  }

  // ── the acceptance criterion the PRD calls out explicitly ──
  {
    const lateEvent = `evt-late-${Date.now()}`
    const r = await carrierWebhook({
      id: lateEvent,
      trackingNumber,
      status: 'in_transit',
      message: 'Scanned at hub (delayed relay)',
    })
    check('an out-of-order event is accepted', r.status === 200)
    await settle()

    const after = await call(`/admin/shipments?orderId=${orderId}`, { jar: admin })
    const shipment = after.json?.data?.shipments?.[0]

    check(
      'a delivered parcel is not walked backwards',
      shipment?.status === 'DELIVERED',
      shipment?.status,
    )

    const event = shipment?.events?.find((e) => e.providerEventId === lateEvent)
    check('the late event is still recorded', Boolean(event))
    check('but flagged as not applied', event?.ignoredForStatus === true)
    check('and the shipment is raised for review', shipment?.needsReview === true, shipment?.reviewReason)
  }

  {
    const cleared = await call(`/admin/shipments/${shipmentId}/reviewed`, { method: 'POST', jar: admin })
    check('an operator can clear the review flag', cleared.json?.data?.shipment?.needsReview === false)
  }
} else {
  console.log('  (skipped — set SHIPPING_WEBHOOK_SECRET to run these)')
}

// ═══════════════════════════ FR-21.6 — split shipments and exception states
section('FR-21.6  Split shipments and customer-safe exception states')

let splitOrderId = null
let splitTracking = `SMOKE-SPLIT-${Date.now()}`
{
  const listing = await call('/products?perPage=12&inStock=true')
  const detail = await call(`/products/${listing.json.data.products[1].slug}`)
  const v = detail.json?.data?.product?.variants?.find((x) => x.stock > 3)

  await call('/cart/items', { method: 'POST', jar: customer, body: { variantId: v.id, quantity: 3 } })

  const addresses = await call('/addresses', { jar: customer })
  const placed = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: {
      addressId: addresses.json.data.addresses[0].id,
      shippingMethodId: metroMethods.find((m) => m.name === 'Standard delivery').id,
      idempotencyKey: `ship-split-${Date.now()}`,
    },
  })
  splitOrderId = placed.json?.data?.order?.id

  await call(`/admin/orders/${splitOrderId}/status`, { method: 'PATCH', jar: admin, body: { status: 'PAID' } })

  const detail2 = await call(`/admin/orders/${splitOrderId}`, { jar: admin })
  const line = detail2.json?.data?.order?.items?.[0]

  const first = await call(`/admin/shipments/orders/${splitOrderId}`, {
    method: 'POST',
    jar: admin,
    body: { items: [{ orderItemId: line.id, quantity: 1 }], carrier: 'dtdc', trackingNumber: splitTracking },
  })
  check('a partial shipment is created', first.status === 201)
  check('a partial despatch does not complete the order', first.json?.data?.fullyShipped === false)

  const order = await call(`/admin/orders/${splitOrderId}`, { jar: admin })
  check('the order moves to PROCESSING instead', order.json?.data?.order?.status === 'PROCESSING', order.json?.data?.order?.status)

  const second = await call(`/admin/shipments/orders/${splitOrderId}`, {
    method: 'POST',
    jar: admin,
    body: { items: [{ orderItemId: line.id, quantity: 2 }], carrier: 'dtdc', trackingNumber: `${splitTracking}-B` },
  })
  check('the remainder ships separately', second.status === 201)
  check('and completes the order', second.json?.data?.fullyShipped === true)

  const tracking = await call(`/tracking/orders/${splitOrderId}`, { jar: customer })
  check('the customer sees both parcels', (tracking.json?.data?.shipments?.length ?? 0) === 2)
}

if (WEBHOOK_SECRET) {
  const r = await carrierWebhook({
    id: `evt-exception-${Date.now()}`,
    trackingNumber: splitTracking,
    status: 'address_issue',
    message: 'Address could not be located',
    location: 'New Delhi',
  })
  check('a carrier exception is accepted', r.status === 200)
  await settle()

  const after = await call(`/admin/shipments?orderId=${splitOrderId}`, { jar: admin })
  const shipment = (after.json?.data?.shipments ?? []).find((s) => s.trackingNumber === splitTracking)

  check('it maps to the EXCEPTION state', shipment?.status === 'EXCEPTION', shipment?.status)
  check('and raises the parcel for review', shipment?.needsReview === true, shipment?.reviewReason)

  const tracking = await call(`/tracking/orders/${splitOrderId}`, { jar: customer })
  const customerView = (tracking.json?.data?.shipments ?? []).find((s) => s.trackingNumber === splitTracking)
  check('the customer sees the exception on their timeline', customerView?.status === 'EXCEPTION')
  check(
    'internal review notes are not exposed to the customer',
    customerView !== undefined && !('reviewReason' in customerView),
  )

  // A parcel can recover from an exception — it is not terminal.
  await carrierWebhook({
    id: `evt-recover-${Date.now()}`,
    trackingNumber: splitTracking,
    status: 'out_for_delivery',
  })
  await settle()

  const recovered = await call(`/admin/shipments?orderId=${splitOrderId}`, { jar: admin })
  const s = (recovered.json?.data?.shipments ?? []).find((x) => x.trackingNumber === splitTracking)
  check('a parcel can recover from an exception', s?.status === 'OUT_FOR_DELIVERY', s?.status)
  check('and the review flag clears', s?.needsReview === false)
}

// ═══════════════════════════════════════════════════════ authorization
section('Authorization')

{
  const routes = [
    ['/admin/shipping/zones', 'shipping zones'],
    ['/admin/shipments', 'shipments'],
  ]
  for (const [path, label] of routes) {
    const r = await call(path, { jar: customer })
    check(`a customer cannot reach admin ${label}`, r.status === 403, `status ${r.status}`)
  }

  const write = await call('/admin/shipping/zones', {
    method: 'POST',
    jar: customer,
    body: { name: 'Nope', countries: ['IN'] },
  })
  check('a customer cannot create a shipping zone', write.status === 403, `status ${write.status}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
