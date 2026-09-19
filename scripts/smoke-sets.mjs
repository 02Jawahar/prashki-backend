/**
 * Sets — a product assembled from other products (M03).
 *
 * The thing worth testing here is the money. A set is sold for less than its
 * pieces cost separately, that discount is shared across the lines, and every
 * figure downstream — the bag, the order, a refund, a partial return — is
 * computed from those lines. A rupee lost in the split is a rupee wrong
 * everywhere, and it would not show up until someone reconciled an order.
 *
 *   node scripts/smoke-sets.mjs
 *   node scripts/smoke-sets.mjs --base https://api.example.com/api/v1
 */
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
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
}
const CUSTOMER = {
  email: process.env.CUSTOMER_EMAIL ?? 'customer@example.com',
  password: process.env.CUSTOMER_PASSWORD ?? 'Customer@12345',
}

let passed = 0
let failed = 0

function section(title, note) {
  console.log(`\n${title}${note ? `  ${note}` : ''}`)
}
function check(label, ok, detail) {
  if (ok) {
    passed++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- http

function jar() {
  return { cookies: new Map(), csrf: null }
}

function absorb(j, res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.split('=')
    j.cookies.set(name.trim(), rest.join('='))
  }
  if (j.cookies.has('csrf')) j.csrf = j.cookies.get('csrf')
}

async function call(pathname, { method = 'GET', body, jar: j } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (j?.cookies.size) headers.cookie = [...j.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  if (j?.csrf) headers['x-csrf-token'] = j.csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (j) absorb(j, res)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  return { status: res.status, json }
}

async function signIn(who) {
  const j = jar()
  await call('/', { jar: j })
  const r = await call('/auth/login', { method: 'POST', body: who, jar: j })
  if (r.status !== 200) {
    console.error(`\n  Could not sign in as ${who.email} (${r.status})\n`)
    process.exit(1)
  }
  return j
}

console.log(`\n  target ${BASE}`)

const admin = await signIn(ADMIN)
const customer = await signIn(CUSTOMER)

// ---------------------------------------------------------------- fixtures

/** Three real products to assemble into a set, and one to use as a stranger. */
const listing = await call('/admin/products?perPage=8&status=ACTIVE', { jar: admin })
const pool = (listing.json?.data?.products ?? []).filter((p) => p.slug?.startsWith('look-'))
if (pool.length < 4) {
  console.error('\n  Need at least four active products to test with.\n')
  process.exit(1)
}

const [a, b, c, stranger] = pool
const pieceIds = [a.id, b.id, c.id]

// The set itself: an ordinary product, priced below the sum of its pieces.
const piecesTotal = a.price + b.price + c.price
const setPrice = Math.round(piecesTotal * 0.85 * 0.01) * 100 // whole rupees, 15% off

const made = await call('/admin/products', {
  method: 'POST',
  jar: admin,
  body: {
    name: `Smoke Set ${Date.now()}`,
    slug: `smoke-set-${Date.now()}`,
    description: 'Assembled by the smoke test.',
    sku: `SMOKE-SET-${Date.now()}`,
    price: setPrice,
    status: 'ACTIVE',
  },
})
if (made.status !== 201) {
  console.error(`\n  Could not create the set product (${made.status}) ${made.json?.error?.message ?? ''}\n`)
  process.exit(1)
}
const setId = made.json.data.product.id
const setSlug = made.json.data.product.slug

// ══════════════════════════════════════════════ assembling
section('Assembling', 'What a set may be made of')

{
  const tooFew = await call(`/admin/products/${setId}/components`, {
    method: 'PUT', jar: admin, body: { componentProductIds: [a.id] },
  })
  check('a set needs more than one piece', tooFew.status === 422, `status ${tooFew.status}`)

  const dupes = await call(`/admin/products/${setId}/components`, {
    method: 'PUT', jar: admin, body: { componentProductIds: [a.id, a.id] },
  })
  check('the same piece cannot be in it twice', dupes.status === 422, `status ${dupes.status}`)

  const itself = await call(`/admin/products/${setId}/components`, {
    method: 'PUT', jar: admin, body: { componentProductIds: [a.id, setId] },
  })
  check('a set cannot contain itself', itself.status === 422, `status ${itself.status}`)

  const ok = await call(`/admin/products/${setId}/components`, {
    method: 'PUT', jar: admin, body: { componentProductIds: pieceIds },
  })
  check('a valid line-up saves', ok.status === 200, `status ${ok.status}`)

  const nested = await call(`/admin/products/${stranger.id}/components`, {
    method: 'PUT', jar: admin, body: { componentProductIds: [setId, a.id] },
  })
  check('a set cannot contain another set', nested.status === 422, `status ${nested.status}`)

  const asCustomer = await call(`/admin/products/${setId}/components`, {
    method: 'PUT', jar: customer, body: { componentProductIds: pieceIds },
  })
  check('a customer cannot assemble one', asCustomer.status === 403, `status ${asCustomer.status}`)
}

// ══════════════════════════════════════════════ the page
section('The page', 'What a shopper is shown')

let pieces = []
{
  const detail = await call(`/products/${setSlug}`)
  check('the set is on the storefront', detail.status === 200, `status ${detail.status}`)

  const set = detail.json?.data?.product?.set
  check('it reports itself as a set', Boolean(set))
  pieces = set?.pieces ?? []
  check('every piece is listed', pieces.length === 3, `${pieces.length} pieces`)
  check('each piece brings its own sizes', pieces.every((p) => Array.isArray(p.sizes)))
  check('the pieces keep their own order', pieces[0]?.productId === a.id)
  check(
    'what the pieces cost separately is shown',
    set?.piecesTotal === piecesTotal,
    `${set?.piecesTotal} vs ${piecesTotal}`,
  )
  check('the set is cheaper than its pieces', setPrice < piecesTotal)

  const single = await call(`/products/${a.slug}`)
  check('a single garment reports no set', single.json?.data?.product?.set === null)
}

// ══════════════════════════════════════════════ buying
section('Buying', 'One request, a line per piece')

const chosen = pieces.map((piece) => ({
  productId: piece.productId,
  variantId: piece.sizes.find((s) => s.inStock)?.id ?? piece.sizes[0]?.id,
}))

{
  const missing = await call('/cart/sets', {
    method: 'POST', jar: customer,
    body: { setProductId: setId, pieces: chosen.slice(0, 2) },
  })
  check('a set with a piece unchosen is refused', missing.status === 422, `status ${missing.status}`)

  // The interesting one: a size that belongs to a different garment would let
  // someone pay a blouse's share for a lehenga.
  const swapped = await call('/cart/sets', {
    method: 'POST', jar: customer,
    body: {
      setProductId: setId,
      pieces: [
        { productId: chosen[0].productId, variantId: chosen[1].variantId },
        chosen[1],
        chosen[2],
      ],
    },
  })
  check("another piece's size is refused", swapped.status === 422, `status ${swapped.status}`)

  const added = await call('/cart/sets', {
    method: 'POST', jar: customer, body: { setProductId: setId, pieces: chosen },
  })
  check('a complete set goes in the bag', added.status === 200, `status ${added.status}`)

  const cart = added.json?.data?.cart
  const lines = (cart?.items ?? []).filter((i) => i.setGroupId)
  check('one line per piece', lines.length === 3, `${lines.length} lines`)
  check('the lines share a group', new Set(lines.map((l) => l.setGroupId)).size === 1)
  check('the group is named after the set', lines.every((l) => l.setName))

  // The money.
  const setTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0)
  check(
    'the lines sum to exactly the set price',
    setTotal === setPrice,
    `${setTotal} vs ${setPrice}`,
  )
  check(
    'no line is priced at the garment alone',
    lines.every((l) => l.unitPrice !== pieces.find((p) => p.productId === l.productId)?.price),
  )

  const standalone = await call('/cart/items', {
    method: 'POST', jar: customer, body: { variantId: chosen[0].variantId, quantity: 1 },
  })
  check('the same piece can also be bought alone', standalone.status === 200, `status ${standalone.status}`)

  const both = standalone.json?.data?.cart?.items ?? []
  const sameVariant = both.filter((i) => i.variantId === chosen[0].variantId)
  check(
    'it becomes its own line, not more quantity',
    sameVariant.length === 2,
    `${sameVariant.length} lines`,
  )
  check(
    'and at its own price, not the set share',
    new Set(sameVariant.map((i) => i.unitPrice)).size === 2,
    sameVariant.map((i) => i.unitPrice).join(' vs '),
  )
}

// ══════════════════════════════════════════════ removing
section('Removing', 'A set leaves whole')

{
  const cart = await call('/cart', { jar: customer })
  const groupId = (cart.json?.data?.cart?.items ?? []).find((i) => i.setGroupId)?.setGroupId

  const gone = await call(`/cart/sets/${groupId}`, { method: 'DELETE', jar: customer })
  check('removing a set removes every piece', gone.status === 200, `status ${gone.status}`)
  check(
    'nothing of it is left behind',
    (gone.json?.data?.cart?.items ?? []).every((i) => i.setGroupId !== groupId),
  )
  check(
    'the piece bought separately stays',
    (gone.json?.data?.cart?.items ?? []).some((i) => i.variantId === chosen[0].variantId),
  )

  const twice = await call(`/cart/sets/${groupId}`, { method: 'DELETE', jar: customer })
  check('removing it again is a clean no', twice.status === 404, `status ${twice.status}`)
}

// ---------------------------------------------------------------- tidy up

await call(`/admin/products/${setId}`, { method: 'DELETE', jar: admin })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
