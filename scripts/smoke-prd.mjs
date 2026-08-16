/**
 * Verification for the PRD modules added after the boilerplate:
 * coupons, shipping, fulfilment, returns, refunds, CMS, redirects,
 * notifications, wishlist, reviews, attributes, reports and analytics.
 *
 * Run against a freshly seeded database:  npm run db:seed && node scripts/smoke-prd.mjs
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const ADMIN = { email: process.env.ADMIN_EMAIL ?? 'admin@example.com', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' }
const CUSTOMER = { email: process.env.CUSTOMER_EMAIL ?? 'customer@example.com', password: process.env.CUSTOMER_PASSWORD ?? 'Customer@12345' }

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
  get(name) { return this.cookies.get(name) }
}

/** A CSRF token for calls made without a cookie jar. Fetched once. */
let sharedCsrf = null
async function primeCsrf() {
  const res = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
  return cookie ? cookie.split(';')[0].slice('csrf='.length) : null
}
async function call(path, { method = 'GET', body, jar } = {}) {
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
    body: body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  return { status: res.status, json }
}

console.log('\nPRD modules — verification\n')

// --------------------------------------------------------------- sign in
const admin = new Jar()
const customer = new Jar()

{
  const a = await call('/auth/login', { method: 'POST', jar: admin, body: ADMIN })
  const c = await call('/auth/login', { method: 'POST', jar: customer, body: CUSTOMER })
  check('admin signs in', a.status === 200, `status ${a.status}`)
  check('customer signs in', c.status === 200, `status ${c.status}`)
  if (a.status !== 200 || c.status !== 200) {
    console.log('\nCannot continue without both sessions.')
    process.exit(1)
  }
}

// ------------------------------------------------------------- attributes
section('Attributes and faceted search')

let sizeValueSlug = null
{
  const r = await call('/admin/attributes', { jar: admin })
  const attributes = r.json?.data?.attributes ?? []
  const size = attributes.find((a) => a.slug === 'size')
  sizeValueSlug = size?.values?.find((v) => v.usageCount > 0)?.slug ?? null

  check('seeded attributes are listed', attributes.length >= 2, `${attributes.length} attributes`)
  check('size values are attached to variants', Boolean(sizeValueSlug), `value ${sizeValueSlug}`)
}

{
  const r = await call('/products/facets')
  const facets = r.json?.data
  check('facet endpoint returns filter options', r.status === 200 && (facets?.attributes?.length ?? 0) > 0)
  check('facet counts are present', (facets?.attributes?.[0]?.values?.[0]?.count ?? 0) > 0)
  check('price range is derived from the catalogue', (facets?.price?.max ?? 0) > (facets?.price?.min ?? -1))
}

{
  const all = await call('/products?perPage=48')
  const filtered = await call(`/products?perPage=48&attributes=size:${sizeValueSlug}`)
  const allCount = all.json?.meta?.pagination?.total ?? 0
  const filteredCount = filtered.json?.meta?.pagination?.total ?? 0

  check(
    'attribute filter narrows the catalogue',
    filtered.status === 200 && filteredCount > 0 && filteredCount <= allCount,
    `${filteredCount} of ${allCount}`,
  )
}

// ---------------------------------------------------------------- coupons
section('Coupons')

let variant = null
{
  const listing = await call('/products?perPage=12&inStock=true')
  const slug = listing.json?.data?.products?.[0]?.slug
  const detail = await call(`/products/${slug}`)
  variant = detail.json?.data?.product?.variants?.find((v) => v.stock > 2) ?? null
  check('a purchasable variant is available', Boolean(variant))
}

{
  await call('/cart/items', { method: 'POST', jar: customer, body: { variantId: variant.id, quantity: 2 } })

  const bad = await call('/cart/coupon', { method: 'POST', jar: customer, body: { code: 'NOPE-DOES-NOT-EXIST' } })
  check('an unknown code is refused', bad.status === 422, `status ${bad.status}`)

  const ship = await call('/cart/coupon', { method: 'POST', jar: customer, body: { code: 'freeship' } })
  const cart = ship.json?.data?.cart
  check('a valid code applies, case-insensitively', ship.status === 200 && cart?.coupon?.code === 'FREESHIP')
  check('free shipping does not reduce the subtotal', cart?.discount === 0 && cart?.freeShipping === true)

  const removed = await call('/cart/coupon', { method: 'DELETE', jar: customer })
  check('a coupon can be removed', removed.status === 200 && removed.json?.data?.cart?.coupon === null)
}

