/**
 * STEP 6 verification — guest cart, server-side pricing authority (spec §23),
 * stock limits (spec §22) and guest→user merge (spec §36).
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'

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
  get(name) { return this.cookies.get(name) }
}

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nSTEP 6 — cart\n')

// Pick a real product/variant from the catalogue.
const listing = await call('/products?perPage=3&inStock=true')
const slug = listing.json?.data?.products?.[0]?.slug
const detail = await call(`/products/${slug}`)
const product = detail.json?.data?.product
const variant = product.variants.find((v) => v.stock > 2)

check('catalogue provides a purchasable variant', Boolean(variant), `${product?.name} / ${variant?.name} (${variant?.stock} in stock)`)

// ------------------------------------------------------------- guest cart
const guest = new Jar()
{
  const r = await call('/cart', { jar: guest })
  check('guest gets an empty cart', r.status === 200 && r.json?.data?.cart?.itemCount === 0)
  check('cart token cookie is issued', Boolean(guest.get('cart_token')))
}

{
  const r = await call('/cart/items', { method: 'POST', jar: guest, body: { variantId: variant.id, quantity: 2 } })
  const cart = r.json?.data?.cart
  check('guest can add to cart without signing in', r.status === 200 && cart?.itemCount === 2, `status ${r.status}`)
  check(
    'server prices the line from the database',
    cart?.items?.[0]?.unitPrice === variant.price && cart?.subtotal === variant.price * 2,
    `unit ${cart?.items?.[0]?.unitPrice} subtotal ${cart?.subtotal}`,
  )
}

// The client must not be able to dictate price — the API accepts no such field.
{
  const r = await call('/cart/items', {
    method: 'POST',
    jar: guest,
    body: { variantId: variant.id, quantity: 1, price: 1, unitPrice: 1, lineTotal: 1 },
  })
  const cart = r.json?.data?.cart
  check(
    'injected price fields are ignored',
    cart?.items?.[0]?.unitPrice === variant.price,
    `unit price still ${cart?.items?.[0]?.unitPrice}`,
  )
  check('quantities accumulate for the same variant', cart?.items?.length === 1 && cart?.items?.[0]?.quantity === 3)
}

// Per-line quantity cap is a validation rule, checked before stock.
{
  const r = await call('/cart/items', { method: 'POST', jar: guest, body: { variantId: variant.id, quantity: 999 } })
  check('per-line quantity cap is enforced', r.status === 422 && r.json?.error?.code === 'VALIDATION_ERROR', `${r.status}`)
}

// Stock ceiling — needs a variant whose stock sits below the per-line cap,
// otherwise the cap fires first and the stock rule is never exercised.
{
  const all = await call('/products?perPage=48')
  let lowVariant = null
  for (const p of all.json.data.products) {
    const d = await call(`/products/${p.slug}`)
    const found = d.json.data.product.variants.find((v) => v.stock > 0 && v.stock < 20)
    if (found) { lowVariant = found; break }
  }

  if (!lowVariant) {
    check('found a low-stock variant to test the ceiling', false, 'none in the catalogue')
  } else {
    const jar = new Jar()
    await call('/cart', { jar })
    const r = await call('/cart/items', {
      method: 'POST',
      jar,
      body: { variantId: lowVariant.id, quantity: lowVariant.stock + 1 },
    })
    check(
      'cannot add more than available stock',
      r.status === 409 && r.json?.error?.code === 'INSUFFICIENT_STOCK',
      `asked for ${lowVariant.stock + 1} of ${lowVariant.stock} -> ${r.status}`,
    )

    const okAdd = await call('/cart/items', { method: 'POST', jar, body: { variantId: lowVariant.id, quantity: lowVariant.stock } })
    check('can add exactly the available stock', okAdd.status === 200, `${okAdd.status}`)

    const itemId = okAdd.json.data.cart.items[0].id
    const over = await call(`/cart/items/${itemId}`, { method: 'PATCH', jar, body: { quantity: lowVariant.stock + 1 } })
    check('quantity update respects stock', over.status === 409, `${over.status}`)

    await call('/cart', { method: 'DELETE', jar })
  }
}

// Quantity update + removal on the main guest cart.
{
  const cartRes = await call('/cart', { jar: guest })
  const itemId = cartRes.json.data.cart.items[0].id

  const up = await call(`/cart/items/${itemId}`, { method: 'PATCH', jar: guest, body: { quantity: 1 } })
  check('quantity can be reduced', up.json?.data?.cart?.items?.[0]?.quantity === 1)
}

// Another guest must not be able to touch this cart.
{
  const cartRes = await call('/cart', { jar: guest })
  const itemId = cartRes.json.data.cart.items[0].id

  const stranger = new Jar()
  await call('/cart', { jar: stranger })
  const r = await call(`/cart/items/${itemId}`, { method: 'DELETE', jar: stranger })
  check("a stranger cannot delete another cart's item", r.status === 404, `${r.status}`)
}

// ------------------------------------------------------------------ merge
{
  // Guest cart holds 1 unit; sign in and it should fold into the user's cart.
  const before = await call('/cart', { jar: guest })
  const guestQty = before.json.data.cart.itemCount
  check('guest cart has items before signing in', guestQty > 0, `${guestQty} items`)

  const login = await call('/auth/login', {
    method: 'POST',
    jar: guest,
    body: { email: 'customer@example.com', password: 'Customer@12345' },
  })
  check('customer signs in', login.status === 200)

  const after = await call('/cart', { jar: guest })
  const merged = after.json?.data?.cart
  check('guest cart merged into the user cart', merged?.itemCount >= guestQty, `${merged?.itemCount} items after login`)
  check('merged cart is priced from the database', merged?.subtotal === merged?.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0))
}

// Cart survives a new session for the same user.
{
  const returning = new Jar()
  await call('/auth/login', {
    method: 'POST',
    jar: returning,
    body: { email: 'customer@example.com', password: 'Customer@12345' },
  })
  const r = await call('/cart', { jar: returning })
  check('signed-in cart persists across sessions', r.json?.data?.cart?.itemCount > 0, `${r.json?.data?.cart?.itemCount} items`)

  // Clean up so later runs start fresh.
  await call('/cart', { method: 'DELETE', jar: returning })
  const emptied = await call('/cart', { jar: returning })
  check('cart can be emptied', emptied.json?.data?.cart?.itemCount === 0)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
