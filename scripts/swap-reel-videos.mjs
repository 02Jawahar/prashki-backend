/**
 * Replaces the reel videos with web-sized encodes, and nothing else.
 *
 * The originals on the homepage are 8-12 MB each. Nine of those is ~89 MB, and
 * the result is a showcase that never reaches playable and a film wall that
 * spends seconds buffering on every hover. These are the same films at 720p,
 * about 2 MB each.
 *
 * Deliberately narrow:
 *
 *   - Posters are NOT touched. They were chosen frame by frame to show a
 *     costume from each film, and a blind re-extract would throw that away.
 *   - Labels, eyebrow, heading and the caption on the film wall are left
 *     exactly as they are.
 *   - The old files are not deleted. Nothing is uploaded over them — the new
 *     encodes get their own names, so reverting is one settings write.
 *
 * Matching is by the reel number already in each URL rather than by position,
 * so re-ordering the homepage or the showcase cannot make this swap the wrong
 * film into the wrong tile.
 *
 *   node scripts/swap-reel-videos.mjs --base https://api.prashandki.in/api/v1 \
 *     --email you@example.com --password '…'
 *
 * Re-runnable: a second run uploads fresh copies and repoints at those. It
 * reports what it changed and what it left alone.
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
const DIR = flag('dir', 'E:/prashki-assets/web')
const EMAIL = flag('email', process.env.ADMIN_EMAIL ?? 'admin@example.com')
const PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? 'Admin@12345')
const DRY = args.includes('--dry-run')

/**
 * Production allows 60 writes a minute. Every upload and every patch counts,
 * and a script that trips the limiter reports failures it caused itself.
 */
const DELAY = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 100 : 1100

const SLUGS = ['01', '02', '03', '04', '05', '06', '07', '08', '09']

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

async function call(pathname, { method = 'GET', body, form } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retries the rate limiter rather than counting its refusals as failures. */
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

async function upload(file) {
  const r = await withRetry(path.basename(file), () => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([fs.readFileSync(file)], { type: 'video/mp4' }),
      path.basename(file),
    )
    return call('/admin/media', { method: 'POST', form })
  })
  if (r.status >= 300) {
    throw new Error(`${path.basename(file)} -> ${r.status} ${r.json?.error?.message ?? ''}`)
  }
  return r.json.data.url ?? r.json.data.file?.url
}

// ---------------------------------------------------------------- run

console.log(`\n  target ${BASE}`)
console.log(`  videos ${DIR}`)
if (DRY) console.log('  DRY RUN — nothing will be uploaded or written')
console.log()

for (const n of SLUGS) {
  const file = path.join(DIR, `reel-${n}.mp4`)
  if (!fs.existsSync(file)) {
    console.error(`  MISSING ${file}`)
    process.exit(1)
  }
  const mb = fs.statSync(file).size / 1048576
  if (mb > 5) {
    // The whole point of this script. A master here would be worse than doing
    // nothing, because it would look like it worked.
    console.error(`  reel-${n}.mp4 is ${mb.toFixed(1)} MB — that is not a web encode.`)
    process.exit(1)
  }
}

// A GET first, to pick up the CSRF cookie the login then has to echo.
await call('/')

const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) — ${login.json?.error?.message ?? ''}`)
  process.exit(1)
}

// ---- upload ----

const uploaded = {}
if (DRY) {
  // Stand-ins, so a dry run still exercises the matching below. Without them
  // every tile would report "left alone" and the preview would be a lie.
  for (const n of SLUGS) uploaded[n] = `https://example.invalid/reel-${n}-dryrun.mp4`
} else {
  for (const n of SLUGS) {
    const file = path.join(DIR, `reel-${n}.mp4`)
    uploaded[n] = await upload(file)
    const mb = (fs.statSync(file).size / 1048576).toFixed(2)
    console.log(`  uploaded reel-${n}  ${mb} MB`)
    await sleep(DELAY)
  }
  console.log()
}

/** Which reel a URL points at, or null if it is not one of ours. */
const reelOf = (url) => (typeof url === 'string' ? (url.match(/reel-(\d{2})-/)?.[1] ?? null) : null)

// ---- the film wall on the homepage ----

const settings = await call('/admin/settings')
const row = (settings.json?.data?.settings ?? []).find((s) => s.key === 'home.sections')
let sections = []
try {
  sections = JSON.parse(row?.value ?? '[]')
} catch {
  console.error('  home.sections is not valid JSON — stopping rather than overwriting it.')
  process.exit(1)
}

let gridSwapped = 0
let gridSkipped = 0
for (const section of sections) {
  if (section?.type !== 'video-grid' || !Array.isArray(section.items)) continue
  for (const item of section.items) {
    const n = reelOf(item.video)
    if (!n) {
      gridSkipped++
      continue
    }
    if (!uploaded[n]) {
      gridSkipped++
      continue
    }
    // Only the video. The poster beside it stays exactly as it is.
    item.video = uploaded[n]
    gridSwapped++
  }
}

if (!DRY && gridSwapped > 0) {
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
console.log(`  film wall: ${gridSwapped} swapped, ${gridSkipped} left alone`)

// ---- the showcase ----

const list = await call('/admin/showcase?limit=100')
const items = list.json?.data?.items ?? []

let wallSwapped = 0
let wallSkipped = 0
for (const item of items) {
  const n = reelOf(item.mediaUrl)
  if (!n || !uploaded[n]) {
    wallSkipped++
    continue
  }
  if (DRY) {
    wallSwapped++
    continue
  }
  // A partial patch: mediaUrl and nothing else, so posterUrl, credit, consent
  // and the linked products are untouched.
  const r = await withRetry(`showcase ${item.id}`, () =>
    call(`/admin/showcase/${item.id}`, { method: 'PATCH', body: { mediaUrl: uploaded[n] } }),
  )
  if (r.status !== 200) {
    console.error(`  showcase ${item.id} -> ${r.status} ${r.json?.error?.message ?? ''}`)
    process.exit(1)
  }
  wallSwapped++
  await sleep(DELAY)
}
console.log(`  showcase:  ${wallSwapped} swapped, ${wallSkipped} left alone`)

console.log(`\n  Posters, labels and captions were not touched.\n`)
