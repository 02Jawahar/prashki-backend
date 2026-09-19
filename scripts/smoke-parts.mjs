/**
 * Buying several parts of one garment at once.
 *
 * A product sold in parts offers a top, a pant and the whole thing, and the
 * page used to let a customer choose exactly one. Someone who wanted the top
 * and the cape but not the pant had to add twice and hope the two halves
 * stayed together through checkout.
 *
 * They go in as one purchase now, tied by a group id, priced by adding the
 * chosen parts up. Each part keeps its own price rather than a share of a
 * total: unlike a set of separate garments these already have prices of their
 * own, and splitting a sum across them would invent numbers nobody set.
 *
 *   node scripts/smoke-parts.mjs
 *
 * Everything it adds, it removes.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

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
const rs = (paise) => `Rs${paise / 100}`
const brief = (x) => JSON.stringify(x ?? '').slice(0, 140)

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

console.log(`\n  target ${BASE}`)

// ── find something sold in parts ───────────────────────────────────────────
const db = new PrismaClient()
const row = await db.product.findFirst({
  where: { setOptions: { some: {} }, status: 'ACTIVE' },
  select: { slug: true, name: true },
})
await db.$disconnect()

if (!row) {
  console.log('\n  Nothing is sold in parts here — run smoke-weights.mjs first, or add set options.\n')
  process.exit(0)
}

const adm = session()
await signIn(adm, ADMIN)

const cust = session()
await signIn(cust, CUSTOMER)

const product = (await call(cust, `/products/${row.slug}`)).json?.data?.product
const parts = product.setOptions ?? []
const size = product.variants.find((v) => v.inStock) ?? product.variants[0]

console.log(`  ${product.name}: ${parts.map((p) => `${p.label} ${rs(p.price)}`).join(' | ')}`)

// Enough of that size to hold every part at once.
const adminProduct = (await call(adm, `/admin/products?perPage=60&q=${encodeURIComponent(product.name)}`)).json
  ?.data?.products?.[0]
if (adminProduct) {
  const full = (await call(adm, `/admin/products/${adminProduct.id}`)).json?.data?.product
  const match = full?.variants?.find((v) => v.id === size.id)
  if (match && match.stock < parts.length + 2) {
    await call(adm, `/admin/products/variants/${size.id}/stock`, {
      method: 'POST',
      body: { mode: 'set', stock: parts.length + 5, reason: 'parts smoke' },
    })
  }
}

const empty = async () => {
  for (const item of (await call(cust, '/cart')).json?.data?.cart?.items ?? []) {
    await call(cust, `/cart/items/${item.id}`, { method: 'DELETE' })
  }
}
await empty()

// ══════════════════════════════════════════════════ several parts
section('Several parts at once', 'The price follows the selection')

const [first, second] = parts
const added = await call(cust, '/cart/parts', {
  method: 'POST',
  body: { variantId: size.id, setOptionIds: [first.id, second.id], quantity: 1 },
})
check('they go in as one purchase', added.status === 200, added.status === 200 ? '' : brief(added.json?.error))

const cart = added.json?.data?.cart
const lines = cart?.items ?? []
check('one line per part', lines.length === 2, lines.map((l) => l.setOption ?? '(none)').join(' + '))
check('each line names its part', lines.every((l) => l.setOption))
check(
  'they are tied together',
  Boolean(lines[0]?.setGroupId) && lines[0].setGroupId === lines[1]?.setGroupId,
)
check(
  'the total adds the parts up',
  cart?.subtotal === first.price + second.price,
  `${rs(first.price)} + ${rs(second.price)} = ${rs(cart?.subtotal ?? 0)}`,
)

/** One size, several parts — so the parcel carries all of them. */
const quoted = await call(cust, '/shipping/quote?country=IN&state=Delhi&postalCode=110003')
check('the parcel weighs every part', (quoted.json?.data?.weightGrams ?? 0) > 0, `${quoted.json?.data?.weightGrams} g`)

const removed = await call(cust, `/cart/sets/${lines[0]?.setGroupId}`, { method: 'DELETE' })
check(
  'removing one removes all of them',
  removed.status === 200 && (removed.json?.data?.cart?.items ?? []).length === 0,
  'half a set is not something anyone ordered',
)

// ══════════════════════════════════════════════════ one part, and the whole
section('One part, and the whole thing', 'Both still price as before')

await call(cust, '/cart/parts', { method: 'POST', body: { variantId: size.id, setOptionIds: [first.id] } })
const alone = (await call(cust, '/cart')).json?.data?.cart
check('one part alone costs one part', alone?.subtotal === first.price, rs(alone?.subtotal ?? 0))
await empty()

const whole = parts[parts.length - 1]
await call(cust, '/cart/parts', { method: 'POST', body: { variantId: size.id, setOptionIds: [whole.id] } })
const together = (await call(cust, '/cart')).json?.data?.cart
check('the whole thing costs the whole thing', together?.subtotal === whole.price, rs(together?.subtotal ?? 0))
await empty()

// ══════════════════════════════════════════════════ what it refuses
section('What it refuses')

const dup = await call(cust, '/cart/parts', {
  method: 'POST',
  body: { variantId: size.id, setOptionIds: [first.id, first.id] },
})
check('the same part twice', dup.status === 409, dup.json?.error?.code)

const others = (await call(cust, '/products?perPage=12')).json?.data?.products ?? []
const elsewhere = others.find((p) => p.slug !== product.slug)
if (elsewhere) {
  const otherVariant = (await call(cust, `/products/${elsewhere.slug}`)).json?.data?.product?.variants?.[0]
  const cross = await call(cust, '/cart/parts', {
    method: 'POST',
    body: { variantId: otherVariant.id, setOptionIds: [first.id] },
  })
  check("a part that belongs to another garment", cross.status === 409, cross.json?.error?.code)
}

const none = await call(cust, '/cart/parts', { method: 'POST', body: { variantId: size.id, setOptionIds: [] } })
check('no parts at all', none.status === 422, none.json?.error?.code)

await empty()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
