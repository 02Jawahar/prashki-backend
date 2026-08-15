/**
 * The acceptance test from spec §71.
 *
 * One continuous run through the whole business flow:
 *
 *   admin creates a product -> publishes it
 *   customer browses -> adds to cart -> is stopped at checkout without a login
 *   registers -> guest cart survives -> orders
 *   pays (server-verified) -> admin sees and fulfils the order
 *   inventory moves 10 -> 8
 *
 * Everything runs against the real API and the real database.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))
const SECRET = process.env.JWT_ACCESS_SECRET
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }

let passed = 0
let failed = 0
const step = (n) => console.log(`\n── ${n}`)
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`   PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`   FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
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

async function call(path, { method = 'GET', body, jar, rawBody, headers: extra } = {}) {
  const headers = { accept: 'application/json', ...extra }
  if (body || rawBody) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

const sign = (a, b) => crypto.createHmac('sha256', SECRET).update(`${a}|${b}`).digest('hex')

console.log('\n════ ACCEPTANCE TEST (spec §71) ════')

const stamp = Date.now().toString(36).toUpperCase()
const SKU = `ACC-${stamp}`
const INITIAL_STOCK = 10
const BUY = 2

// ─────────────────────────────────────────────────────────── ADMIN
step('ADMIN — sign in, create a product, set stock, publish')

const admin = new Jar()
{
  const r = await call('/auth/login', { method: 'POST', jar: admin, body: ADMIN })
  check('admin signs in', r.status === 200 && r.json?.data?.user?.role === 'ADMIN', `${r.status}`)
}

const categories = await call('/admin/categories', { jar: admin })
const categoryId = categories.json.data.categories.find((c) => c.parent)?.id

let product
{
  const r = await call('/admin/products', {
    method: 'POST', jar: admin,
    body: {
      name: `Acceptance Linen Dress ${stamp}`,
      description: 'Created by the acceptance test to prove the admin-to-customer flow works.',
      shortDescription: 'Washed linen',
      sku: SKU,
      price: 1299900,
      compareAtPrice: 1599900,
      categoryId,
      status: 'DRAFT',
      variants: [{ name: 'M', sku: `${SKU}-M`, stock: INITIAL_STOCK }],
    },
  })
  product = r.json?.data?.product
  check('admin creates the product', r.status === 201, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)
  check('price stored as paise', product?.price === 1299900)
  check('discount derived from prices', product?.discountPercent === 19, `${product?.discountPercent}%`)
  check(`opening stock is ${INITIAL_STOCK}`, product?.totalStock === INITIAL_STOCK, `${product?.totalStock}`)
}

{
  const hidden = await call(`/products/${product.slug}`)
  check('a draft product is invisible on the storefront', hidden.status === 404)

  const r = await call(`/admin/products/${product.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'ACTIVE' } })
  check('admin publishes it', r.status === 200 && r.json?.data?.product?.status === 'ACTIVE')
}

// ──────────────────────────────────────────────────────── CUSTOMER
step('CUSTOMER — browse, open the product, add to bag as a guest')

const shopper = new Jar()
{
  const listing = await call('/products?perPage=48')
  check('the new product appears in the catalogue', listing.json.data.products.some((p) => p.slug === product.slug))

  const detail = await call(`/products/${product.slug}`)
  check('customer can open the product without signing in', detail.status === 200)
  check('storefront shows the derived discount', detail.json?.data?.product?.discountPercent === 19)
}

const variantId = product.variants[0].id
{
  await call('/cart', { jar: shopper })
  const r = await call('/cart/items', { method: 'POST', jar: shopper, body: { variantId, quantity: BUY } })
  check('guest adds to bag', r.status === 200 && r.json?.data?.cart?.itemCount === BUY)
  check('bag is priced by the server', r.json?.data?.cart?.subtotal === 1299900 * BUY, `${r.json?.data?.cart?.subtotal}`)
}

step('CUSTOMER — checkout is refused until signed in')
{
  const r = await call('/orders', { method: 'POST', jar: shopper, body: { addressId: 'x' } })
  check('guest cannot create an order', r.status === 401, `${r.status}`)
}

step('CUSTOMER — register, then the guest bag survives')
{
  const email = `acceptance_${stamp.toLowerCase()}@example.com`
  const r = await call('/auth/register', {
    method: 'POST', jar: shopper,
    body: { name: 'Acceptance Buyer', email, password: 'Password@123', phone: '+919810000123' },
  })
  check('customer registers', r.status === 201 && r.json?.data?.user?.role === 'CUSTOMER', `${r.status}`)

  const cart = await call('/cart', { jar: shopper })
  check('the guest bag merged into the account', cart.json?.data?.cart?.itemCount === BUY, `${cart.json?.data?.cart?.itemCount} items`)
}

step('CUSTOMER — add an address and place the order')
let order
{
  const addr = await call('/addresses', {
    method: 'POST', jar: shopper,
    body: {
      name: 'Acceptance Buyer', phone: '+919810000123', addressLine1: '22 Test Lane',
      city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', country: 'IN', isDefault: true,
    },
  })
  check('address saved', addr.status === 201, `${addr.status}`)

  const r = await call('/orders', { method: 'POST', jar: shopper, body: { addressId: addr.json.data.address.id } })
  order = r.json?.data?.order
  check('order created', r.status === 201, `${order?.orderNumber}`)
  check('order is PENDING_PAYMENT', order?.status === 'PENDING_PAYMENT')
  check('line price snapshotted from the database', order?.items?.[0]?.unitPrice === 1299900)
  check('product name snapshotted', order?.items?.[0]?.productNameSnapshot === product.name)
  check('bag emptied by the order', (await call('/cart', { jar: shopper })).json.data.cart.itemCount === 0)
}

step(`INVENTORY — ${INITIAL_STOCK} minus ${BUY}`)
{
  const d = await call(`/products/${product.slug}`)
  const stock = d.json.data.product.variants.find((v) => v.id === variantId).stock
  check(`stock is now ${INITIAL_STOCK - BUY}`, stock === INITIAL_STOCK - BUY, `${INITIAL_STOCK} → ${stock}`)
}

step('PAYMENT — created server-side, then verified server-side')
{
  const intent = await call('/payments/create', { method: 'POST', jar: shopper, body: { orderId: order.id } })
  check('payment intent created', intent.status === 200)
  check('amount taken from the order', intent.json?.data?.amount === order.total)

  const forged = await call('/payments/verify', {
    method: 'POST', jar: shopper,
    body: { orderId: order.id, providerOrderId: intent.json.data.providerOrderId, providerPaymentId: 'pay_x', signature: 'forged' },
  })
  check('a forged signature cannot pay for the order', forged.status === 402)
  check('order still unpaid after the forgery', (await call(`/orders/${order.id}`, { jar: shopper })).json.data.order.status === 'PENDING_PAYMENT')

  const paymentId = `pay_${crypto.randomBytes(6).toString('hex')}`
  const verified = await call('/payments/verify', {
    method: 'POST', jar: shopper,
    body: {
      orderId: order.id,
      providerOrderId: intent.json.data.providerOrderId,
      providerPaymentId: paymentId,
      signature: sign(intent.json.data.providerOrderId, paymentId),
    },
  })
  check('a valid signature marks the order paid', verified.status === 200 && verified.json?.data?.status === 'PAID')
}

step('CUSTOMER — sees the order in their account')
{
  const list = await call('/orders', { jar: shopper })
  check('order listed in the account', list.json?.data?.orders?.some((o) => o.id === order.id))

  const detail = await call(`/orders/${order.id}`, { jar: shopper })
  check('order detail shows items, address and payment',
    detail.json?.data?.order?.items?.length === 1 &&
    Boolean(detail.json?.data?.order?.shippingAddressSnapshot?.postalCode) &&
    detail.json?.data?.order?.payments?.[0]?.status === 'CAPTURED')
}

step('ADMIN — sees the order and fulfils it')
{
  const list = await call('/admin/orders', { jar: admin })
  check('admin sees the new order', list.json?.data?.orders?.some((o) => o.id === order.id))

  const detail = await call(`/admin/orders/${order.id}`, { jar: admin })
  check('admin sees the customer', Boolean(detail.json?.data?.order?.user?.email))
  check('admin sees the products and total', detail.json?.data?.order?.items?.length === 1 && detail.json?.data?.order?.total === order.total)

  const processing = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'PROCESSING' } })
  check('admin moves it to PROCESSING', processing.json?.data?.order?.status === 'PROCESSING')

  const shipped = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'SHIPPED', note: 'Handed to courier' } })
  check('admin marks it SHIPPED', shipped.json?.data?.order?.status === 'SHIPPED')

  const delivered = await call(`/admin/orders/${order.id}/status`, { method: 'PATCH', jar: admin, body: { status: 'DELIVERED' } })
  check('admin marks it DELIVERED', delivered.json?.data?.order?.status === 'DELIVERED')
  check('every transition is in the history', delivered.json?.data?.order?.statusHistory?.length >= 5, `${delivered.json?.data?.order?.statusHistory?.length} entries`)
}

step('ADMIN — dashboard reflects the sale')
{
  const stats = await call('/admin/stats', { jar: admin })
  check('revenue counts the paid order', stats.json?.data?.totalRevenue >= order.total, `₹${(stats.json?.data?.totalRevenue ?? 0) / 100}`)
  check('order count includes it', stats.json?.data?.totalOrders >= 1)
}

// Leave the catalogue as we found it.
step('CLEANUP')
{
  const r = await call(`/admin/products/${product.id}`, { method: 'DELETE', jar: admin })
  check('test product removed or archived', r.status === 200, r.json?.data?.archived ? 'archived (has orders)' : 'deleted')
}

console.log(`\n════ ${passed} passed, ${failed} failed ════\n`)
process.exit(failed === 0 ? 0 : 1)
