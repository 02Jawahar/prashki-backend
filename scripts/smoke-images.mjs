/**
 * Verifies the product image workflow (spec §12): upload through the storage
 * provider, reorder, delete — plus the permission and file-type guards.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
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

/** A CSRF token for calls made without a cookie jar. Fetched once. */
let sharedCsrf = null
async function primeCsrf() {
  const res = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
  return cookie ? cookie.split(';')[0].slice('csrf='.length) : null
}
async function call(path, { method = 'GET', body, jar, form } = {}) {
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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  })
  jar?.absorb(res)
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\nProduct images\n')

const admin = new Jar()
await call('/auth/login', {
  method: 'POST', jar: admin,
  body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
})

// Use a real JPEG that already exists in storage as the upload payload.
const existing = (await readdir(UPLOADS)).filter((f) => f.endsWith('.jpg'))
const sampleBytes = await readFile(path.join(UPLOADS, existing[0]))
check('found a sample image to upload', sampleBytes.length > 1000, `${existing[0]} (${Math.round(sampleBytes.length / 1024)} KB)`)

// Needs a product that already has several images, otherwise the "incomplete
// reorder list" guard can't be exercised — a one-item list would be complete.
const products = await call('/admin/products?perPage=48', { jar: admin })
let productId = null
let before = null
for (const p of products.json.data.products) {
  const detail = await call(`/admin/products/${p.id}`, { jar: admin })
  if (detail.json.data.product.images.length >= 2) {
    productId = p.id
    before = detail
    break
  }
}
const countBefore = before?.json.data.product.images.length ?? 0
check('picked a product with existing images', countBefore >= 2, `${before?.json.data.product.name} (${countBefore} images)`)

// ------------------------------------------------------------- upload
let uploadedId
{
  const form = new FormData()
  form.append('images', new Blob([sampleBytes], { type: 'image/jpeg' }), 'admin-upload-test.jpg')

  const r = await call(`/admin/products/${productId}/images`, { method: 'POST', jar: admin, form })
  check('admin can upload an image', r.status === 201, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)

  const image = r.json?.data?.images?.[0]
  uploadedId = image?.id
  check('image row created with a public URL', Boolean(image?.url?.startsWith('http')), image?.url)

  // The storage provider must generate its own filename, not trust the client's.
  check(
    'stored filename is generated, not the uploaded name',
    Boolean(image?.url) && !image.url.endsWith('admin-upload-test.jpg') && image.url.includes('admin-upload-test-'),
    image?.url?.split('/').pop(),
  )

  const fetched = await fetch(image.url)
  check('uploaded image is served back', fetched.ok && fetched.headers.get('content-type')?.startsWith('image/'), `${fetched.status}`)

  const after = await call(`/admin/products/${productId}`, { jar: admin })
  check('product now has one more image', after.json.data.product.images.length === countBefore + 1)
  check('new image is appended last, not made primary', after.json.data.product.images.at(-1).id === uploadedId)
}

// ------------------------------------------------------------ reorder
{
  const current = (await call(`/admin/products/${productId}`, { jar: admin })).json.data.product.images
  const reordered = [uploadedId, ...current.filter((i) => i.id !== uploadedId).map((i) => i.id)]

  const r = await call(`/admin/products/${productId}/images/order`, {
    method: 'PATCH', jar: admin, body: { imageIds: reordered },
  })
  check('admin can reorder images', r.status === 200, `${r.status}`)
  check('the moved image is now primary', r.json?.data?.product?.images?.[0]?.id === uploadedId)

  // A partial list must be refused — it would silently drop images.
  const partial = await call(`/admin/products/${productId}/images/order`, {
    method: 'PATCH', jar: admin, body: { imageIds: [uploadedId] },
  })
  check('an incomplete reorder list is rejected', partial.status === 422, `${partial.status}`)
}

// ------------------------------------------------------------- guards
{
  const form = new FormData()
  form.append('images', new Blob(['#!/bin/sh\necho hi'], { type: 'text/plain' }), 'evil.sh')
  const r = await call(`/admin/products/${productId}/images`, { method: 'POST', jar: admin, form })
  check('non-image uploads are rejected', r.status === 422 || r.status === 400, `${r.status} ${r.json?.error?.code}`)

  const customer = new Jar()
  await call('/auth/login', { method: 'POST', jar: customer, body: { email: process.env.CUSTOMER_EMAIL, password: process.env.CUSTOMER_PASSWORD } })
  const form2 = new FormData()
  form2.append('images', new Blob([sampleBytes], { type: 'image/jpeg' }), 'x.jpg')
  const r2 = await call(`/admin/products/${productId}/images`, { method: 'POST', jar: customer, form: form2 })
  check('a customer cannot upload product images', r2.status === 403, `${r2.status}`)
}

// -------------------------------------------------------------- delete
{
  const r = await call(`/admin/products/${productId}/images/${uploadedId}`, { method: 'DELETE', jar: admin })
  check('admin can delete an image', r.status === 204, `${r.status}`)

  const after = await call(`/admin/products/${productId}`, { jar: admin })
  check('image count back to where it started', after.json.data.product.images.length === countBefore)
  check('the original images survived', after.json.data.product.images.every((i) => i.id !== uploadedId))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
