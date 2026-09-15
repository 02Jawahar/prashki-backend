/**
 * Sets the homepage to its intended shape.
 *
 * Four sections, in this order:
 *
 *   1. the film wall, with the collection name over it
 *   2. new arrivals
 *   3. the customer films, under "Follow us"
 *   4. the newsletter
 *
 * The film wall is carried over from whatever is already configured rather than
 * rebuilt, so running this does not un-pick the films that were uploaded. If
 * there is no wall yet, `import-reels.mjs` is what creates one.
 *
 * Everything else — the service bar, the editorial banner, shop-by-category —
 * is dropped. They came from the original build and are not in the layout this
 * store is going for.
 *
 *   node scripts/set-homepage.mjs
 *   node scripts/set-homepage.mjs --base https://api.example.com/api/v1
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

console.log(`\n  target ${BASE}\n`)

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}).`)
  process.exit(1)
}

const settings = await call('/admin/settings')
const row = (settings.json?.data?.settings ?? []).find((s) => s.key === 'home.sections')

let current = []
try {
  current = JSON.parse(row?.value ?? '[]')
} catch {
  current = []
}

const existingWall = current.find((s) => s.type === 'video-grid')

if (!existingWall) {
  console.error('  No film wall configured. Run import-reels.mjs first.\n')
  process.exit(1)
}

const sections = [
  existingWall,
  /**
   * Four, matching the row it sits in. A number that does not divide the grid
   * leaves a hole in the last row, which reads as a missing product.
   */
  { type: 'new-arrivals', heading: 'New Arrivals', limit: 4 },
  {
    type: 'showcase',
    heading: 'Follow us',
    body: '',
    // The five that are not already at the top of the page.
    limit: 5,
  },
  {
    type: 'newsletter',
    heading: 'Stay in touch',
    body: 'First look at new pieces, and the occasional note from the studio.',
  },
]

const saved = await call('/admin/settings', {
  method: 'PATCH',
  body: { settings: [{ key: 'home.sections', value: JSON.stringify(sections) }] },
})

if (saved.status >= 300) {
  console.error(`  Failed (${saved.status})`, saved.json?.error?.message ?? '')
  process.exit(1)
}

const dropped = current.filter((s) => !sections.some((k) => k.type === s.type)).map((s) => s.type)

console.log('  Homepage is now:')
sections.forEach((s, i) => {
  const label =
    s.type === 'video-grid'
      ? `film wall — "${s.heading}", ${s.items?.length ?? 0} films`
      : s.type === 'showcase'
        ? `showcase — "${s.heading}", ${s.limit} tiles`
        : `${s.type}${s.heading ? ` — "${s.heading}"` : ''}`
  console.log(`    ${i + 1}. ${label}`)
})

if (dropped.length) console.log(`\n  Removed: ${dropped.join(', ')}`)
console.log('')
