/**
 * Makes the imported shoot visible on the storefront.
 *
 * A product cannot be published without a price, and cannot be bought without a
 * variant carrying stock. The import deliberately left both empty, because
 * prices are a decision nobody should make on the studio's behalf.
 *
 * This fills them with PLACEHOLDERS so the storefront can be looked at. The
 * numbers are round to the nearest five hundred and identical across a whole
 * range, which is not how a real catalogue is priced — that is the point. They
 * are meant to be obviously provisional to anyone who sees them.
 *
 *   node scripts/publish-lookbook.mjs            # publish with placeholders
 *   node scripts/publish-lookbook.mjs --revert   # back to DRAFT, price 0
 *
 * Do not run this against production until real prices exist. It refuses a
 * non-local target without --i-know, for exactly that reason.
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
const REVERT = args.includes('--revert')
const OVERRIDE = args.includes('--i-know')

const isLocal = /127\.0\.0\.1|localhost/.test(BASE)
if (!isLocal && !OVERRIDE) {
  console.error(`\n  Refusing to publish placeholder prices to ${BASE}.`)
  console.error('  Set real prices first, or pass --i-know if you truly mean it.\n')
  process.exit(1)
}

const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345'

/** Placeholder, in paise. One number per range — see the note above. */
const PRICES = {
  casuals: 450000,
  pret: 850000,
  'luxury-pret': 1650000,
  bridal: 3450000,
}

/** Standard womenswear run. Stock is nominal, so the storefront is buyable. */
const SIZES = [
  ['XS', 3],
  ['S', 5],
  ['M', 5],
  ['L', 5],
  ['XL', 3],
]

// ---------------------------------------------------------------- http

const cookies = new Map()
let csrf = null

function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.split('=')
    cookies.set(name.trim(), rest.join('='))
  }
  if (cookies.has('csrf')) csrf = cookies.get('csrf')
}

async function call(pathname, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  if (csrf) headers['x-csrf-token'] = csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  absorb(res)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  return { status: res.status, json }
}

// ---------------------------------------------------------------- run

console.log(`\n  target ${BASE}`)
console.log(`  mode   ${REVERT ? 'revert to draft' : 'publish with PLACEHOLDER prices'}\n`)

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}).`)
  process.exit(1)
}

// 100 is the endpoint's cap; asking for more is a validation error, not a
// bigger page, and the empty result reads as "nothing imported".
const wanted = REVERT ? 'ACTIVE' : 'DRAFT'
const mine = []
for (let page = 1; ; page++) {
  const listed = await call(`/admin/products?perPage=100&page=${page}&status=${wanted}`)
  if (listed.status >= 300) {
    console.error(`  Listing failed (${listed.status})`, listed.json?.error?.message ?? '')
    process.exit(1)
  }
  const batch = listed.json?.data?.products ?? []
  mine.push(...batch.filter((p) => p.sku?.startsWith('PK-S')))
  if (batch.length < 100) break
}

if (mine.length === 0) {
  console.error('  No imported products found. Run import-lookbook.mjs first.')
  process.exit(1)
}

console.log(`  ${mine.length} products\n`)

let done = 0
let variants = 0
const failures = []

for (const product of mine) {
  const detail = await call(`/admin/products/${product.id}`)
  const full = detail.json?.data?.product
  const categorySlug = full?.category?.slug ?? null

  if (REVERT) {
    const r = await call(`/admin/products/${product.id}`, {
      method: 'PATCH',
      body: { status: 'DRAFT', price: 0 },
    })
    if (r.status >= 300) failures.push(`${product.sku} ${r.status}`)
    else done++
    continue
  }

  // A sub-category would inherit its parent's price; none are assigned yet.
  const price = PRICES[categorySlug] ?? PRICES.pret

  // Sizes first — a published product with nothing in stock reads as sold out.
  if ((full?.variants?.length ?? 0) === 0) {
    for (const [size, stock] of SIZES) {
      const v = await call(`/admin/products/${product.id}/variants`, {
        method: 'POST',
        body: { name: size, sku: `${product.sku}-${size}`, stock, status: 'ACTIVE' },
      })
      if (v.status < 300) variants++
    }
  }

  const r = await call(`/admin/products/${product.id}`, {
    method: 'PATCH',
    body: { price, status: 'ACTIVE' },
  })

  if (r.status >= 300) {
    failures.push(`${product.sku} ${r.status} ${r.json?.error?.message ?? ''}`)
    continue
  }

  done++
  process.stdout.write(`\r  ${done}/${mine.length} published`)
}

console.log('')
if (failures.length) {
  console.log(`\n  ${failures.length} failed:`)
  for (const f of failures.slice(0, 10)) console.log(`    ${f}`)
}

if (REVERT) {
  console.log(`\n  ${done} products back to DRAFT at zero.\n`)
} else {
  console.log(`\n  ${done} published, ${variants} size variants created.\n`)
  console.log('  PRICES ARE PLACEHOLDERS — one flat number per range:')
  for (const [slug, paise] of Object.entries(PRICES)) {
    console.log(`    ${slug.padEnd(14)} Rs ${(paise / 100).toLocaleString('en-IN')}`)
  }
  console.log('\n  Replace them before this goes anywhere near production.')
  console.log('  `node scripts/publish-lookbook.mjs --revert` puts it all back.\n')
}
