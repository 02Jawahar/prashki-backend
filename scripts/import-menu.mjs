/**
 * Creates the sub-categories the Ready to Wear dropdown needs, then builds the
 * menu that points at them.
 *
 * Two things rather than one, because they are different kinds of fact: the
 * categories are what a product can belong to, and the menu is how someone
 * finds them. Building the menu without the categories gives you links that
 * 404; building the categories without the menu leaves them unreachable.
 *
 * Re-runnable. Categories are matched by slug and left alone if they exist, and
 * the menu is replaced wholesale, which is how the API takes it anyway.
 *
 *   node scripts/import-menu.mjs
 *   node scripts/import-menu.mjs --base https://api.example.com/api/v1
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
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345'

/**
 * The garment types under each of the four ranges.
 *
 * Slugs carry their parent — "short dresses" exists under three different
 * ranges and a slug is unique across the whole catalogue, so `short-dresses`
 * on its own could only ever belong to one of them.
 */
const TREE = [
  {
    parent: 'casuals',
    label: 'Casual',
    children: [
      ['Short Dresses', 'casuals-short-dresses'],
      ['Long Dresses', 'casuals-long-dresses'],
      ['Pant Co-ord', 'casuals-pant-coord'],
      ['Skirt Co-ord', 'casuals-skirt-coord'],
    ],
  },
  {
    parent: 'pret',
    label: 'Pret',
    children: [
      ['Short Dresses', 'pret-short-dresses'],
      ['Long Dresses', 'pret-long-dresses'],
      ['Pant Co-ord', 'pret-pant-coord'],
      ['Skirt Co-ord', 'pret-skirt-coord'],
    ],
  },
  {
    parent: 'luxury-pret',
    label: 'Luxury Pret',
    children: [
      ['Short Dresses', 'luxury-pret-short-dresses'],
      ['Long Dresses', 'luxury-pret-long-dresses'],
      ['Pant Co-ord', 'luxury-pret-pant-coord'],
      ['Skirt Co-ord', 'luxury-pret-skirt-coord'],
      ['Salwar Suits', 'luxury-pret-salwar-suits'],
      ['Kaftans', 'luxury-pret-kaftans'],
    ],
  },
  {
    parent: 'bridal',
    label: 'Bridal Wear',
    children: [
      ['Sarees', 'bridal-sarees'],
      ['Lehengas', 'bridal-lehengas'],
    ],
  },
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

console.log(`\n  target ${BASE}\n`)

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}).`)
  process.exit(1)
}

const listed = await call('/admin/categories?perPage=200')
const bySlug = new Map((listed.json?.data?.categories ?? []).map((c) => [c.slug, c]))

let made = 0
for (const range of TREE) {
  const parent = bySlug.get(range.parent)
  if (!parent) {
    console.error(`  Parent category "${range.parent}" does not exist — run import-lookbook first.`)
    process.exit(1)
  }

  for (const [name, slug] of range.children) {
    if (bySlug.has(slug)) {
      console.log(`  ${slug.padEnd(28)} exists`)
      continue
    }
    const created = await call('/admin/categories', {
      method: 'POST',
      body: { name, slug, parentId: parent.id, status: 'ACTIVE' },
    })
    if (created.status >= 300) {
      console.error(`  ${slug.padEnd(28)} FAILED ${created.status}`, created.json?.error?.message ?? '')
      continue
    }
    bySlug.set(slug, created.json.data.category)
    made++
    console.log(`  ${slug.padEnd(28)} created under ${range.label}`)
  }
}

/**
 * The menu, in the reference's two-column shape.
 *
 * "Featured" is ways of slicing the whole catalogue — newest, best selling,
 * best rated — so its links are sorts of the product list rather than
 * categories. RANGREZ is a collection, so it points at that collection's own
 * page rather than a filtered list — the page carries the cover and the copy,
 * which a filter cannot.
 *
 * "Women's" is the catalogue itself: the four ranges, flat. Garment types are
 * reached from a range's own page rather than the menu — a dropdown listing
 * twenty destinations is a directory, and people scan a menu rather than read
 * it.
 */
const FEATURED = [
  ['New In', '/products?sort=newest'],
  ['Bestsellers', '/products?sort=bestsellers'],
  ['Our Favourites', '/products?sort=rating'],
  ['RANGREZ', '/collections/rangrez'],
]

const items = [
  { label: 'Home', href: '/' },
  {
    label: 'Ready to Wear',
    href: '/products',
    children: [
      {
        label: 'Featured',
        href: '/products',
        children: FEATURED.map(([label, href]) => ({ label, href })),
      },
      {
        label: "Women's",
        href: '/products',
        children: [
          ...TREE.map((range) => ({
            label: range.label,
            href: `/products?category=${range.parent}`,
          })),
          { label: 'View All', href: '/products' },
        ],
      },
    ],
  },
  { label: 'Discover', href: '/discover' },
  { label: 'Gift Card', href: '/gift-card' },
]

const saved = await call('/admin/navigation', { method: 'PUT', body: { items } })
if (saved.status >= 300) {
  console.error(`\n  Menu FAILED ${saved.status}`, JSON.stringify(saved.json?.error))
  process.exit(1)
}

console.log(`\n  ${made} sub-categories created, menu saved\n`)
const show = (nodes, indent = 2) => {
  for (const n of nodes) {
    console.log(`${' '.repeat(indent)}${n.label}`)
    if (n.children) show(n.children, indent + 2)
  }
}
show(saved.json.data.items)
console.log('')
