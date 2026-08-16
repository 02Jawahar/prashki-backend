/**
 * The customer showcase — the "as worn by you" wall.
 *
 * The assertions worth having here are not the CRUD ones. They are the guards:
 *
 *   - nothing publishes without a recorded permission date, by any route,
 *     including scheduling round the front of it
 *   - a video cannot go live without a poster
 *   - the public endpoint never leaks how permission was obtained
 *   - a product that is not ACTIVE drops out of "shop this look" rather than
 *     linking to a page the customer cannot reach
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const SUPER = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
}
const CUSTOMER = {
  email: process.env.CUSTOMER_EMAIL ?? 'customer@example.com',
  password: process.env.CUSTOMER_PASSWORD ?? 'Customer@12345',
}

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
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

let sharedCsrf = null
async function primeCsrf() {
  const res = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
  return cookie ? cookie.split(';')[0].slice('csrf='.length) : null
}

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
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
    body: body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: res.status, json }
}

async function signIn(email, password) {
  const jar = new Jar()
  const r = await call('/auth/login', { method: 'POST', jar, body: { email, password } })
  return r.status === 200 ? jar : null
}

console.log('\nCustomer showcase — the homepage wall\n')

const superAdmin = await signIn(SUPER.email, SUPER.password)
if (!superAdmin) {
  console.log('Cannot continue without the super admin session.')
  process.exit(1)
}

// A real product to attach, so "shop this look" is exercised properly.
const catalogue = await call('/products?perPage=2')
const product = catalogue.json?.data?.products?.[0]
check('a product is available to attach', Boolean(product), product?.slug ?? 'none')

const VIDEO = '/uploads/home/demo-clip.mp4'
const POSTER = '/uploads/home/demo-poster.jpg'

/**
 * Every item this suite creates, with the status it ended up in.
 *
 * Tracked rather than assumed: several of these are deliberately published, so
 * "everything except the last one is a draft" would be wrong — and wrong in the
 * direction that reports a passing wall as a leak.
 */
const created = []
async function createItem(overrides = {}) {
  const r = await call('/admin/showcase', {
    method: 'POST',
    jar: superAdmin,
    body: {
      mediaType: 'VIDEO',
      mediaUrl: VIDEO,
      altText: 'A customer wearing the piece',
      ...overrides,
    },
  })
  const item = r.json?.data?.item
  if (item?.id) created.push({ id: item.id, status: item.status })
  return r
}

/** Ids of everything this suite created that is not published. */
const unpublishedIds = () =>
  created.filter((item) => item.status !== 'ACTIVE').map((item) => item.id)

// ══════════════════════════════════════ the permission guard
section('Permission  Nothing publishes without a recorded yes')

{
  const r = await createItem({ status: 'ACTIVE', posterUrl: POSTER })
  check('publishing without permission is refused', r.status === 422, `status ${r.status}`)
  check(
    'the error explains why',
    /permission/i.test(r.json?.error?.message ?? ''),
    r.json?.error?.message ?? 'none',
  )
}

{
  // Scheduling is the way round the front door — the same guard must apply.
  const r = await createItem({
    status: 'SCHEDULED',
    posterUrl: POSTER,
    scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
  })
  check('scheduling without permission is refused too', r.status === 422, `status ${r.status}`)
}

{
  const r = await createItem({
    status: 'ACTIVE',
    posterUrl: POSTER,
    consentGrantedAt: new Date().toISOString(),
    consentNote: 'Replied yes to our comment',
  })
  check('with permission it publishes', r.status === 201, `status ${r.status}`)
}

{
  // The guard has to consider the row as it will be, not the patch that
  // arrived — clearing consent then publishing must not slip through.
  const draft = await createItem({
    status: 'DRAFT',
    posterUrl: POSTER,
    consentGrantedAt: new Date().toISOString(),
  })
  const id = draft.json?.data?.item?.id

  const cleared = await call(`/admin/showcase/${id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { consentGrantedAt: null },
  })
  check('permission can be withdrawn on a draft', cleared.status === 200, `status ${cleared.status}`)

  const publish = await call(`/admin/showcase/${id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'ACTIVE' },
  })
  check(
    'publishing after withdrawal is refused',
    publish.status === 422,
    `status ${publish.status}`,
  )
}

// ══════════════════════════════════════ the poster guard
section('Performance  A video needs a poster before it goes live')

