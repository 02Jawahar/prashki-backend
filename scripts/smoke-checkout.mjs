/**
 * STEP 7 + 8 verification — the login-before-purchase rule (spec §21), order
 * creation as a transaction (spec §25, §50), price snapshots (spec §26) and the
 * inventory rule from spec §40.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'

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

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nSTEP 7 + 8 — checkout and orders\n')

// ------------------------------------------------- login required to buy
{
  const guest = new Jar()
  await call('/cart', { jar: guest })
  const r = await call('/orders', { method: 'POST', jar: guest, body: { addressId: 'anything' } })
  check('a guest cannot create an order', r.status === 401, `${r.status} ${r.json?.error?.code}`)

  const list = await call('/orders', { jar: guest })
  check('a guest cannot list orders', list.status === 401, `${list.status}`)

  const addr = await call('/addresses', { jar: guest })
  check('a guest cannot read addresses', addr.status === 401, `${addr.status}`)
}

// ------------------------------------------------------------- customer
const jar = new Jar()
await call('/auth/login', { method: 'POST', jar, body: { email: 'customer@example.com', password: 'Customer@12345' } })

// Pick a variant and record its stock before we buy.
const listing = await call('/products?perPage=12&inStock=true')
let target = null
for (const p of listing.json.data.products) {
  const d = await call(`/products/${p.slug}`)
  const v = d.json.data.product.variants.find((x) => x.stock >= 3)
  if (v) { target = { product: d.json.data.product, variant: v }; break }
}
check('found a variant with stock to buy', Boolean(target), `${target?.product?.name} / ${target?.variant?.name} (${target?.variant?.stock})`)

const stockBefore = target.variant.stock
const BUY = 2

// Fresh cart with a known quantity.
await call('/cart', { method: 'DELETE', jar })
await call('/cart/items', { method: 'POST', jar, body: { variantId: target.variant.id, quantity: BUY } })

// Address.
let addressId
{
  const existing = await call('/addresses', { jar })
  addressId = existing.json?.data?.addresses?.[0]?.id

  if (!addressId) {
    const r = await call('/addresses', {
      method: 'POST', jar,
      body: {
        name: 'Aditi Rao', phone: '+919810000000', addressLine1: '14 Sunder Nagar',
        city: 'New Delhi', state: 'Delhi', postalCode: '110003', country: 'IN', isDefault: true,
      },
    })
    check('customer can save an address', r.status === 201, `${r.status}`)
    addressId = r.json?.data?.address?.id
  } else {
    check('customer has a saved address', true, addressId.slice(0, 8))
  }

  const bad = await call('/addresses', { method: 'POST', jar, body: { name: 'x', postalCode: 'abc' } })
  check('address input is validated', bad.status === 422, `${bad.status}`)
}

// Another customer's address must not be usable.
{
  const other = new Jar()
  const email = `buyer_${Date.now()}@example.com`
  await call('/auth/register', { method: 'POST', jar: other, body: { name: 'Other Buyer', email, password: 'Password@123' } })
  const r = await call('/orders', { method: 'POST', jar: other, body: { addressId } })
  check("cannot order to another customer's address", r.status === 404 || r.status === 422, `${r.status} ${r.json?.error?.code}`)
}

// -------------------------------------------------------- create order
let order
{
  const r = await call('/orders', { method: 'POST', jar, body: { addressId, notes: 'Smoke test order' } })
  order = r.json?.data?.order
  check('customer can place an order', r.status === 201, `status ${r.status} ${JSON.stringify(r.json?.error ?? '')}`)
  check('order number is generated', /^ORD-\d{4}-\d{5}$/.test(order?.orderNumber ?? ''), order?.orderNumber)
  check('order starts as PENDING_PAYMENT', order?.status === 'PENDING_PAYMENT')

  const line = order?.items?.[0]
  check('line total is priced from the database', line?.unitPrice === target.variant.price && line?.lineTotal === target.variant.price * BUY, `${line?.unitPrice} × ${line?.quantity}`)
  check('order totals add up', order?.subtotal === line?.lineTotal && order?.total === order?.subtotal + order?.shipping + order?.tax - order?.discount)

  check('product name is snapshotted onto the line', line?.productNameSnapshot === target.product.name, line?.productNameSnapshot)
  check('sku is snapshotted onto the line', line?.sku === target.variant.sku)
  check('shipping address is snapshotted', Boolean(order?.shippingAddressSnapshot?.postalCode))
  check('status history recorded', order?.statusHistory?.length >= 1)
  check('payment record created', order?.payments?.length === 1 && order.payments[0].status === 'CREATED')
}

// --------------------------------------------------- inventory decrement
{
  const d = await call(`/products/${target.product.slug}`)
  const after = d.json.data.product.variants.find((v) => v.id === target.variant.id)
  check(
    `stock fell by exactly ${BUY}`,
    after.stock === stockBefore - BUY,
    `${stockBefore} → ${after.stock}`,
  )
}

// Cart must be emptied by a successful order.
{
  const c = await call('/cart', { jar })
  check('cart is cleared after ordering', c.json?.data?.cart?.itemCount === 0)
}

// ------------------------------------------------------- order visibility
{
  const list = await call('/orders', { jar })
  check('customer sees their order', list.json?.data?.orders?.some((o) => o.id === order.id))

  const detail = await call(`/orders/${order.id}`, { jar })
  check('customer can open their order', detail.status === 200 && detail.json?.data?.order?.orderNumber === order.orderNumber)

  // Someone else's order must not be readable.
  const other = new Jar()
  await call('/auth/register', { method: 'POST', jar: other, body: { name: 'Nosy', email: `nosy_${Date.now()}@example.com`, password: 'Password@123' } })
  const nosy = await call(`/orders/${order.id}`, { jar: other })
  check("another customer cannot read someone else's order", nosy.status === 404, `${nosy.status}`)
}

// ----------------------------------------------------- admin order admin
{
  const admin = new Jar()
  await call('/auth/login', { method: 'POST', jar: admin, body: { email: 'admin@example.com', password: 'Admin@12345' } })

  const list = await call('/admin/orders', { jar: admin })
  check('admin sees the order', list.status === 200 && list.json?.data?.orders?.some((o) => o.id === order.id), `${list.json?.data?.orders?.length} orders`)

  const detail = await call(`/admin/orders/${order.id}`, { jar: admin })
  check('admin can open the order with customer details', detail.status === 200 && Boolean(detail.json?.data?.order?.user?.email))

  // Customers must not reach admin order routes.
  const forbidden = await call('/admin/orders', { jar })
  check('a customer cannot use admin order routes', forbidden.status === 403, `${forbidden.status}`)

  // Valid transition.
  const paid = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'PAID', note: 'Marked paid by smoke test' } })
  check('admin can advance the status', paid.status === 200 && paid.json?.data?.order?.status === 'PAID', `${paid.status}`)
  check('status history grows', paid.json?.data?.order?.statusHistory?.length >= 2)

  // Illegal transition.
  const illegal = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'PENDING_PAYMENT' } })
  check('illegal status transitions are rejected', illegal.status === 409 && illegal.json?.error?.code === 'INVALID_STATUS_TRANSITION', `${illegal.status}`)

  // Cancelling restores stock.
  const cancelled = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'CANCELLED', note: 'Smoke test cleanup' } })
  check('admin can cancel', cancelled.status === 200 && cancelled.json?.data?.order?.status === 'CANCELLED')

  const d = await call(`/products/${target.product.slug}`)
  const restored = d.json.data.product.variants.find((v) => v.id === target.variant.id)
  check('cancelling restores the stock', restored.stock === stockBefore, `back to ${restored.stock}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