{
  // WELCOME10 requires a 5,000 rupee subtotal and a first order.
  const created = await call('/admin/coupons', {
    method: 'POST',
    jar: admin,
    body: {
      code: 'SMOKE-FIXED',
      type: 'FIXED',
      status: 'ACTIVE',
      value: 50_000,
      minSubtotal: 0,
    },
  })
  check('admin can create a coupon', created.status === 201, `status ${created.status}`)

  const applied = await call('/cart/coupon', { method: 'POST', jar: customer, body: { code: 'SMOKE-FIXED' } })
  const cart = applied.json?.data?.cart
  check('a fixed coupon reduces the subtotal', cart?.discount === 50_000, `discount ${cart?.discount}`)
  check(
    'the discount is allocated across the lines',
    cart?.items?.reduce((sum, i) => sum + i.discountAllocated, 0) === cart?.discount,
    `allocated ${cart?.items?.reduce((sum, i) => sum + i.discountAllocated, 0)}`,
  )

  const percentTooBig = await call('/admin/coupons', {
    method: 'POST',
    jar: admin,
    body: { code: 'SMOKE-BAD', type: 'PERCENTAGE', value: 20_000, status: 'ACTIVE' },
  })
  check('a percentage above 100% is refused', percentTooBig.status === 422, `status ${percentTooBig.status}`)
}

// --------------------------------------------------------------- shipping
section('Shipping')

let shippingMethodId = null
{
  const metro = await call('/shipping/quote?country=IN&state=Delhi&postalCode=110003', { jar: customer })
  const methods = metro.json?.data?.methods ?? []
  shippingMethodId = methods[0]?.id ?? null

  check('a metro address resolves to the metro zone', metro.json?.data?.zone?.name === 'Metro cities', metro.json?.data?.zone?.name)
  check('delivery options are offered', methods.length >= 2, `${methods.length} methods`)

  const remote = await call('/shipping/quote?country=IN&state=Assam&postalCode=781001', { jar: customer })
  check('an address outside the metro zone falls back to India', remote.json?.data?.zone?.name === 'India', remote.json?.data?.zone?.name)

  const abroad = await call('/shipping/quote?country=FR', { jar: customer })
  check(
    'an unsupported country still resolves through the default zone',
    abroad.json?.data?.zone?.name === 'India',
    abroad.json?.data?.zone?.name,
  )
}

// ------------------------------------------------------- checkout end-to-end
section('Checkout with a coupon and a delivery method')

let orderId = null
let orderNumber = null
{
  const addresses = await call('/addresses', { jar: customer })
  const addressId = addresses.json?.data?.addresses?.[0]?.id
  check('the customer has a saved address', Boolean(addressId))

  const key = `smoke-${Date.now()}`
  const placed = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: { addressId, idempotencyKey: key, shippingMethodId },
  })
  const order = placed.json?.data?.order
  orderId = order?.id
  orderNumber = order?.orderNumber

  check('the order is created', placed.status === 201, `status ${placed.status}`)
  check('the coupon is recorded on the order', order?.couponCode === 'SMOKE-FIXED', order?.couponCode)
  check('the discount carries onto the order', order?.discount === 50_000, `discount ${order?.discount}`)
  check('the shipping method is snapshotted', Boolean(order?.shippingMethodName), order?.shippingMethodName)
  check(
    'the total adds up',
    order?.total === order?.subtotal - order?.discount + order?.shipping + order?.tax,
    `${order?.subtotal} - ${order?.discount} + ${order?.shipping} + ${order?.tax} = ${order?.total}`,
  )
  check(
    'the per-line discount sums to the order discount',
    order?.items?.reduce((sum, i) => sum + i.discountAllocated, 0) === order?.discount,
  )
  check('staff-only notes are not returned to the customer', !('internalNotes' in (order ?? {})))

  // The same key again must return the same order, not a second one.
  const replay = await call('/orders', {
    method: 'POST',
    jar: customer,
    body: { addressId, idempotencyKey: key, shippingMethodId },
  })
  check('a replayed checkout returns the same order', replay.json?.data?.order?.id === orderId)
  check('the replay is flagged as such', replay.json?.data?.replayed === true)
}

