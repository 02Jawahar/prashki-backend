/**
 * STEP 4 verification — the admin product workflow from spec §38, plus the
 * authorization boundary from spec §5.
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
}

async function call(path, { method = 'GET', body, jar, raw } = {}) {
  const headers = { accept: 'application/json' }
  if (body && !raw) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nSTEP 4 — admin catalogue\n')

// ------------------------------------------------------- authorization wall
{
  const r = await call('/admin/stats')
  check('admin API rejects anonymous', r.status === 401, `${r.status} ${r.json?.error?.code}`)
}

const customerJar = new Jar()
await call('/auth/login', { method: 'POST', jar: customerJar, body: { email: 'customer@example.com', password: 'Customer@12345' } })
{
  const r = await call('/admin/stats', { jar: customerJar })
  check('admin API rejects a logged-in customer', r.status === 403, `${r.status} ${r.json?.error?.code}`)

  const w = await call('/admin/products', { method: 'POST', jar: customerJar, body: { name: 'Hack', description: 'x', sku: 'HACK-1', price: 100 } })
  check('customer cannot create products', w.status === 403, `${w.status}`)
}

const adminJar = new Jar()
await call('/auth/login', { method: 'POST', jar: adminJar, body: { email: 'admin@example.com', password: 'Admin@12345' } })

// ------------------------------------------------------------------ dashboard
{
  const r = await call('/admin/stats', { jar: adminJar })
  const d = r.json?.data
  check('dashboard returns real counts', r.status === 200 && d?.totalProducts === 17, `${d?.totalProducts} products`)
  check('dashboard counts customers', typeof d?.totalCustomers === 'number' && d.totalCustomers >= 1, `${d?.totalCustomers} customers`)
  check('dashboard revenue starts at zero', d?.totalRevenue === 0, `${d?.totalRevenue}`)
  check('dashboard reports low stock', Array.isArray(d?.lowStockItems), `${d?.lowStockCount} low`)
}

// ------------------------------------------------------- create -> publish
let productId, variantId, slug
{
  const sku = `TEST-${Date.now().toString(36).toUpperCase()}`
  const r = await call('/admin/products', {
    method: 'POST',
    jar: adminJar,
    body: {
      name: 'Smoke Test Linen Dress',
      description: 'A test product created by the STEP 4 smoke run.',
      shortDescription: 'Washed linen',
      sku,
      price: 1250000,
      compareAtPrice: 1500000,
      status: 'DRAFT',
      featured: false,
      variants: [
        { name: 'S', sku: `${sku}-S`, stock: 10 },
        { name: 'M', sku: `${sku}-M`, stock: 0 },
      ],
    },
  })
  check('admin can create a product', r.status === 201, `status ${r.status} ${JSON.stringify(r.json?.error ?? '')}`)
  productId = r.json?.data?.product?.id
  slug = r.json?.data?.product?.slug
  variantId = r.json?.data?.product?.variants?.[0]?.id
  check('slug is generated', slug === 'smoke-test-linen-dress', slug)
  check('discount is derived from prices', r.json?.data?.product?.discountPercent === 17, `${r.json?.data?.product?.discountPercent}%`)
  check('variants and stock created', r.json?.data?.product?.variants?.length === 2 && r.json?.data?.product?.totalStock === 10)
}

// A DRAFT product must not be visible on the storefront.
{
  const r = await call(`/products/${slug}`)
  check('draft product is hidden from the storefront', r.status === 404, `${r.status}`)
}

{
  const r = await call(`/admin/products/${productId}/status`, { method: 'PATCH', jar: adminJar, body: { status: 'ACTIVE' } })
  check('admin can publish', r.status === 200 && r.json?.data?.product?.status === 'ACTIVE')
}

// ...and once published it must appear (spec §38).
{
  const r = await call(`/products/${slug}`)
  check('published product appears on the storefront', r.status === 200 && r.json?.data?.product?.slug === slug)
  check('storefront hides inactive variants only', r.json?.data?.product?.variants?.length === 2)
}

// -------------------------------------------------------- price update flow
{
  const r = await call(`/admin/products/${productId}`, { method: 'PATCH', jar: adminJar, body: { price: 1000000 } })
  check('admin can change price', r.status === 200 && r.json?.data?.product?.price === 1000000)
  check('discount recomputes from the new price', r.json?.data?.product?.discountPercent === 33, `${r.json?.data?.product?.discountPercent}%`)

  const store = await call(`/products/${slug}`)
  check('storefront reflects the new price immediately', store.json?.data?.product?.price === 1000000)
}

// compare-at must stay above price
{
  const r = await call(`/admin/products/${productId}`, { method: 'PATCH', jar: adminJar, body: { price: 2000000 } })
  check('rejects price above compare-at price', r.status === 422, `${r.status} ${r.json?.error?.code}`)
}

// -------------------------------------------------------------- inventory
{
  const r = await call(`/admin/products/variants/${variantId}/stock`, {
    method: 'POST', jar: adminJar, body: { mode: 'set', stock: 100, reason: 'Smoke test' },
  })
  check('admin can set stock to 100', r.status === 200 && r.json?.data?.availableStock === 100, `${r.json?.data?.availableStock}`)

  const hist = await call(`/admin/inventory/${variantId}/movements`, { jar: adminJar })
  check('stock change is recorded as a movement', hist.json?.data?.movements?.length >= 2, `${hist.json?.data?.movements?.length} movements`)
  const sum = (hist.json?.data?.movements ?? []).reduce((n, m) => n + m.quantity, 0)
  check('movement ledger sums to the balance', sum === 100, `ledger ${sum}`)

  const neg = await call(`/admin/products/variants/${variantId}/stock`, {
    method: 'POST', jar: adminJar, body: { mode: 'delta', quantity: -500, type: 'DAMAGE' },
  })
  check('stock cannot go negative', neg.status === 409 && neg.json?.error?.code === 'INSUFFICIENT_STOCK', `${neg.status}`)
}

// ------------------------------------------------------------- validation
{
  const r = await call('/admin/products', { method: 'POST', jar: adminJar, body: { name: 'x', price: -5 } })
  check('product creation validates input', r.status === 422 && r.json?.error?.code === 'VALIDATION_ERROR')

  const dup = await call('/admin/products', {
    method: 'POST', jar: adminJar,
    body: { name: 'Dup', description: 'd', sku: 'PK-MARTIE', price: 100 },
  })
  check('duplicate SKU is rejected', dup.status === 409, `${dup.status} ${dup.json?.error?.code}`)
}

// ------------------------------------------------------------- categories
{
  const r = await call('/admin/categories', { jar: adminJar })
  check('admin can list categories', r.status === 200 && r.json?.data?.categories?.length === 6, `${r.json?.data?.categories?.length}`)

  const withProducts = r.json?.data?.categories?.find((c) => c.productCount > 0)
  const del = await call(`/admin/categories/${withProducts.id}`, { method: 'DELETE', jar: adminJar })
  check('cannot delete a category still in use', del.status === 409 && del.json?.error?.code === 'CATEGORY_IN_USE')
}

// ---------------------------------------------------------------- cleanup
{
  const r = await call(`/admin/products/${productId}`, { method: 'DELETE', jar: adminJar })
  check('admin can delete an unsold product', r.status === 200 && r.json?.data?.deleted === true)

  const gone = await call(`/products/${slug}`)
  check('deleted product is gone from the storefront', gone.status === 404)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
