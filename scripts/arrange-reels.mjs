/**
 * Chooses which films sit in the homepage film wall, and puts the rest in the
 * showcase.
 *
 * Both places already hold the same nine films; this only decides which is
 * where. No upload, no re-encode, no new rows — it reads the video and poster
 * URLs already in use and moves the pairing around.
 *
 * A film keeps its own poster wherever it lands. The posters were chosen frame
 * by frame to show a costume from each film, and a film that moved from the
 * showcase to the wall carrying someone else's still would be worse than not
 * moving it.
 *
 *   node scripts/arrange-reels.mjs --wall 01,02,06,08 \
 *     --base https://api.prashandki.in/api/v1 --email … --password …
 *
 * Add --dry-run to see the arrangement without writing it.
 *
 * Re-runnable, and reversible by running it again with the previous list.
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

const WALL = flag('wall', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

if (WALL.length !== 4) {
  console.error('\n  --wall needs exactly four reel numbers, e.g. --wall 01,02,06,08\n')
  process.exit(1)
}

const DELAY = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 100 : 1100

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

/** Which reel a URL points at, or null if it is not one of ours. */
const reelOf = (url) => (typeof url === 'string' ? (url.match(/(reel-\d{2})-/)?.[1] ?? null) : null)

// ---------------------------------------------------------------- run

console.log(`\n  target ${BASE}`)
console.log(`  wall   ${WALL.join(', ')}`)
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) — ${login.json?.error?.message ?? ''}`)
  process.exit(1)
}

// ---- gather every film's media, wherever it currently lives ----

const settings = await call('/admin/settings')
const row = (settings.json?.data?.settings ?? []).find((s) => s.key === 'home.sections')
let sections = []
try {
  sections = JSON.parse(row?.value ?? '[]')
} catch {
  console.error('  home.sections is not valid JSON — stopping rather than overwriting it.')
  process.exit(1)
}

const grid = sections.find((s) => s?.type === 'video-grid' && Array.isArray(s.items))
if (!grid) {
  console.error('  No video-grid section on the homepage. Nothing to arrange.')
  process.exit(1)
}

/** reel -> { video, poster } */
const media = {}
for (const item of grid.items) {
  const reel = reelOf(item.video)
  if (reel) media[reel] = { video: item.video, poster: item.poster }
}

const list = await call('/admin/showcase?limit=100')
const showcase = list.json?.data?.items ?? []
for (const item of showcase) {
  const reel = reelOf(item.mediaUrl)
  if (reel) media[reel] = { video: item.mediaUrl, poster: item.posterUrl }
}

const known = Object.keys(media).sort()
console.log(`  films found: ${known.join(', ')}`)

const wanted = WALL.map((n) => `reel-${n}`)
const missing = wanted.filter((r) => !media[r])
if (missing.length) {
  console.error(`\n  Not found anywhere: ${missing.join(', ')} — stopping.\n`)
  process.exit(1)
}

// ---- the wall ----

const before = grid.items.map((i) => reelOf(i.video)).filter(Boolean)
grid.items = wanted.map((reel, index) => ({
  video: media[reel].video,
  poster: media[reel].poster,
  // Position, not identity: "Look 1" is the first tile whichever film it is.
  label: `Look ${index + 1}`,
  href: '/products',
}))

console.log(`  film wall: ${before.join(', ')}  ->  ${wanted.join(', ')}`)

if (!DRY) {
  const save = await withRetry('home.sections', () =>
    call('/admin/settings', {
      method: 'PATCH',
      body: { settings: [{ key: 'home.sections', value: JSON.stringify(sections) }] },
    }),
  )
  if (save.status !== 200) {
    console.error(`  Could not save home.sections (${save.status}) — ${save.json?.error?.message ?? ''}`)
    process.exit(1)
  }
  await sleep(DELAY)
}

// ---- the showcase gets the rest ----

const rest = known.filter((r) => !wanted.includes(r))
const showcaseReels = showcase.map((i) => reelOf(i.mediaUrl))

// Rows whose film has been promoted to the wall are the ones free to take on
// a film the wall gave up. Repointing rather than creating and deleting keeps
// the wall's ordering, the consent notes and the linked products intact.
const freed = showcase.filter((i) => wanted.includes(reelOf(i.mediaUrl)))
const incoming = rest.filter((r) => !showcaseReels.includes(r))

if (freed.length !== incoming.length) {
  console.error(
    `\n  ${freed.length} showcase rows freed but ${incoming.length} films need one — stopping rather than guessing.\n`,
  )
  process.exit(1)
}

for (let i = 0; i < freed.length; i++) {
  const item = freed[i]
  const reel = incoming[i]
  console.log(`  showcase:  ${reelOf(item.mediaUrl)}  ->  ${reel}`)
  if (DRY) continue

  const r = await withRetry(`showcase ${item.id}`, () =>
    call(`/admin/showcase/${item.id}`, {
      method: 'PATCH',
      // Poster moves with the film. Leaving the old one would put a still from
      // a different piece over this one.
      body: { mediaUrl: media[reel].video, posterUrl: media[reel].poster },
    }),
  )
  if (r.status !== 200) {
    console.error(`  showcase ${item.id} -> ${r.status} ${r.json?.error?.message ?? ''}`)
    process.exit(1)
  }
  await sleep(DELAY)
}

if (freed.length === 0) console.log('  showcase:  already correct')

console.log(`\n  Wall: ${wanted.join(', ')}`)
console.log(`  Showcase: ${rest.join(', ')}\n`)
