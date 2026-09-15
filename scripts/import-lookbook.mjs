/**
 * Imports a photo shoot into the catalogue.
 *
 * The shoot arrives as one folder per garment, each holding five to seven
 * frames of it. That maps exactly onto a product and its images, so this walks
 * the folders, creates a product per folder and uploads its frames in order.
 *
 * What it deliberately does NOT invent: names, prices, copy, sizes or stock.
 * Those are decisions, not data, and a catalogue full of plausible-looking
 * guesses is worse than one that is obviously unfinished — the guesses get
 * published. Every product lands as DRAFT with a placeholder name and a zero
 * price, which the storefront will not show and the admin cannot accidentally
 * publish without noticing.
 *
 * Re-runnable: a product whose SKU already exists is skipped, so an interrupted
 * run continues where it stopped rather than duplicating half the shoot.
 *
 *   node scripts/import-lookbook.mjs --dry-run
 *   node scripts/import-lookbook.mjs
 *   node scripts/import-lookbook.mjs --base https://api.example.com/api/v1 --delay 1100
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
const DRY = args.includes('--dry-run')
const BASE = flag('base', process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1')
const ROOT = flag('root', 'E:/prashki-assets')
/**
 * Pause between writes. Production caps writes at 60/minute, so the default
 * paces just under that; locally the cap is 1,000 and this can be dropped.
 */
const DELAY = Number(flag('delay', BASE.includes('127.0.0.1') ? '0' : '1100'))

const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345'

/**
 * Which garment belongs in which category, as supplied by the studio.
 *
 * Kept as the numbers they sent rather than rewritten into ranges, so it can be
 * checked against the original message without decoding anything.
 */
const SHOOTS = [
  {
    key: 'S2',
    dir: '2sep/2nd sep Prashanthi',
    pad: 2,
    categories: {
      casuals: [22, 23, 24, 25],
      pret: [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 27, 28],
      'luxury-pret': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bridal: [],
    },
  },
  {
    key: 'S3',
    dir: '3sep/3rd sep prashanthi',
    pad: 1,
    categories: {
      casuals: [6, 7, 8, 9, 10, 19, 20, 21],
      pret: [],
      'luxury-pret': [1, 2, 3, 4, 5],
      bridal: [
        11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      ],
    },
  },
]

const CATEGORIES = [
  { slug: 'casuals', name: 'Casuals', sortOrder: 1 },
  { slug: 'pret', name: 'Pret', sortOrder: 2 },
  { slug: 'luxury-pret', name: 'Luxury Pret', sortOrder: 3 },
  { slug: 'bridal', name: 'Bridal', sortOrder: 4 },
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

function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function call(pathname, { method = 'GET', body, form } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (cookies.size) headers.cookie = cookieHeader()
  if (csrf) headers['x-csrf-token'] = csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
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

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

// ---------------------------------------------------------------- run

console.log(`\n  target   ${BASE}`)
console.log(`  assets   ${ROOT}`)
console.log(`  mode     ${DRY ? 'dry run — nothing is written' : 'live'}\n`)

// Collect the work first, so a bad path fails before anything is created.
const planned = []
for (const shoot of SHOOTS) {
  for (const [categorySlug, numbers] of Object.entries(shoot.categories)) {
    for (const n of numbers) {
      const folder = path.join(ROOT, shoot.dir, String(n).padStart(shoot.pad, '0'))
      if (!fs.existsSync(folder)) {
        console.error(`  MISSING  ${folder}`)
        process.exit(1)
      }
      const images = fs
        .readdirSync(folder)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .sort()
      planned.push({ shoot: shoot.key, n, categorySlug, folder, images })
    }
  }
}

planned.sort((a, b) => a.shoot.localeCompare(b.shoot) || a.n - b.n)

const byCategory = planned.reduce((acc, p) => {
  acc[p.categorySlug] = (acc[p.categorySlug] ?? 0) + 1
  return acc
}, {})

console.log(`  ${planned.length} garments, ${planned.reduce((t, p) => t + p.images.length, 0)} images`)
for (const [slug, count] of Object.entries(byCategory)) console.log(`    ${slug.padEnd(14)} ${count}`)
console.log('')

if (DRY) {
  for (const p of planned.slice(0, 5)) {
    console.log(`    ${p.shoot}-${String(p.n).padStart(2, '0')}  ${p.categorySlug.padEnd(14)} ${p.images.length} images`)
  }
  console.log(`    … and ${planned.length - 5} more\n`)
  process.exit(0)
}

// Signed double-submit: the token arrives on a response, and login is itself a
// write, so a read has to go out first to prime one.
await call('/')

const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}). Check ADMIN_EMAIL and ADMIN_PASSWORD.`)
  process.exit(1)
}
console.log(`  signed in as ${EMAIL}\n`)

// ---- categories ----
const existing = await call('/admin/categories?perPage=100')
const bySlug = new Map((existing.json?.data?.categories ?? []).map((c) => [c.slug, c.id]))

for (const category of CATEGORIES) {
  if (bySlug.has(category.slug)) {
    console.log(`  category  ${category.name.padEnd(14)} exists`)
    continue
  }
  const made = await call('/admin/categories', {
    method: 'POST',
    body: { ...category, status: 'ACTIVE' },
  })
  if (made.status >= 300) {
    console.error(`  category  ${category.name} FAILED ${made.status}`, made.json?.error?.message ?? '')
    process.exit(1)
  }
  bySlug.set(category.slug, made.json.data.category.id)
  console.log(`  category  ${category.name.padEnd(14)} created`)
  await sleep(DELAY)
}

// ---- products ----
let created = 0
let skipped = 0
let uploaded = 0

for (const [index, item] of planned.entries()) {
  const number = String(index + 1).padStart(2, '0')
  const sku = `PK-${item.shoot}-${String(item.n).padStart(2, '0')}`
  const slug = `look-${number}`
  const label = `${sku} → ${slug}`

  const product = await call('/admin/products', {
    method: 'POST',
    body: {
      name: `Look ${number}`,
      slug,
      sku,
      // Flagged rather than filled, so an unfinished product reads as
      // unfinished wherever it is seen.
      description: 'Awaiting copy.',
      price: 0,
      status: 'DRAFT',
      categoryId: bySlug.get(item.categorySlug),
    },
  })

  if (product.status === 409 || product.json?.error?.code === 'DUPLICATE_SKU') {
    skipped++
    console.log(`  ${label.padEnd(26)} skipped (exists)`)
    continue
  }
  if (product.status >= 300) {
    console.error(`  ${label.padEnd(26)} FAILED ${product.status}`, product.json?.error?.message ?? '')
    continue
  }

  const id = product.json.data.product.id
  created++
  await sleep(DELAY)

  // Eight per request is the endpoint's cap; no folder has more than seven.
  const form = new FormData()
  for (const file of item.images) {
    const full = path.join(item.folder, file)
    form.append('images', new Blob([fs.readFileSync(full)], { type: 'image/jpeg' }), file)
  }

  const images = await call(`/admin/products/${id}/images`, { method: 'POST', form })
  if (images.status >= 300) {
    console.error(`  ${label.padEnd(26)} images FAILED ${images.status}`, images.json?.error?.message ?? '')
  } else {
    uploaded += item.images.length
    console.log(`  ${label.padEnd(26)} ${item.categorySlug.padEnd(14)} ${item.images.length} images`)
  }
  await sleep(DELAY)
}

console.log(`\n  ${created} created, ${skipped} skipped, ${uploaded} images uploaded\n`)
console.log('  All products are DRAFT with a zero price — they need a name, a price,')
console.log('  copy and sizes before they can be published.\n')
