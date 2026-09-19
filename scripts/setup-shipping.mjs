/**
 * Opens delivery, so the shop can take an order.
 *
 * Without a zone every address is refused at checkout: a customer can browse
 * the whole catalogue, fill a bag, and be told at the last step that we do not
 * deliver to their country. That is the state a shop is in before this runs.
 *
 * One zone, deliberately. The carrier knows which PIN codes it serves and
 * nobody here should be maintaining that list by hand — so the zone covers
 * India entire and says nothing about serviceability, and the carrier refuses
 * an address it cannot reach. The zone exists because a delivery option has
 * to live somewhere, not because it decides anything.
 *
 * Two options, priced by the carrier: the cheap one and the quick one. Each
 * keeps a flat rate underneath as the fallback for a carrier that cannot be
 * reached, and that fallback is free — which is what the site's own
 * announcement bar already promises, and a promise on the page that disagrees
 * with the price at checkout is worse than either alone.
 *
 *   node scripts/setup-shipping.mjs --base https://api.prashandki.in/api/v1 \
 *     --email … --password …
 *
 * Re-runnable: a zone that already exists is left alone rather than duplicated.
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
const DRY = args.includes('--dry-run')

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

console.log(`\n  target ${BASE}`)
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status})\n`)
  process.exit(1)
}

const existing = await call('/admin/shipping/zones')
const zones = existing.json?.data?.zones ?? []
console.log(`  zones already configured: ${zones.length}`)

const wanted = 'India'
if (zones.some((z) => z.name === wanted)) {
  console.log(`  "${wanted}" already exists — leaving it alone.\n`)
  process.exit(0)
}

if (DRY) {
  console.log(`  would create "${wanted}" with complimentary Standard delivery, 15–20 days\n`)
  process.exit(0)
}

const zone = await call('/admin/shipping/zones', {
  method: 'POST',
  body: {
    name: wanted,
    countries: ['IN'],
    // Empty means the whole country. Narrower zones go above this one.
    states: [],
    isServiceable: true,
    isActive: true,
    position: 10,
    description: 'Delivered across India.',
  },
})

if (zone.status >= 300) {
  console.error(`  Could not create the zone (${zone.status}) ${zone.json?.error?.message ?? ''}\n`)
  process.exit(1)
}

const zoneId = zone.json.data.zone.id
console.log(`  created zone "${wanted}"`)

const METHODS = [
  {
    name: 'Standard delivery',
    description: 'Complimentary across India. Made to order.',
    carrierRule: 'cheapest',
    rate: 0,
    position: 1,
    minDays: 15,
    maxDays: 20,
  },
  {
    name: 'Express delivery',
    description: 'The quickest courier serving your address.',
    carrierRule: 'fastest',
    // Charged only if the carrier cannot be reached; otherwise its own quote.
    rate: 35000,
    position: 2,
    minDays: 10,
    maxDays: 14,
  },
]

for (const spec of METHODS) {
  const made = await call(`/admin/shipping/zones/${zoneId}/methods`, {
    method: 'POST',
    body: { ...spec, isCod: false, isActive: true },
  })

  if (made.status >= 300) {
    console.error(
      `  "${spec.name}" failed (${made.status}) ${made.json?.error?.message ?? ''} — add it by hand in Admin → Shipping`,
    )
    continue
  }

  console.log(
    `  added "${spec.name}" — priced by the ${spec.carrierRule} courier, ` +
      `${spec.rate === 0 ? 'free' : `Rs${spec.rate / 100}`} if the carrier cannot be reached`,
  )
}

const check = await call('/shipping/quote?country=IN&postalCode=600090&subtotal=1650000&weightGrams=800')
const quote = check.json?.data
console.log(`\n  checkout for a Chennai address: ${quote?.serviceable ? 'open' : 'still closed'}`)
for (const m of quote?.methods ?? []) {
  console.log(`    ${m.name} — ${m.cost === 0 ? 'Free' : `₹${m.cost / 100}`}, ${m.minDays}–${m.maxDays} days`)
}
console.log()