{
  const r = await createItem({
    status: 'ACTIVE',
    consentGrantedAt: new Date().toISOString(),
  })
  check('a video without a poster is refused', r.status === 422, `status ${r.status}`)
  check(
    'the error names the poster',
    /poster/i.test(r.json?.error?.message ?? ''),
    r.json?.error?.message ?? 'none',
  )
}

{
  // A photo is its own poster, so the rule does not apply to it.
  const r = await createItem({
    mediaType: 'IMAGE',
    mediaUrl: '/uploads/home/demo-photo.jpg',
    status: 'ACTIVE',
    consentGrantedAt: new Date().toISOString(),
  })
  check('a photo needs no poster', r.status === 201, `status ${r.status}`)
}

// ══════════════════════════════════════ validation
section('Validation  What the API refuses to store')

{
  const r = await createItem({ altText: '' })
  check('an empty description is refused', r.status === 422, `status ${r.status}`)
}

{
  const r = await createItem({ mediaUrl: 'javascript:alert(1)' })
  check('a non-URL media source is refused', r.status === 422, `status ${r.status}`)
}

{
  const r = await createItem({ productIds: ['does-not-exist'] })
  check('an unknown product is refused', r.status === 422, `status ${r.status}`)
}

{
  const r = await createItem({
    status: 'SCHEDULED',
    posterUrl: POSTER,
    consentGrantedAt: new Date().toISOString(),
  })
  check('scheduling with no date is refused', r.status === 422, `status ${r.status}`)
}

{
  // Handles are stored bare so the storefront can render the @ itself.
  const r = await createItem({
    creditHandle: '@ananya.wears',
    posterUrl: POSTER,
  })
  check(
    'a leading @ is stripped from the handle',
    r.json?.data?.item?.creditHandle === 'ananya.wears',
    r.json?.data?.item?.creditHandle ?? 'none',
  )
}

// ══════════════════════════════════════ the public wall
section('Storefront  What the wall exposes, and what it does not')

let liveId = null
{
  const r = await createItem({
    status: 'ACTIVE',
    posterUrl: POSTER,
    consentGrantedAt: new Date().toISOString(),
    consentNote: 'DM screenshot on file',
    sourceUrl: 'https://example.com/a-post',
    creditName: 'Test Customer',
    productIds: product ? [product.id] : [],
  })
  liveId = r.json?.data?.item?.id
  check('a live item is created', r.status === 201, `status ${r.status}`)
}

{
  const r = await call('/showcase')
  check('the wall is public', r.status === 200, `status ${r.status}`)

  const items = r.json?.data?.items ?? []
  check('it returns the live items', items.length > 0, `${items.length} items`)

  const serialised = JSON.stringify(items)
  check('it does not leak the consent note', !serialised.includes('DM screenshot on file'))
  check('it does not leak the source URL', !serialised.includes('example.com/a-post'))
  check('it does not leak consentGrantedAt', !/consentGrantedAt/.test(serialised))

  const mine = items.find((i) => i.id === liveId)
  check('the live item is on the wall', Boolean(mine))
  check('it carries the credit name', mine?.creditName === 'Test Customer', mine?.creditName ?? 'none')
  if (product) {
    check(
      'the attached product is shoppable',
      mine?.products?.[0]?.slug === product.slug,
      mine?.products?.[0]?.slug ?? 'none',
    )
    check('the product carries a price', typeof mine?.products?.[0]?.price === 'number')
  }
}

{
  // A draft is work in progress — often a face we do not yet have permission
  // for. It must never appear on the storefront.
  const onWall = new Set((await call('/showcase?limit=24')).json?.data?.items?.map((i) => i.id) ?? [])
  const hidden = unpublishedIds()
  const leaked = hidden.filter((id) => onWall.has(id))

  check('there are unpublished items to check', hidden.length > 0, `${hidden.length} drafts`)
  check(
    'unpublished items are not on the wall',
    leaked.length === 0,
    leaked.length > 0 ? `${leaked.length} leaked` : `${hidden.length} correctly hidden`,
  )
}

{
  const r = await call('/showcase?limit=1')
  check('the limit is honoured', (r.json?.data?.items ?? []).length === 1)

  const bad = await call('/showcase?limit=999')
  check('an absurd limit is refused', bad.status === 422, `status ${bad.status}`)
}

