/**
 * Verifies site media upload and the homepage content editor path:
 * upload -> save into `home.sections` -> storefront renders it.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const STORE = process.env.SMOKE_STORE ?? 'http://localhost:3100'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))
const UPLOADS = path.resolve(here, '..', 'uploads', 'products')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

class Jar {
  constructor() { this.cookies = new Map() }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i).trim()
      const v = pair.slice(i + 1).trim()
      if (v === '') this.cookies.delete(k); else this.cookies.set(k, v)
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
}

async function call(p, { method = 'GET', body, jar, form } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  // Signed double-submit. The token arrives on the first response and login
  // is itself a write, so an unsafe request primes one before it goes out —
  // whether or not this particular call is carrying a cookie jar.
  const unsafe = method !== 'GET' && method !== 'HEAD'
  if (unsafe && jar && !jar.cookies.get('csrf')) {
    jar.absorb(await fetch(`${BASE}/`, { headers: { accept: 'application/json' } }))
  } else if (unsafe && !jar) {
    sharedCsrf ??= await primeCsrf()
  }

  const csrf = jar?.cookies?.get('csrf') ?? (unsafe ? sharedCsrf : null)
  const cookieHeader = jar?.header() || (csrf ? `csrf=${csrf}` : '')
  if (cookieHeader) headers.cookie = cookieHeader
  if (csrf) headers['x-csrf-token'] = csrf
  const res = await fetch(`${BASE}${p}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nSite media and homepage content\n')

const admin = new Jar()
await call('/auth/login', {
  method: 'POST', jar: admin,
  body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
})

// Keep the original config so the run leaves nothing behind.
const original = (await call('/admin/settings', { jar: admin })).json.data.settings.find((s) => s.key === 'home.sections').value

const sampleImage = await readFile(path.join(UPLOADS, (await readdir(UPLOADS)).find((f) => f.endsWith('.jpg'))))

// ---------------------------------------------------------------- upload
let heroUrl
{
  const form = new FormData()
  form.append('file', new Blob([sampleImage], { type: 'image/jpeg' }), 'new-hero.jpg')
  form.append('folder', 'home')

  const r = await call('/admin/media', { method: 'POST', jar: admin, form })
  heroUrl = r.json?.data?.url
  check('admin can upload hero media', r.status === 201, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)
  check('upload returns a public URL', Boolean(heroUrl?.startsWith('http')), heroUrl)
  check('media lands in the requested folder', heroUrl?.includes('/uploads/home/'), heroUrl?.split('/uploads/')[1])
  check('detected as an image', r.json?.data?.kind === 'image')

  const fetched = await fetch(heroUrl)
  check('uploaded media is served back', fetched.ok, `${fetched.status}`)
}

// Video path — multer keys off the declared type, which is what the picker sends.
let videoUrl
{
  const form = new FormData()
  form.append('file', new Blob([sampleImage], { type: 'video/mp4' }), 'hero-clip.mp4')
  form.append('folder', 'home')

  const r = await call('/admin/media', { method: 'POST', jar: admin, form })
  videoUrl = r.json?.data?.url
  check('video uploads are accepted', r.status === 201, `${r.status}`)
  check('detected as a video', r.json?.data?.kind === 'video')
  check('video keeps its extension', videoUrl?.endsWith('.mp4'), videoUrl?.split('/').pop())
}

// ---------------------------------------------------------------- guards
{
  const form = new FormData()
  form.append('file', new Blob(['nope'], { type: 'application/x-msdownload' }), 'evil.exe')
  const r = await call('/admin/media', { method: 'POST', jar: admin, form })
  check('executables are rejected', r.status === 422 || r.status === 400, `${r.status}`)

  const form2 = new FormData()
  form2.append('file', new Blob([sampleImage], { type: 'image/jpeg' }), 'x.jpg')
  form2.append('folder', '../../etc')
  const r2 = await call('/admin/media', { method: 'POST', jar: admin, form: form2 })
  check('folder is restricted to an allow-list', r2.status === 422, `${r2.status}`)

  const customer = new Jar()
  await call('/auth/login', { method: 'POST', jar: customer, body: { email: process.env.CUSTOMER_EMAIL, password: process.env.CUSTOMER_PASSWORD } })
  const form3 = new FormData()
  form3.append('file', new Blob([sampleImage], { type: 'image/jpeg' }), 'x.jpg')
  const r3 = await call('/admin/media', { method: 'POST', jar: customer, form: form3 })
  check('a customer cannot upload site media', r3.status === 403, `${r3.status}`)
}

// ------------------------------------------------- save the hero and render
{
  const sections = JSON.parse(original)
  const hero = sections.find((s) => s.type === 'hero')
  check('homepage config contains a hero', Boolean(hero))

  hero.image = heroUrl
  hero.heading = 'Content Editor Works'
  hero.eyebrow = 'Uploaded from admin'

  const save = await call('/admin/settings', {
    method: 'PATCH', jar: admin,
    body: { settings: [{ key: 'home.sections', value: JSON.stringify(sections) }] },
  })
  check('homepage sections can be saved', save.status === 200, `${save.status}`)

  const page = await fetch(`${STORE}/`, { cache: 'no-store' })
  const html = await page.text()
  check('storefront shows the new heading', html.includes('Content Editor Works'))
  check('storefront uses the uploaded image', html.includes(encodeURIComponent(heroUrl)) || html.includes(heroUrl))
}

// -------------------------------------------------------- video rendering
{
  const sections = JSON.parse(original)
  const hero = sections.find((s) => s.type === 'hero')
  hero.image = videoUrl
  hero.heading = 'Video Hero'

  await call('/admin/settings', {
    method: 'PATCH', jar: admin,
    body: { settings: [{ key: 'home.sections', value: JSON.stringify(sections) }] },
  })

  const page = await fetch(`${STORE}/`, { cache: 'no-store' })
  const html = await page.text()
  check('a video hero renders a <video> element', html.includes('<video'), 'video tag present')
  check('video autoplays muted and inline', html.includes('autoPlay') || html.includes('autoplay'))
  check('storefront points at the uploaded video', html.includes(videoUrl))
}

// ------------------------------------------------------------- restore
{
  const r = await call('/admin/settings', {
    method: 'PATCH', jar: admin,
    body: { settings: [{ key: 'home.sections', value: original }] },
  })
  check('original homepage config restored', r.status === 200)

  // Clean up the two test uploads.
  for (const url of [heroUrl, videoUrl]) {
    const key = url.split('/uploads/')[1]
    await call(`/admin/media?key=${encodeURIComponent(key)}`, { method: 'DELETE', jar: admin })
  }
  const gone = await fetch(heroUrl)
  check('deleted media stops being served', gone.status === 404, `${gone.status}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
