/**
 * Whether a garment's weight reaches the courier.
 *
 * The column existed from the start and nothing could write to it — no field
 * in the admin API, none in the form — so every piece in the catalogue was
 * quoted at the store-wide default. A lehenga declared at 500 g is reweighed
 * at the carrier's hub and the difference comes out of the wallet, quietly,
 * on every order.
 *
 * Two weights, not one. A product sold in parts has a single size variant
 * behind every option — a top and the full set are both "M" — so a weight
 * living only on the variant quotes the same parcel for a blouse and for a
 * blouse, skirt and dupatta together. The part's weight wins when a part was
 * chosen.
 *
 *   node scripts/smoke-weights.mjs
 *
 * Everything it writes, it puts back.
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
const ADMIN = { email: flag('email', 'admin@example.com'), password: flag('password', 'Admin@12345') }
const CUSTOMER = { email: 'customer@example.com', password: 'Customer@12345' }

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
const section = (t, n) => console.log(`\n${t}${n ? `  ${n}` : ''}`)

const session = () => ({ jar: new Map(), csrf: null })

function absorb(s, res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.split('=')
    s.jar.set(name.trim(), rest.join('='))
  }
  if (s.jar.has('csrf')) s.csrf = s.jar.get('csrf')
}

async function call(s, pathname, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (s.jar.size) headers.cookie = [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  if (s.csrf) headers['x-csrf-token'] = s.csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  absorb(s, res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

const signIn = async (s, who) => {
  await call(s, '/')
  return call(s, '/auth/login', { method: 'POST', body: who })
}

const brief = (x) => JSON.stringify(x ?? '').slice(0, 160)

console.log(`\n  target ${BASE}`)

const adm = session()
await signIn(adm, ADMIN)

// ══════════════════════════════════════════════════ a plain garment
section('A garment', 'Weighing one size')

const listed = await call(adm, '/admin/products?perPage=20')
const candidate = (listed.json?.data?.products ?? []).find((p) => p.status === 'ACTIVE')
const detail = await call(adm, `/admin/products/${candidate.id}`)
const product = detail.json?.data?.product
const variant = product.variants.find((v) => v.stock > 0) ?? product.variants[0]

check('a variant reports its weight', 'weightGrams' in variant, `${product.name} / ${variant.name} = ${variant.weightGrams ?? 'not weighed'}`)

const originalWeight = variant.weightGrams
const set = await call(adm, `/admin/products/${product.id}/variants/${variant.id}`, {
  method: 'PATCH',
  body: { weightGrams: 1800 },
})
check('an operator can set a weight', set.status === 200, set.status === 200 ? '1800 g' : brief(set.json?.error))

const reread = await call(adm, `/admin/products/${product.id}`)
const saved = reread.json?.data?.product?.variants?.find((v) => v.id === variant.id)
check('it is stored, not just accepted', saved?.weightGrams === 1800, `${saved?.weightGrams} g`)

const cleared = await call(adm, `/admin/products/${product.id}/variants/${variant.id}`, {
  method: 'PATCH',
  body: { weightGrams: null },
})
const afterClear = (await call(adm, `/admin/products/${product.id}`)).json?.data?.product?.variants
  ?.find((v) => v.id === variant.id)
check('blank means unweighed, not weightless', cleared.status === 200 && afterClear?.weightGrams === null,
  `${afterClear?.weightGrams}`)

// put it back before anything else runs
await call(adm, `/admin/products/${product.id}/variants/${variant.id}`, {
  method: 'PATCH',
  body: { weightGrams: originalWeight },
})

// ══════════════════════════════════════════════════ a garment sold in parts
section('A garment sold in parts', 'Weighing each part')

const withParts = await call(adm, '/admin/products?perPage=60')
let setProduct = null
for (const p of withParts.json?.data?.products ?? []) {
  const full = (await call(adm, `/admin/products/${p.id}`)).json?.data?.product
  if ((full?.setOptions ?? []).length >= 2) {
    setProduct = full
    break
  }
}

/**
 * Nothing is sold in parts on a fresh database, so make one rather than skip.
 * A test that quietly does nothing when its fixture is missing is worse than
 * no test: it reports a pass for a path it never ran.
 */