{
  const second = await call('/cart/coupon', { method: 'POST', jar: customer, body: { code: 'SMOKE-FIXED' } })
  check('the cart is empty after checkout', second.status === 409, `status ${second.status}`)
}

// -------------------------------------------------------------- fulfilment
section('Fulfilment and tracking')

let shipmentId = null
{
  await call(`/admin/orders/${orderId}/status`, { method: 'PATCH', jar: admin, body: { status: 'PAID' } })

  const detail = await call(`/admin/orders/${orderId}`, { jar: admin })
  const items = detail.json?.data?.order?.items ?? []
  const first = items[0]

  const over = await call(`/admin/shipments/orders/${orderId}`, {
    method: 'POST',
    jar: admin,
    body: { items: [{ orderItemId: first.id, quantity: first.quantity + 5 }] },
  })
  check('shipping more than was bought is refused', over.status === 409, `status ${over.status}`)

  const shipped = await call(`/admin/shipments/orders/${orderId}`, {
    method: 'POST',
    jar: admin,
    body: {
      items: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      carrier: 'delhivery',
      trackingNumber: 'SMOKE1234567',
    },
  })
  shipmentId = shipped.json?.data?.shipment?.id
  check('a shipment is created', shipped.status === 201, `status ${shipped.status}`)
  check('a tracking URL is generated from the carrier', shipped.json?.data?.shipment?.trackingUrl?.includes('SMOKE1234567') === true)
  check('shipping everything advances the order', shipped.json?.data?.fullyShipped === true)

  const tracking = await call(`/tracking/orders/${orderId}`, { jar: customer })
  check('the customer can track their order', tracking.status === 200 && (tracking.json?.data?.shipments?.length ?? 0) === 1)
  check('tracking includes the event trail', (tracking.json?.data?.shipments?.[0]?.events?.length ?? 0) >= 1)

  const foreign = await call(`/tracking/orders/${orderId}`, { jar: admin })
  check("another account's order is not trackable", foreign.status === 404, `status ${foreign.status}`)
}

{
  const delivered = await call(`/admin/shipments/${shipmentId}/status`, {
    method: 'PATCH',
    jar: admin,
    body: { status: 'DELIVERED', message: 'Left with the recipient' },
  })
  check('a shipment can be marked delivered', delivered.status === 200)

  const order = await call(`/admin/orders/${orderId}`, { jar: admin })
  check('the order follows its shipments to DELIVERED', order.json?.data?.order?.status === 'DELIVERED', order.json?.data?.order?.status)
}

// ----------------------------------------------------------------- returns
section('Returns and refunds')

let returnId = null
{
  const eligibility = await call(`/returns/eligibility/${orderId}`, { jar: customer })
  check('a delivered order is returnable', eligibility.json?.data?.eligible === true, eligibility.json?.data?.reason ?? '')

  const line = eligibility.json?.data?.lines?.[0]
  check('the returnable value is net of the discount', line?.unitValue > 0 && line?.unitValue < 100_000_000)

  const tooMany = await call('/returns', {
    method: 'POST',
    jar: customer,
    body: {
      orderId,
      reason: 'WRONG_SIZE',
      items: [{ orderItemId: line.orderItemId, quantity: line.purchased + 3 }],
    },
  })
  check('returning more than was bought is refused', tooMany.status === 409, `status ${tooMany.status}`)

  const created = await call('/returns', {
    method: 'POST',
    jar: customer,
    body: {
      orderId,
      reason: 'WRONG_SIZE',
      comment: 'Too small through the shoulders.',
      items: [{ orderItemId: line.orderItemId, quantity: 1 }],
    },
  })
  returnId = created.json?.data?.request?.id
  check('a return request is created', created.status === 201, `status ${created.status}`)
  check('the estimated refund is returned', (created.json?.data?.estimatedRefund ?? 0) > 0)

  const again = await call(`/returns/eligibility/${orderId}`, { jar: customer })
  const sameLine = again.json?.data?.lines?.find((l) => l.orderItemId === line.orderItemId)
  check('the pending return holds its claim on the item', sameLine?.claimed === 1, `claimed ${sameLine?.claimed}`)
}

