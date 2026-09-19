/**
 * Replaces the still behind the feature film on the homepage.
 *
 * The poster is the first frame anyone sees — it sits there while the video
 * holds off loading, and on a phone that refuses autoplay it is the *only*
 * thing they see. So it is worth being a chosen frame rather than whatever
 * the encoder happened to leave at second zero.
 *
 * The frame is pulled from the film itself at full resolution rather than
 * from a screenshot, so it matches the video's own 1920x824 exactly — no
 * letterboxing, no rounded corners, no second round of compression.
 *
 *   node scripts/set-film-poster.mjs --file path/to/poster.jpg \
 *     --base https://api.prashandki.in/api/v1 --email … --password …
 *
 * Re-runnable, and it prints the poster it is replacing so the old URL can be
 * put back by hand if the new frame turns out to be the wrong one.
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
const EMAIL = flag('email', process.env.ADMIN_EMAIL ?? 'admin@example.com')
const PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? 'Admin@12345')
const FILE = flag('file', null)
const DRY = args.includes('--dry-run')

if (!FILE || !fs.existsSync(FILE)) {
  console.error(`\n  --file is required and must exist${FILE ? `: ${FILE}` : ''}\n`)
  process.exit(1)
}

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

console.log(`\n  target ${BASE}`)
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) ${login.json?.error?.message ?? ''}\n`)
  process.exit(1)
}

// ── find the film band, whatever position it sits at ────────────────────────

/**
 * Read through the admin endpoint rather than the public one, because that is
 * where the write goes: the admin side stores each setting as a row whose
 * `value` is a JSON string, and round-tripping the public endpoint's
 * already-parsed shape is how a re-encode quietly drops a field.
 */
const settings = await call('/admin/settings')
const rows = settings.json?.data?.settings ?? []
const row = rows.find((r) => r.key === 'home.sections')

if (!row) {
  console.error('  There is no home.sections setting to update.
')
  process.exit(1)
}

let sections
try {
  sections = JSON.parse(row.value)
} catch {
  console.error('  home.sections is not valid JSON - refusing to overwrite it.
')
  process.exit(1)
}

if (!Array.isArray(sections)) {
  console.error('  home.sections is not a list of sections - nothing to update.
')
  process.exit(1)
}

const index = sections.findIndex((s) => s?.type === 'film-band')
if (index < 0) {
  console.error(`  No film-band section on the homepage. Found: ${sections.map((s) => s?.type).join(', ')}\n`)
  process.exit(1)
}

const film = sections[index]
console.log(`  film-band is section [${index}]`)
console.log(`    video   ${film.video}`)
console.log(`    poster  ${film.poster}   <- replacing this`)
console.log()

// ── upload the new still ───────────────────────────────────────────────────

const bytes = fs.readFileSync(FILE)
console.log(`  uploading ${path.basename(FILE)} (${Math.round(bytes.length / 1024)} KB)`)

if (DRY) {
  console.log('  would upload, then point the film band at the new URL\n')
  process.exit(0)
}

const form = new FormData()
form.append('file', new Blob([bytes], { type: 'image/jpeg' }), path.basename(FILE))
const uploaded = await call('/admin/media', { method: 'POST', form })

if (uploaded.status >= 300) {
  console.error(`  Upload failed (${uploaded.status}) ${uploaded.json?.error?.message ?? ''}\n`)
  process.exit(1)
}

const url = uploaded.json?.data?.url ?? uploaded.json?.data?.file?.url
if (!url) {
  console.error(`  Upload returned no URL: ${JSON.stringify(uploaded.json).slice(0, 200)}\n`)
  process.exit(1)
}
console.log(`    -> ${url}`)

// ── point the film band at it ──────────────────────────────────────────────

const next = sections.map((s, i) => (i === index ? { ...s, poster: url } : s))

const value = JSON.stringify(next)

/**
 * The column caps at 20,000 characters. A homepage that has grown past it
 * would otherwise fail validation with nothing said about why - after the
 * image has already been uploaded.
 */
if (value.length > 20_000) {
  console.error(`
home.sections would be ${value.length} characters, over the 20,000 limit.`)
  console.error(`  The image is uploaded at ${url} - set it by hand in Admin -> Homepage.
`)
  process.exit(1)
}

// PATCH, and rows rather than a keyed object - that is the contract.
const saved = await call('/admin/settings', {
  method: 'PATCH',
  body: { settings: [{ key: 'home.sections', value }] },
})

if (saved.status >= 300) {
  console.error(`\n  Could not save (${saved.status}) ${saved.json?.error?.message ?? ''}`)
  console.error(`  The image is uploaded at ${url} — set it by hand in Admin -> Homepage.\n`)
  process.exit(1)
}

// ── confirm from the public endpoint, not from our own request ─────────────

const check = await call('/settings')
const live = (check.json?.data?.settings?.['home.sections'] ?? []).find((s) => s?.type === 'film-band')

console.log()
if (live?.poster === url) {
  console.log(`  the feature film now opens on this frame`)
  console.log(`    ${url}\n`)
} else {
  console.log(`  saved, but the public settings still read ${live?.poster ?? 'nothing'} — check for a cache.\n`)
}