let borrowed = false
if (!setProduct) {
  /*
   * Not any product will do. One that is already a piece of another set is
   * sold whole and the API refuses parts on it, so try candidates until one
   * takes rather than giving up on the first refusal.
   */
  for (const p of withParts.json?.data?.products ?? []) {
    if (p.status !== 'ACTIVE' || p.id === product.id) continue

    const made = await call(adm, `/admin/products/${p.id}/set-options`, {
      method: 'PUT',
      body: {
        options: [
          { label: 'Smoke top', price: 50000 },
          { label: 'Smoke set', price: 150000 },
        ],
      },
    })
    if (made.status !== 200) continue

    borrowed = true
    setProduct = (await call(adm, `/admin/products/${p.id}`)).json?.data?.product
    console.log(`  (borrowed "${setProduct.name}" - its parts are removed again at the end)`)
    break
  }
}

if (!setProduct) {
  check('a product sold in parts is available to test', false, 'none found and none could be made')
} else {
  const parts = setProduct.setOptions
  check('parts report their own weight', parts.every((o) => 'weightGrams' in o),
    parts.map((o) => `${o.label} ${o.weightGrams ?? '-'}`).join(', '))

  const before = parts.map((o) => ({ label: o.label, price: o.price, weightGrams: o.weightGrams }))

  // The lightest part and the whole set must not weigh the same.
  const written = parts.map((o, i) => ({
    label: o.label,
    price: o.price,
    weightGrams: i === parts.length - 1 ? 2400 : 700,
  }))

  const put = await call(adm, `/admin/products/${setProduct.id}/set-options`, {
    method: 'PUT',
    body: { options: written },
  })
  check('an operator can weigh each part', put.status === 200, put.status === 200 ? '700 g each, 2400 g for the whole' : brief(put.json?.error))

  const back = (await call(adm, `/admin/products/${setProduct.id}`)).json?.data?.product?.setOptions ?? []
  check('the weights are stored per part', back.some((o) => o.weightGrams === 2400) && back.some((o) => o.weightGrams === 700),
    back.map((o) => `${o.label} ${o.weightGrams}`).join(', '))

  // ── what the courier is actually told ───────────────────────────────────
  section('At checkout', 'Which weight the carrier is quoted')

  const cust = session()
  await signIn(cust, CUSTOMER)

  const publicProduct = (await call(cust, `/products/${setProduct.slug}`)).json?.data?.product
  const size = (publicProduct?.variants ?? []).find((v) => v.inStock) ?? publicProduct?.variants?.[0]
  const options = publicProduct?.setOptions ?? []
  const light = options.find((o) => o.price === Math.min(...options.map((x) => x.price)))
  const whole = options.find((o) => o.price === Math.max(...options.map((x) => x.price)))

  const address = (await call(cust, '/addresses')).json?.data?.addresses?.[0]
  const where = `country=IN&state=${encodeURIComponent(address.state)}&postalCode=${address.postalCode}`

  const weighCart = async (setOptionId) => {
    const cart = await call(cust, '/cart')
    for (const item of cart.json?.data?.cart?.items ?? []) {
      await call(cust, `/cart/items/${item.id}`, { method: 'DELETE' })
    }
    await call(cust, '/cart/items', { method: 'POST', body: { variantId: size.id, quantity: 1, setOptionId } })
    const quote = await call(cust, `/shipping/quote?${where}`)
    return quote.json?.data?.weightGrams
  }

  const lightWeight = await weighCart(light.id)
  const wholeWeight = await weighCart(whole.id)

  check('buying one part is quoted at that part’s weight', lightWeight === 700, `${light.label} -> ${lightWeight} g`)
  check('buying the whole set is quoted heavier', wholeWeight === 2400, `${whole.label} -> ${wholeWeight} g`)
  check('the two differ, which is the whole point', lightWeight !== wholeWeight,
    `${lightWeight} g vs ${wholeWeight} g`)

  // ── put the product back ────────────────────────────────────────────────
  const cart = await call(cust, '/cart')
  for (const item of cart.json?.data?.cart?.items ?? []) {
    await call(cust, `/cart/items/${item.id}`, { method: 'DELETE' })
  }
  await call(adm, `/admin/products/${setProduct.id}/set-options`, {
    method: 'PUT',
    // A product that had no parts before this ran must have none after it.
    body: { options: borrowed ? [] : before },
  })
  const restored = (await call(adm, `/admin/products/${setProduct.id}`)).json?.data?.product?.setOptions
  check('everything written was put back',
    borrowed
      ? !restored || restored.length === 0
      : (restored ?? []).every((o, i) => (o.weightGrams ?? null) === (before[i]?.weightGrams ?? null)),
    borrowed ? 'borrowed parts removed' : (restored ?? []).map((o) => `${o.label} ${o.weightGrams ?? '-'}`).join(', '))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