{
  const skip = await call(`/admin/returns/${returnId}/status`, {
    method: 'PATCH',
    jar: admin,
    body: { status: 'COMPLETED' },
  })
  check('an illegal return transition is refused', skip.status === 409, `status ${skip.status}`)

  const rejectNoReason = await call(`/admin/returns/${returnId}/status`, {
    method: 'PATCH',
    jar: admin,
    body: { status: 'REJECTED' },
  })
  check('rejecting without a reason is refused', rejectNoReason.status === 422, `status ${rejectNoReason.status}`)

  await call(`/admin/returns/${returnId}/status`, { method: 'PATCH', jar: admin, body: { status: 'APPROVED' } })
  await call(`/admin/returns/${returnId}/status`, { method: 'PATCH', jar: admin, body: { status: 'RECEIVED' } })

  const detail = await call(`/admin/returns/${returnId}`, { jar: admin })
  const returnItemId = detail.json?.data?.request?.items?.[0]?.id

  const inspected = await call(`/admin/returns/${returnId}/status`, {
    method: 'PATCH',
    jar: admin,
    body: {
      status: 'INSPECTED',
      itemDispositions: [{ returnItemId, restock: true, condition: 'As new' }],
    },
  })
  check('a return can be inspected and restocked', inspected.status === 200, `status ${inspected.status}`)
}

{
  const money = await call(`/admin/refunds/orders/${orderId}`, { jar: admin })
  check('nothing is refundable on an unpaid order', money.json?.data?.refundable === 0, `refundable ${money.json?.data?.refundable}`)

  const attempt = await call('/admin/refunds', {
    method: 'POST',
    jar: admin,
    body: { orderId, amount: 10_000, returnRequestId: returnId },
  })
  check(
    'a refund on an order with no captured payment is refused',
    attempt.status === 409,
    `status ${attempt.status} ${attempt.json?.error?.code ?? ''}`,
  )
}

// -------------------------------------------------------------------- CMS
section('Content, redirects and SEO')

{
  const pages = await call('/pages')
  check('published pages are listed', (pages.json?.data?.pages?.length ?? 0) >= 6)

  const about = await call('/pages/about')
  check('a published page is readable', about.status === 200 && about.json?.data?.page?.title?.length > 0)

  const created = await call('/admin/pages', {
    method: 'POST',
    jar: admin,
    body: { slug: 'smoke-draft', title: 'Smoke draft', status: 'DRAFT', blocks: [] },
  })
  const pageId = created.json?.data?.page?.id
  check('an admin can create a page', created.status === 201, `status ${created.status}`)

  const hidden = await call('/pages/smoke-draft')
  check('a draft page is not publicly readable', hidden.status === 404, `status ${hidden.status}`)

  await call(`/admin/pages/${pageId}`, {
    method: 'PATCH',
    jar: admin,
    body: { slug: 'smoke-renamed', title: 'Smoke renamed', status: 'PUBLISHED', blocks: [] },
  })

  const redirect = await call('/redirects?path=/smoke-draft')
  check('renaming a page creates a redirect', redirect.json?.data?.redirect?.toPath === '/smoke-renamed', JSON.stringify(redirect.json?.data?.redirect))

  const detail = await call(`/admin/pages/${pageId}`, { jar: admin })
  check('revisions are kept', (detail.json?.data?.page?.revisions?.length ?? 0) >= 2, `${detail.json?.data?.page?.revisions?.length} revisions`)

  const revisionId = detail.json?.data?.page?.revisions?.find((r) => r.version === 1)?.id
  const restored = await call(`/admin/pages/${pageId}/restore/${revisionId}`, { method: 'POST', jar: admin })
  check('a revision can be restored', restored.status === 200 && restored.json?.data?.page?.title === 'Smoke draft', restored.json?.data?.page?.title)
}

{
  const open = await call('/admin/redirects', {
    method: 'POST',
    jar: admin,
    body: { fromPath: '/somewhere', toPath: 'https://evil.example.com/phish' },
  })
  check('an off-site redirect is refused', open.status === 422, `status ${open.status}`)

  const loop = await call('/admin/redirects', {
    method: 'POST',
    jar: admin,
    body: { fromPath: '/smoke-renamed', toPath: '/smoke-draft' },
  })
  check('a redirect loop is refused', loop.status === 422, `status ${loop.status}`)
}

{
  const sitemap = await call('/seo/sitemap')
  check('sitemap data is available', sitemap.status === 200 && (sitemap.json?.data?.products?.length ?? 0) > 0)
}

