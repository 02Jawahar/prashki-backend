/**
 * Puts every product's photos in the order a shopper wants them: front, then
 * back, then side, then everything else.
 *
 * The order itself is not computed here — nothing in the filenames says which
 * shot is which, so the classification was done by eye and lives in a JSON
 * file keyed by product slug. This script only applies it.
 *
 *   node scripts/order-product-images.mjs --file E:/prashki-assets/order/decisions.json \
 *     --base https://api.prashandki.in/api/v1 --email … --password …
 *
 * Photos are addressed by the filename stem that survives into the published
 * URL, never by position. A product someone has already reordered by hand,
 * here or in admin, still gets the right photo in the right slot — and a
 * product whose photo set no longer matches the file is skipped loudly rather
 * than reordered into something wrong.
 *
 * Add --dry-run to see what would change. Re-runnable: a product already in
 * the wanted order is left alone, so a second run writes nothing.
 */
import fs from 'node:fs'
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
const FILE = flag('file', 'E:/prashki-assets/order/decisions.json')
const EMAIL = flag('email', process.env.ADMIN_EMAIL ?? 'admin@example.com')
const PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? 'Admin@12345')
const DRY = args.includes('--dry-run')

const DELAY = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 80 : 1100

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withRetry(label, fn) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await fn()
    if (result.status !== 429) return result
    const wait = attempt * 5000
    console.log(`    rate limited on ${label}; waiting ${wait / 1000}s`)
    await sleep(wait)
  }
  throw new Error(`${label} kept hitting the rate limit`)
}

/** The stem a published URL was built from — "01-17496" out of "01-17496-7aaa….jpg". */
const stemOf = (url) => url.match(/\/([^/]+)-[a-f0-9]{12}\.[a-z]+$/i)?.[1] ?? null

// ---------------------------------------------------------------- run

const wanted = JSON.parse(fs.readFileSync(FILE, 'utf8'))

console.log(`\n  target ${BASE}`)
console.log(`  order  ${FILE} — ${Object.keys(wanted).length} products`)
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) — ${login.json?.error?.message ?? ''}`)
  process.exit(1)
}

const listing = []
for (let page = 1; ; page++) {
  const r = await call(`/admin/products?perPage=48&page=${page}`)
  const batch = r.json?.data?.products ?? []
  if (!batch.length) break
  listing.push(...batch)
  if (batch.length < 48) break
}
const byId = new Map(listing.map((p) => [p.slug, p.id]))

let reordered = 0
let already = 0
let skipped = 0

for (const [slug, order] of Object.entries(wanted)) {
  const id = byId.get(slug)
  if (!id) {
    console.error(`  SKIP ${slug} — no such product`)
    skipped++
    continue
  }

  const detail = await call(`/admin/products/${id}`)
  const images = detail.json?.data?.product?.images ?? []

  // Suffix, because that is what the classification recorded and it is unique
  // within a product even when the prefix differs between shoots.
  const bySuffix = new Map()
  for (const img of images) {
    const stem = stemOf(img.url)
    if (stem) bySuffix.set(stem.split('-').pop(), img.id)
  }

  const missing = order.filter((s) => !bySuffix.has(s))
  const extra = [...bySuffix.keys()].filter((s) => !order.includes(s))
  if (missing.length || extra.length) {
    // The recorded order no longer describes this product — a photo was added
    // or removed since. Reordering what is left would put something arbitrary
    // first, which is worse than leaving it as it was.
    console.error(
      `  SKIP ${slug} — photo set has changed` +
        (missing.length ? ` (not found: ${missing.join(', ')})` : '') +
        (extra.length ? ` (unlisted: ${extra.join(', ')})` : ''),
    )
    skipped++
    continue
  }

  const imageIds = order.map((s) => bySuffix.get(s))
  const current = images.map((i) => i.id)
  if (imageIds.every((v, i) => v === current[i])) {
    already++
    continue
  }

  if (DRY) {
    console.log(`  ${slug}: ${images.map((i) => stemOf(i.url).split('-').pop()).join(' ')}  ->  ${order.join(' ')}`)
    reordered++
    continue
  }

  const r = await withRetry(slug, () =>
    call(`/admin/products/${id}/images/order`, { method: 'PATCH', body: { imageIds } }),
  )
  if (r.status !== 200) {
    console.error(`  ${slug} -> ${r.status} ${r.json?.error?.message ?? ''}`)
    skipped++
    continue
  }
  reordered++
  if (reordered % 10 === 0) console.log(`  ${reordered} reordered…`)
  await sleep(DELAY)
}

console.log(`\n  ${reordered} reordered, ${already} already correct, ${skipped} skipped\n`)
process.exit(skipped > 0 ? 1 : 0)
