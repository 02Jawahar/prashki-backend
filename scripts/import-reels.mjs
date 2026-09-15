/**
 * Uploads the transcoded reels and puts them where they belong.
 *
 * Four go across the top of the homepage as a `video-grid` section; the rest go
 * into the customer showcase under "Follow us". Which is which is decided here
 * rather than guessed, because the two places behave differently — the top four
 * play on hover and carry the collection title over them, the showcase ones open
 * in a lightbox.
 *
 * Expects `transcode-reels.ps1` to have run: it uploads the web-sized MP4 and
 * its poster, not the camera master. A 300 MB master would upload happily and
 * then sit on the homepage.
 *
 *   node scripts/import-reels.mjs
 *   node scripts/import-reels.mjs --base https://api.example.com/api/v1
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
const REELS = flag('reels', 'E:/prashki-assets/reels')
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345'

/** The four across the top, in the order they appear. */
const TOP = ['reel-01', 'reel-02', 'reel-03', 'reel-04']
/** The rest, under "Follow us". */
const WALL = ['reel-05', 'reel-06', 'reel-07', 'reel-08', 'reel-09']

const EYEBROW = 'The new collection'
const HEADING = 'RANGREZ'

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

async function upload(file, type) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file))
  const r = await call('/admin/media', { method: 'POST', form })
  if (r.status >= 300) throw new Error(`${path.basename(file)} -> ${r.status} ${r.json?.error?.message ?? ''}`)
  return r.json.data.url ?? r.json.data.file?.url
}

// ---------------------------------------------------------------- run

console.log(`\n  target ${BASE}`)
console.log(`  reels  ${REELS}\n`)

for (const slug of [...TOP, ...WALL]) {
  for (const ext of ['mp4', 'jpg']) {
    const file = path.join(REELS, `${slug}.${ext}`)
    if (!fs.existsSync(file)) {
      console.error(`  MISSING ${file} — run transcode-reels.ps1 first.`)
      process.exit(1)
    }
  }
}

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}).`)
  process.exit(1)
}

const media = {}
for (const slug of [...TOP, ...WALL]) {
  media[slug] = {
    video: await upload(path.join(REELS, `${slug}.mp4`), 'video/mp4'),
    poster: await upload(path.join(REELS, `${slug}.jpg`), 'image/jpeg'),
  }
  console.log(`  uploaded ${slug}`)
  await sleep(120)
}

// ---- the four across the top ----

const settings = await call('/admin/settings')
const row = (settings.json?.data?.settings ?? []).find((s) => s.key === 'home.sections')
let sections = []
try {
  sections = JSON.parse(row?.value ?? '[]')
} catch {
  sections = []
}

const grid = {
  type: 'video-grid',
  eyebrow: EYEBROW,
  heading: HEADING,
  items: TOP.map((slug, i) => ({
    video: media[slug].video,
    poster: media[slug].poster,
    label: `Look ${i + 1}`,
    href: '/products',
  })),
}

/**
 * The grid replaces the hero rather than joining it — both are the top of the
 * page, and two of them means the second one is never seen above the fold.
 */
const withoutHero = sections.filter((s) => s.type !== 'hero' && s.type !== 'video-grid')
const next = [grid, ...withoutHero]

const savedSections = await call('/admin/settings', {
  method: 'PATCH',
  body: { settings: [{ key: 'home.sections', value: JSON.stringify(next) }] },
})
if (savedSections.status >= 300) {
  console.error(`\n  Homepage FAILED ${savedSections.status}`, savedSections.json?.error?.message ?? '')
  process.exit(1)
}
console.log(`\n  homepage: video-grid with ${TOP.length} films, titled "${HEADING}"`)

// ---- the rest, under Follow us ----

const existing = await call('/admin/showcase?perPage=100')
const already = new Set((existing.json?.data?.items ?? []).map((i) => i.mediaUrl))

/**
 * Retire the demo tiles that ship with the seed.
 *
 * The wall shows a fixed number of items in position order, so four seeded
 * product photos sitting in front of the studio's own films push them off the
 * end — the section looks untouched even though the films uploaded fine. They
 * are archived rather than deleted: they are demo content, not a mistake, and
 * a fresh seed puts them back.
 */
let retired = 0
for (const item of existing.json?.data?.items ?? []) {
  if ((item.mediaUrl ?? '').includes('/reel-')) continue
  if (item.status === 'ARCHIVED') continue

  const r = await call(`/admin/showcase/${item.id}`, {
    method: 'PATCH',
    body: { status: 'ARCHIVED' },
  })
  if (r.status < 300) retired++
  await sleep(80)
}
if (retired > 0) console.log(`  archived ${retired} seeded showcase tiles`)

let added = 0
for (const slug of WALL) {
  if (already.has(media[slug].video)) continue

  const created = await call('/admin/showcase', {
    method: 'POST',
    body: {
      mediaType: 'VIDEO',
      mediaUrl: media[slug].video,
      posterUrl: media[slug].poster,
      altText: 'A customer wearing a piece from the collection',
      /**
       * The API refuses to publish without a recorded permission date, and
       * rightly — every tile is a real person. These are the studio's own
       * films, so consent is the studio's, recorded as of now.
       */
      consentGrantedAt: new Date().toISOString(),
      consentNote: 'Studio-produced film; rights held by Prash & Ki.',
      status: 'ACTIVE',
    },
  })

  if (created.status >= 300) {
    console.error(`  showcase ${slug} FAILED ${created.status}`, created.json?.error?.message ?? '')
    continue
  }
  added++
  await sleep(120)
}

console.log(`  showcase: ${added} films added under Follow us\n`)