// ══════════════════════════════════════ unpublished products drop out
section('Storefront  A piece that is not for sale drops out of the look')

if (product) {
  const before = await call('/showcase')
  const withProduct = (before.json?.data?.items ?? []).find((i) => i.id === liveId)
  check('the look has the product to begin with', withProduct?.products?.length === 1)

  await call(`/admin/products/${product.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'DRAFT' },
  })

  const after = await call('/showcase')
  const without = (after.json?.data?.items ?? []).find((i) => i.id === liveId)
  check(
    'unpublishing the product removes it from the look',
    without?.products?.length === 0,
    `${without?.products?.length ?? '?'} products`,
  )
  check('the showcase item itself survives', Boolean(without))

  // Put it back so the rest of the suite sees the seeded catalogue.
  await call(`/admin/products/${product.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'ACTIVE' },
  })
}

// ══════════════════════════════════════ ordering
section('Ordering  The wall is arranged, not arbitrary')

// Captured so the seeded wall can be put back the way it was found — this
// suite runs against the demo data everything else renders from.
let originalOrder = []

{
  const list = await call('/admin/showcase', { jar: superAdmin })
  const ids = (list.json?.data?.items ?? []).map((i) => i.id)
  originalOrder = ids
  check('the admin list is ordered by position', ids.length > 1)

  const reversed = [...ids].reverse()
  const r = await call('/admin/showcase/reorder', {
    method: 'PATCH',
    jar: superAdmin,
    body: { ids: reversed },
  })
  check('the order can be rewritten', r.status === 200, `status ${r.status}`)

  const after = await call('/admin/showcase', { jar: superAdmin })
  const afterIds = (after.json?.data?.items ?? []).map((i) => i.id)
  check('the new order stuck', afterIds[0] === reversed[0], afterIds[0] ?? 'none')

  const bogus = await call('/admin/showcase/reorder', {
    method: 'PATCH',
    jar: superAdmin,
    body: { ids: ['not-a-real-id'] },
  })
  check('reordering unknown ids is refused', bogus.status === 422, `status ${bogus.status}`)
}

// ══════════════════════════════════════ deletion
section('Deletion  A live item cannot vanish by accident')

{
  const r = await call(`/admin/showcase/${liveId}`, { method: 'DELETE', jar: superAdmin })
  check('deleting a live item is refused', r.status === 409, `status ${r.status}`)
  check(
    'the code says to unpublish first',
    r.json?.error?.code === 'SHOWCASE_ITEM_LIVE',
    r.json?.error?.code ?? 'none',
  )

  await call(`/admin/showcase/${liveId}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'ARCHIVED' },
  })

  const again = await call(`/admin/showcase/${liveId}`, { method: 'DELETE', jar: superAdmin })
  check('once archived it deletes', again.status === 204, `status ${again.status}`)
}

// ══════════════════════════════════════ access control
section('Access  Who may touch the showcase')

{
  const customer = await signIn(CUSTOMER.email, CUSTOMER.password)

  const read = await call('/admin/showcase', { jar: customer })
  check('a customer cannot read the admin list', read.status === 403, `status ${read.status}`)

  const write = await call('/admin/showcase', {
    method: 'POST',
    jar: customer,
    body: { mediaUrl: VIDEO, altText: 'nope' },
  })
  check('a customer cannot add an item', write.status === 403, `status ${write.status}`)

  const anonymous = await call('/admin/showcase')
  check('an anonymous request is rejected', anonymous.status === 401, `status ${anonymous.status}`)
}

// ─── clean up everything this suite created ───
for (const { id } of created) {
  await call(`/admin/showcase/${id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'ARCHIVED' },
  })
  await call(`/admin/showcase/${id}`, { method: 'DELETE', jar: superAdmin })
}

// Put the wall back in the order it was found. The reorder test reverses it,
// and leaving the demo homepage shuffled would look like a bug in the seed.
const surviving = originalOrder.filter((id) => !created.some((item) => item.id === id))
if (surviving.length > 0) {
  await call('/admin/showcase/reorder', {
    method: 'PATCH',
    jar: superAdmin,
    body: { ids: surviving },
  })

  const restored = await call('/admin/showcase', { jar: superAdmin })
  const now = (restored.json?.data?.items ?? []).map((i) => i.id)
  check(
    'the seeded order is restored',
    now.join() === surviving.join(),
    `${now.length} items`,
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
