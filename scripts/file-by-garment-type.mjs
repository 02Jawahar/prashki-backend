/**
 * Files every piece under its garment type, within the range it already sells in.
 *
 * The four ranges — Casuals, Pret, Luxury Pret, Bridal — each carry the same
 * sub-categories the catalogue was built with, but every product was left on
 * the range itself, so all sixteen sat empty and no "Dresses" link could work.
 *
 * A product's range does not change. `look-24` is Casuals before and after;
 * it simply moves from "Casuals" to "Casuals → Long Dresses". That matters,
 * because `?category=casuals` already matches everything beneath Casuals, so
 * the Women's menu and the range filters carry on unchanged.
 *
 *   node scripts/file-by-garment-type.mjs --base https://api.prashandki.in/api/v1 \
 *     --email … --password …
 *
 * Add --dry-run to see the moves. Re-runnable: a piece already filed correctly
 * is left alone, so a second run writes nothing.
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
const FILE = flag('file', path.join(here, 'product-garment-type.json'))
const EMAIL = flag('email', process.env.ADMIN_EMAIL ?? 'admin@example.com')
const PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? 'Admin@12345')
const DRY = args.includes('--dry-run')

const DELAY = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 80 : 1100

/** The ranges a piece can already be in. Anything else is a surprise worth stopping for. */
const RANGES = ['casuals', 'pret', 'luxury-pret', 'bridal']

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

// ---------------------------------------------------------------- run

const types = JSON.parse(fs.readFileSync(FILE, 'utf8')).types

console.log(`\n  target ${BASE}`)
console.log(`  types  ${FILE} — ${Object.keys(types).length} pieces`)
if (DRY) console.log('  DRY RUN — nothing will be written')
console.log()

await call('/')
const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
if (login.status !== 200) {
  console.error(`  Login failed (${login.status}) — ${login.json?.error?.message ?? ''}`)
  process.exit(1)
}

const cats = await call('/admin/categories?perPage=100')
const catList = cats.json?.data?.categories ?? cats.json?.data ?? []
const catBySlug = new Map(catList.map((c) => [c.slug, c]))

const products = []
for (let page = 1; ; page++) {
  const r = await call(`/admin/products?perPage=48&page=${page}`)
  const batch = r.json?.data?.products ?? []
  if (!batch.length) break
  products.push(...batch)
  if (batch.length < 48) break
}

// Work out every move before making any of them, so a missing sub-category
// stops the run rather than leaving the catalogue half-filed.
const planned = []
const problems = []

for (const [slug, type] of Object.entries(types)) {
  const product = products.find((p) => p.slug === slug)
  if (!product) {
    problems.push(`${slug}: no such product`)
    continue
  }

  const current = product.category?.slug ?? null
  // Already filed under a sub-category? Then the range is its parent.
  const range = RANGES.includes(current)
    ? current
    : RANGES.find((r) => current?.startsWith(`${r}-`))

  if (!range) {
    problems.push(`${slug}: in "${current}", which is not one of the ranges`)
    continue
  }

  const target = `${range}-${type}`
  const category = catBySlug.get(target)
  if (!category) {
    problems.push(`${slug}: ${range} has no "${type}" — expected ${target}`)
    continue
  }

  if (current === target) continue
  planned.push({ slug, id: product.id, from: current, to: target, categoryId: category.id })
}

if (problems.length) {
  console.error('  Stopping — the plan does not hold:\n')
  for (const p of problems) console.error(`    ${p}`)
  console.error('\n  Nothing was written.\n')
  process.exit(1)
}

console.log(`  ${planned.length} to file, ${Object.keys(types).length - planned.length} already correct\n`)

const counts = {}
for (const move of planned) counts[move.to] = (counts[move.to] ?? 0) + 1
for (const [slug, n] of Object.entries(counts).sort()) console.log(`    ${slug.padEnd(28)} ${n}`)
console.log()

if (DRY) process.exit(0)

let done = 0
for (const move of planned) {
  const r = await withRetry(move.slug, () =>
    call(`/admin/products/${move.id}`, { method: 'PATCH', body: { categoryId: move.categoryId } }),
  )
  if (r.status !== 200) {
    console.error(`  ${move.slug} -> ${r.status} ${r.json?.error?.message ?? ''}`)
    process.exit(1)
  }
  done++
  if (done % 10 === 0) console.log(`  ${done}/${planned.length} filed…`)
  await sleep(DELAY)
}

console.log(`\n  ${done} filed.\n`)
