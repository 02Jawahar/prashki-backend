/**
 * Adds the Categories column to the Ready to Wear menu.
 *
 * A garment type spans the ranges, so most of these links name several
 * categories at once rather than one: a dress is sold as Casuals, as Pret and
 * as Luxury Pret, and "Dresses" has to mean all of them. Kaftans, Salwar
 * Suits, Sarees and Lehengas exist in one range each, so those are single.
 *
 * Every link is checked against the live catalogue before the menu is saved.
 * A menu item that leads to an empty page is worse than no menu item, and the
 * whole point of this column is that the links work.
 *
 *   node scripts/add-categories-column.mjs --base https://api.prashandki.in/api/v1 \
 *     --email … --password …
 *
 * Re-runnable: it replaces the Categories column if one is already there
 * rather than adding a second.
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
const EMAIL = flag('email', process.env.ADMIN_EMAIL ?? 'admin@example.com')
const PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? 'Admin@12345')
const PARENT = flag('parent', 'Ready to Wear')
const COLUMN = flag('column', 'Categories')
const DRY = args.includes('--dry-run')

const RANGES = ['casuals', 'pret', 'luxury-pret']

const LINKS = [
  { label: 'Dresses', slugs: RANGES.flatMap((r) => [`${r}-long-dresses`, `${r}-short-dresses`]) },
  { label: 'Skirt Co-ord', slugs: RANGES.map((r) => `${r}-skirt-coord`) },
  { label: 'Pant Co-ord', slugs: RANGES.map((r) => `${r}-pant-coord`) },
  { label: 'Kaftans', slugs: ['luxury-pret-kaftans'] },
  { label: 'Salwar Suits', slugs: ['luxury-pret-salwar-suits'] },
  { label: 'Sarees', slugs: ['bridal-sarees'] },
  { label: 'Lehengas', slugs: ['bridal-lehengas'] },
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
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) — ${login.json?.error?.message ?? ''}`)
  process.exit(1)
}

// Build each href, and count what it actually returns before trusting it.
const items = []
let empty = 0
for (const link of LINKS) {
  const href =
    link.slugs.length === 1
      ? `/products?category=${link.slugs[0]}`
      : `/products?categories=${link.slugs.join(',')}`

  const check = await call(`${href}&perPage=1`)
  // meta.pagination.total — the real count, not the size of this page. With
  // perPage=1 a length check would report "1" for everything that is not empty.
  const count = check.json?.meta?.pagination?.total ?? 0
  console.log(`  ${link.label.padEnd(14)} ${String(count).padStart(3)} pieces   ${href}`)
  if (count === 0) empty++
  items.push({ label: link.label, href })
}

if (empty > 0) {
  console.error(`\n  ${empty} link(s) lead nowhere. Not saving — file the catalogue first.\n`)
  process.exit(1)
}

const settings = await call('/admin/settings')
const row = (settings.json?.data?.settings ?? []).find((s) => s.key === 'nav.main')
let nav = []
try {
  nav = JSON.parse(row?.value ?? '[]')
} catch {
  console.error('  nav.main is not valid JSON — stopping rather than overwriting it.')
  process.exit(1)
}

const parent = nav.find((n) => n.label === PARENT)
if (!parent) {
  console.error(`\n  No "${PARENT}" in the menu.\n`)
  process.exit(1)
}

parent.children ??= []
const column = { label: COLUMN, href: '/products', children: items }
const at = parent.children.findIndex((c) => c.label === COLUMN)
if (at >= 0) {
  parent.children[at] = column
  console.log(`\n  replacing the existing "${COLUMN}" column`)
} else {
  parent.children.push(column)
  console.log(`\n  adding "${COLUMN}" as column ${parent.children.length} of ${PARENT}`)
}

if (DRY) {
  console.log('\n  (dry run — not saved)\n')
  process.exit(0)
}

const save = await call('/admin/navigation', { method: 'PUT', body: { items: nav } })
if (save.status !== 200) {
  console.error(`  Could not save the menu (${save.status}) — ${save.json?.error?.message ?? ''}`)
  process.exit(1)
}

console.log(`  saved — ${PARENT} now has ${parent.children.map((c) => c.label).join(', ')}\n`)