// ---------------------------------------------------------------- wishlist
section('Wishlist and reviews')

{
  const listing = await call('/products?perPage=4')
  const productId = listing.json?.data?.products?.[0]?.id

  const anon = await call('/wishlist')
  check('the wishlist requires a session', anon.status === 401, `status ${anon.status}`)

  const added = await call('/wishlist', { method: 'POST', jar: customer, body: { productId } })
  check('a product can be saved', added.status === 201, `status ${added.status}`)

  const twice = await call('/wishlist', { method: 'POST', jar: customer, body: { productId } })
  check('saving twice is not an error', twice.status === 200 && twice.json?.data?.alreadySaved === true)

  const list = await call('/wishlist', { jar: customer })
  check('the wishlist reads back', list.json?.data?.count === 1)

  const removed = await call(`/wishlist/product/${productId}`, { method: 'DELETE', jar: customer })
  check('a product can be unsaved', removed.json?.data?.removed === true)
}

{
  const detail = await call(`/admin/orders/${orderId}`, { jar: admin })
  const productId = detail.json?.data?.order?.items?.[0]?.productId

  const review = await call('/reviews', {
    method: 'POST',
    jar: customer,
    body: { productId, rating: 5, title: 'Beautiful', body: 'Exactly as described.' },
  })
  check('a review can be submitted', review.status === 201, `status ${review.status}`)
  check('the verified-purchase badge is derived, not requested', review.json?.data?.review?.isVerifiedPurchase === true)
  check('a new review starts unpublished', review.json?.data?.review?.status === 'PENDING')

  const publicList = await call(`/reviews/product/${productId}`)
  check('an unmoderated review is not public', publicList.json?.data?.reviews?.length === 0)
  check('the product rating stays at zero until approval', publicList.json?.data?.summary?.count === 0)

  const reviewId = review.json?.data?.review?.id
  const approved = await call(`/admin/reviews/${reviewId}/status`, {
    method: 'PATCH',
    jar: admin,
    body: { status: 'APPROVED' },
  })
  check('a review can be approved', approved.status === 200)

  const after = await call(`/reviews/product/${productId}`)
  check('an approved review appears', after.json?.data?.reviews?.length === 1)
  check('the rating aggregate is recomputed', after.json?.data?.summary?.average === 5 && after.json?.data?.summary?.count === 1, `avg ${after.json?.data?.summary?.average}`)

  const edited = await call('/reviews', {
    method: 'POST',
    jar: customer,
    body: { productId, rating: 3, body: 'Changed my mind.' },
  })
  check('editing sends a review back for moderation', edited.json?.data?.review?.status === 'PENDING')

  const afterEdit = await call(`/reviews/product/${productId}`)
  check('an edited review leaves the public average', afterEdit.json?.data?.summary?.count === 0)
}

// ----------------------------------------------------- notifications
section('Notifications and messaging')

{
  const bell = await call('/notifications', { jar: customer })
  const types = (bell.json?.data?.notifications ?? []).map((n) => n.type)
  check('the customer was notified about their order', types.includes('order.placed'), types.join(', '))
  check('an unread count is reported', (bell.json?.data?.unread ?? 0) > 0)

  const adminBell = await call('/notifications', { jar: admin })
  const adminTypes = (adminBell.json?.data?.notifications ?? []).map((n) => n.type)
  check('admins were notified about the new order', adminTypes.includes('order.placed'))

  const id = bell.json?.data?.notifications?.[0]?.id
  const crossRead = await call(`/notifications/${id}/read`, { method: 'POST', jar: admin })
  check("one account cannot read another's notification", crossRead.status === 404, `status ${crossRead.status}`)

  const read = await call(`/notifications/${id}/read`, { method: 'POST', jar: customer })
  check('a notification can be marked read', read.status === 200)
}

{
  const logs = await call('/admin/messaging/logs', { jar: admin })
  const sent = logs.json?.data?.logs ?? []
  check('outbound messages are logged', sent.length > 0, `${sent.length} messages`)
  check('the order confirmation was sent', sent.some((l) => l.template?.key === 'order.placed' && l.status === 'SENT'))

  const templates = await call('/admin/messaging/templates', { jar: admin })
  check('templates are editable from admin', (templates.json?.data?.templates?.length ?? 0) >= 12)
}

{
  const prefs = await call('/notification-preferences', {
    method: 'PUT',
    jar: customer,
    body: { preferences: [{ channel: 'EMAIL', type: 'marketing.newsletter', enabled: false }] },
  })
  check('notification preferences can be set', prefs.status === 200 && prefs.json?.data?.preferences?.length === 1)
}

// ------------------------------------------------------- account self-service
section('Account self-service')

{
  const updated = await call('/auth/profile', {
    method: 'PATCH',
    jar: customer,
    body: { name: 'Aditi R.' },
  })
  check('a customer can edit their profile', updated.status === 200 && updated.json?.data?.user?.name === 'Aditi R.')

  const emailAttempt = await call('/auth/profile', {
    method: 'PATCH',
    jar: customer,
    body: { email: 'someone-else@example.com' },
  })
  check('the profile endpoint will not change an email address', emailAttempt.status === 422, `status ${emailAttempt.status}`)

  const unknown = await call('/auth/forgot-password', {
    method: 'POST',
    body: { email: 'nobody-here@example.com' },
  })
  const known = await call('/auth/forgot-password', { method: 'POST', body: { email: CUSTOMER.email } })
  check(
    'password reset does not reveal whether an account exists',
    unknown.status === known.status && JSON.stringify(unknown.json) === JSON.stringify(known.json),
    `both ${unknown.status}`,
  )

  const badToken = await call('/auth/reset-password', {
    method: 'POST',
    body: { token: 'x'.repeat(40), password: 'a-new-password' },
  })
  check('a forged reset token is refused', badToken.status === 422, `status ${badToken.status}`)
}

// ---------------------------------------------------------------- PII
section('PII masking')

{
  const customers = await call('/admin/customers', { jar: admin })
  const first = customers.json?.data?.customers?.[0]
  // The seeded admin is a SUPER_ADMIN and holds customer.read_pii.
  check('an admin with the PII permission sees real contact details', first?.email?.includes('@') && !first?.email?.includes('***'), first?.email)
}

// ------------------------------------------------------------- reports
section('Reports and analytics')

{
  const sales = await call('/admin/reports/sales', { jar: admin })
  check('the sales report runs', sales.status === 200, `status ${sales.status}`)
  check('revenue is reported', (sales.json?.data?.grossRevenue ?? 0) > 0, `${sales.json?.data?.grossRevenue}`)
  check('a time series is returned', Array.isArray(sales.json?.data?.series) && sales.json.data.series.length > 0)

  const top = await call('/admin/reports/top-products', { jar: admin })
  check('the top-products report runs', top.status === 200 && (top.json?.data?.products?.length ?? 0) > 0)

  const inventory = await call('/admin/reports/inventory', { jar: admin })
  check('the inventory report runs', inventory.status === 200 && (inventory.json?.data?.unitsInStock ?? 0) > 0)

  const customers = await call('/admin/reports/customers', { jar: admin })
  check('the customer report runs', customers.status === 200 && (customers.json?.data?.totalCustomers ?? 0) > 0)
}

{
  await call('/products?q=linen+dress')
  const searches = await call('/admin/reports/searches', { jar: admin })
  check('searches are recorded and reported', searches.status === 200 && (searches.json?.data?.searches?.length ?? 0) > 0)

  const event = await call('/analytics', { method: 'POST', body: { type: 'cart.add', entityType: 'Product', entityId: 'abc' } })
  check('client analytics events are accepted', event.status === 204, `status ${event.status}`)

  const bogus = await call('/analytics', { method: 'POST', body: { type: 'not.a.real.event' } })
  check('an unknown analytics event type is refused', bogus.status === 422, `status ${bogus.status}`)
}

// ------------------------------------------------------------ permissions
section('Authorization')

{
  const routes = [
    ['/admin/coupons', 'coupons'],
    ['/admin/returns', 'returns'],
    ['/admin/reviews', 'reviews'],
    ['/admin/reports/sales', 'reports'],
    ['/admin/pages', 'pages'],
    ['/admin/messaging/templates', 'message templates'],
    ['/admin/attributes', 'attributes'],
  ]

  for (const [path, label] of routes) {
    const r = await call(path, { jar: customer })
    check(`a customer cannot reach admin ${label}`, r.status === 403, `status ${r.status}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
