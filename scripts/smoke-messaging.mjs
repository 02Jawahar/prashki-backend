/**
 * Messaging (M14, M15, M16).
 *
 * Written after "message modules did not work well". The bugs it locks down:
 *
 *   - `USER_REGISTERED` had a handler and no emitter, so the welcome email had
 *     never fired once. A handler nothing calls is invisible in every other
 *     kind of test, so this suite asserts on the *effect* — a log row appears
 *     after a registration — rather than on the wiring.
 *   - `ORDER_FAILED` was emitted with no listener, so a customer whose payment
 *     bounced was told nothing at all.
 *   - There was no way to see a template rendered, or to send one, without
 *     placing a real order.
 */
import crypto from 'node:crypto'

const SECRET = process.env.JWT_ACCESS_SECRET
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 900))

console.log('\nMessaging — templates, delivery and the events behind them\n')

const superAdmin = await signIn(SUPER.email, SUPER.password)
if (!superAdmin) {
  console.log('Cannot continue without the super admin session.')
  process.exit(1)
}

const logTotal = async () => {
  const r = await call('/admin/messaging/logs', { jar: superAdmin })
  return r.json?.meta?.pagination?.total ?? 0
}

// ══════════════════════════════════════ templates exist and are editable
section('M15  Templates are readable and editable')

let sample = null
{
  const r = await call('/admin/messaging/templates', { jar: superAdmin })
  check('the template list loads', r.status === 200, `status ${r.status}`)

  const templates = r.json?.data?.templates ?? []
  check('templates are seeded', templates.length >= 10, `${templates.length} templates`)
  check(
    'every template carries its body',
    templates.every((t) => typeof t.body === 'string' && t.body.length > 0),
  )
  check(
    'every template declares its placeholders',
    templates.every((t) => Array.isArray(t.variables)),
  )

  sample = templates.find((t) => t.channel === 'EMAIL' && t.key === 'order.placed')
  check('order.placed exists for email', Boolean(sample))
}

const original = sample ? { subject: sample.subject, body: sample.body } : null

{
  // The exact payload the admin form sends.
  const r = await call('/admin/messaging/templates', {
    method: 'PUT',
    jar: superAdmin,
    body: {
      key: sample.key,
      channel: sample.channel,
      name: sample.name,
      subject: 'Edited by the messaging suite',
      body: `${sample.body}\n\nEdited.`,
      providerTemplateId: sample.providerTemplateId,
      variables: sample.variables,
      isActive: sample.isActive,
    },
  })
  check('an edit is accepted', r.status === 201, `status ${r.status}`)

  const after = await call('/admin/messaging/templates', { jar: superAdmin })
  const saved = (after.json?.data?.templates ?? []).find(
    (t) => t.key === sample.key && t.channel === sample.channel,
  )
  check('the edit persists', saved?.subject === 'Edited by the messaging suite', saved?.subject)
  check('the body persists', saved?.body?.endsWith('Edited.'))
}

{
  const r = await call('/admin/messaging/templates', {
    method: 'PUT',
    jar: superAdmin,
    body: { key: sample.key, channel: sample.channel, name: sample.name, body: '' },
  })
  check('an empty body is refused', r.status === 422, `status ${r.status}`)
}

// ══════════════════════════════════════ channel routing
section('M14  Channels are chosen in admin, not in code')

{
  const r = await call('/admin/messaging/events', { jar: superAdmin })
  check('the event catalogue loads', r.status === 200, `status ${r.status}`)

  const events = r.json?.data?.events ?? []
  check('every event the code sends is listed', events.length >= 10, `${events.length} events`)
  check(
    'each event reports the state of each channel',
    events.every((e) =>
      e.channels.every((c) => typeof c.enabled === 'boolean' && typeof c.configured === 'boolean'),
    ),
  )

  const reset = events.find((e) => e.key === 'account.password_reset')
  check(
    'a password reset is offered on email only',
    reset?.channels.length === 1 && reset.channels[0].channel === 'EMAIL',
    reset?.channels.map((c) => c.channel).join(',') ?? 'none',
  )

  check('no template is orphaned from its event', (r.json?.data?.orphans ?? []).length === 0)
}

{
  // Turning a channel on for the first time has to produce a usable template,
  // not an empty one an admin has to notice and fill in.
  //
  // Whether this is the first time depends on whether the suite has run
  // before — turning a channel off leaves its copy behind, by design. So the
  // expectation is read from the current state rather than assumed.
  const catalogue = await call('/admin/messaging/events', { jar: superAdmin })
  const firstTime = !(catalogue.json?.data?.events ?? [])
    .find((e) => e.key === 'order.delivered')
    ?.channels.find((c) => c.channel === 'WHATSAPP')?.configured

  const r = await call('/admin/messaging/events/channels', {
    method: 'PUT',
    jar: superAdmin,
    body: { key: 'order.delivered', channel: 'WHATSAPP', enabled: true },
  })
  check(
    'a new channel can be switched on',
    r.status === (firstTime ? 201 : 200),
    `status ${r.status}${firstTime ? '' : ' (already configured)'}`,
  )
  check('it creates the template when there is none', r.json?.data?.created === firstTime)
  check('the new template has copy in it', (r.json?.data?.template?.body ?? '').length > 20)
  check(
    'whatsapp gets no subject line',
    r.json?.data?.template?.subject === null,
    String(r.json?.data?.template?.subject),
  )

  const after = await call('/admin/messaging/events', { jar: superAdmin })
  const event = (after.json?.data?.events ?? []).find((e) => e.key === 'order.delivered')
  const whatsapp = event?.channels.find((c) => c.channel === 'WHATSAPP')
  check('the catalogue reports it as on', whatsapp?.enabled === true)
}

/**
 * The claim worth proving: a channel switched on in admin actually sends,
 * with no deploy.
 *
 * Driven through registration rather than an order, because registration is
 * the one event this suite can trigger from nothing — no cart, no stock, no
 * legal status transition to satisfy. The customer is created here with a
 * phone number, so WhatsApp has somewhere to go.
 */
{
  // Unique per run: the delivery log is append-only, so a fixed number would
  // still carry last run’s message and make the “channel off” check fail.
  const phone = `+9198${String(Date.now()).slice(-8)}`

  // Off first, so the assertion is about switching it on.
  await call('/admin/messaging/events/channels', {
    method: 'PUT', jar: superAdmin,
    body: { key: 'account.welcome', channel: 'WHATSAPP', enabled: false },
  })

  const emailOnly = new Jar()
  const before = `nowhatsapp-${Date.now()}@example.com`
  await call('/auth/register', {
    method: 'POST', jar: emailOnly,
    body: { name: 'Before', email: before, phone, password: 'Before@12345', acceptedTerms: true },
  })
  await settle()

  const beforeLogs = await call('/admin/messaging/logs?channel=WHATSAPP', { jar: superAdmin })
  check(
    'with the channel off, nothing goes out on it',
    !(beforeLogs.json?.data?.logs ?? []).some((l) => l.recipient === phone && l.template?.key === 'account.welcome'),
  )

  // Now switch it on — the only change — and register again.
  const enabled = await call('/admin/messaging/events/channels', {
    method: 'PUT', jar: superAdmin,
    body: { key: 'account.welcome', channel: 'WHATSAPP', enabled: true },
  })
  check('WhatsApp is switched on for the welcome', enabled.status === 200 || enabled.status === 201)

  const both = new Jar()
  const after = `withwhatsapp-${Date.now()}@example.com`
  await call('/auth/register', {
    method: 'POST', jar: both,
    body: { name: 'After', email: after, phone, password: 'After@12345', acceptedTerms: true },
  })
  await settle()

  const logs = await call('/admin/messaging/logs?channel=WHATSAPP', { jar: superAdmin })
  const sent = (logs.json?.data?.logs ?? []).find(
    (l) => l.template?.key === 'account.welcome' && l.recipient === phone,
  )
  check('the newly enabled channel actually sends', Boolean(sent), sent?.recipient ?? 'nothing sent')
  check('it went to the phone, not the email', sent?.recipient === phone, sent?.recipient ?? 'none')

  // The email must still go out — enabling a channel adds one, it does not
  // move the message off the one that was already working.
  const emails = await call('/admin/messaging/logs?channel=EMAIL', { jar: superAdmin })
  check(
    'email still goes out alongside it',
    (emails.json?.data?.logs ?? []).some((l) => l.recipient === after),
  )

  // Leave the seeded configuration as it was found.
  await call('/admin/messaging/events/channels', {
    method: 'PUT', jar: superAdmin,
    body: { key: 'account.welcome', channel: 'WHATSAPP', enabled: false },
  })
}

{
  const r = await call('/admin/messaging/events/channels', {
    method: 'PUT',
    jar: superAdmin,
    body: { key: 'order.delivered', channel: 'WHATSAPP', enabled: false },
  })
  check('a channel can be switched off again', r.status === 200, `status ${r.status}`)

  const after = await call('/admin/messaging/events', { jar: superAdmin })
  const whatsapp = (after.json?.data?.events ?? [])
    .find((e) => e.key === 'order.delivered')
    ?.channels.find((c) => c.channel === 'WHATSAPP')
  check('it reports as off', whatsapp?.enabled === false)
  check('but the copy survives being switched off', whatsapp?.configured === true)
}

{
  // A reset link over WhatsApp is a credential on a channel it does not belong
  // on. The API refuses rather than trusting the UI not to offer it.
  const r = await call('/admin/messaging/events/channels', {
    method: 'PUT',
    jar: superAdmin,
    body: { key: 'account.password_reset', channel: 'WHATSAPP', enabled: true },
  })
  check('a channel the event forbids is refused', r.status === 422, `status ${r.status}`)
  check(
    'the refusal names the allowed channels',
    r.json?.error?.code === 'CHANNEL_NOT_ALLOWED' || /email/i.test(r.json?.error?.message ?? ''),
    r.json?.error?.code ?? 'none',
  )
}

{
  const r = await call('/admin/messaging/events/channels', {
    method: 'PUT',
    jar: superAdmin,
    body: { key: 'not.an.event', channel: 'EMAIL', enabled: true },
  })
  check('an unknown event is refused', r.status === 404, `status ${r.status}`)
}

// ══════════════════════════════════════ preview
section('M15  A template can be checked before it reaches anyone')

{
  const r = await call('/admin/messaging/templates/preview', {
    method: 'POST',
    jar: superAdmin,
    body: { key: sample.key, channel: sample.channel },
  })
  check('preview renders', r.status === 200, `status ${r.status}`)
  check('it substitutes placeholders', !/\{\{\s*\w/.test(r.json?.data?.body ?? '{{x}}'))
  check('it returns a subject for email', typeof r.json?.data?.subject === 'string')
}

{
  // Previewing unsaved text is the whole point — otherwise you save to find out.
  const r = await call('/admin/messaging/templates/preview', {
    method: 'POST',
    jar: superAdmin,
    body: {
      key: sample.key,
      channel: sample.channel,
      body: 'Hello {{name}}, your order {{orderNumber}} is confirmed.',
    },
  })
  check('unsaved edits can be previewed', r.status === 200, `status ${r.status}`)
  check(
    'the preview uses the submitted body',
    /Hello .+, your order .+ is confirmed\./.test(r.json?.data?.body ?? ''),
    r.json?.data?.body ?? 'none',
  )
}

{
  // A placeholder the template does not declare renders blank in a real send,
  // which is the single most common way a template silently breaks.
  const r = await call('/admin/messaging/templates/preview', {
    method: 'POST',
    jar: superAdmin,
    body: { key: sample.key, channel: sample.channel, body: 'Hi {{nmae}}' },
  })
  check('a typo in a placeholder is reported', (r.json?.data?.undeclared ?? []).includes('nmae'))
}

{
  const r = await call('/admin/messaging/templates/preview', {
    method: 'POST',
    jar: superAdmin,
    body: { key: 'no.such.template', channel: 'EMAIL' },
  })
  check('previewing an unknown template 404s', r.status === 404, `status ${r.status}`)
}

// ══════════════════════════════════════ test send
section('M15  Test send goes to the admin, and nowhere else')

{
  const before = await logTotal()
  const r = await call('/admin/messaging/templates/test-send', {
    method: 'POST',
    jar: superAdmin,
    body: { key: sample.key, channel: 'EMAIL' },
  })
  check('a test send succeeds', r.status === 200, `status ${r.status}`)
  check('it reports the recipient', r.json?.data?.recipient === SUPER.email, r.json?.data?.recipient)
  check(
    'it names the provider so "sent" is not read as "arrived"',
    typeof r.json?.data?.provider === 'string',
    r.json?.data?.provider,
  )

  await settle()
  check('it is written to the delivery log', (await logTotal()) > before, `was ${before}`)
}

{
  // The recipient must not be a parameter — otherwise it is an open relay.
  const r = await call('/admin/messaging/templates/test-send', {
    method: 'POST',
    jar: superAdmin,
    body: { key: sample.key, channel: 'EMAIL', recipient: 'stranger@example.com' },
  })
  check('a supplied address is ignored', r.json?.data?.recipient === SUPER.email, r.json?.data?.recipient)
}

// ══════════════════════════════════════ the dead events
section('M15  Registration actually sends a welcome')

{
  const before = await logTotal()

  const jar = new Jar()
  const email = `welcome-${Date.now()}@example.com`
  const r = await call('/auth/register', {
    method: 'POST',
    jar,
    body: { name: 'Welcome Test', email, password: 'Welcome@12345', acceptedTerms: true },
  })
  check('a customer registers', r.status === 201, `status ${r.status}`)

  await settle()

  const after = await call('/admin/messaging/logs', { jar: superAdmin })
  const total = after.json?.meta?.pagination?.total ?? 0
  check('registering produces a message', total > before, `${before} → ${total}`)

  const welcome = (after.json?.data?.logs ?? []).find((l) => l.recipient === email)
  check('the welcome went to the new customer', Boolean(welcome), welcome?.recipient ?? 'not found')
  check(
    'it used the welcome template',
    welcome?.template?.key === 'account.welcome',
    welcome?.template?.key ?? 'none',
  )
  check('it is marked sent', welcome?.status === 'SENT', welcome?.status ?? 'none')
}

section('M16  A failed payment tells the customer')

/**
 * Driven through the real webhook, because that is how a payment actually
 * fails — the gateway tells us after the customer has left the page. Forcing
 * it through an admin route would test a path no card ever takes.
 */
if (!SECRET) {
  console.log('  SKIP  JWT_ACCESS_SECRET not in the environment, cannot sign a webhook')
} else {
  const customer = await signIn(CUSTOMER.email, CUSTOMER.password)

  // A fresh order to fail, so nothing depends on what earlier suites left.
  const products = await call('/products?perPage=30')
  let variantId = null
  for (const p of products.json?.data?.products ?? []) {
    const detail = await call(`/products/${p.slug}`)
    const variant = (detail.json?.data?.product?.variants ?? []).find(
      (v) => (v.availableStock ?? v.stock ?? 0) > 1,
    )
    if (variant) { variantId = variant.id; break }
  }

  let addressId = (await call('/addresses', { jar: customer })).json?.data?.addresses?.[0]?.id
  if (!addressId) {
    const created = await call('/addresses', {
      method: 'POST', jar: customer,
      body: {
        name: 'Aditi Rao', phone: '+919810000000', addressLine1: '14 Sunder Nagar',
        city: 'New Delhi', state: 'Delhi', postalCode: '110003', country: 'IN', isDefault: true,
      },
    })
    addressId = created.json?.data?.address?.id
  }

  if (!variantId || !addressId) {
    console.log('  SKIP  could not assemble an order to fail')
  } else {
    await call('/cart/items', { method: 'POST', jar: customer, body: { variantId, quantity: 1 } })
    const placed = await call('/orders', { method: 'POST', jar: customer, body: { addressId } })
    const order = placed.json?.data?.order
    check('an order is placed to fail', Boolean(order), order?.orderNumber ?? `status ${placed.status}`)

    const intent = await call('/payments/create', {
      method: 'POST', jar: customer, body: { orderId: order.id },
    })
    const providerOrderId = intent.json?.data?.providerOrderId ?? intent.json?.data?.payment?.providerOrderId
    check('a payment intent exists', Boolean(providerOrderId), providerOrderId ?? `status ${intent.status}`)

    if (providerOrderId) {
      const before = (await call('/notifications', { jar: customer })).json?.data?.notifications ?? []

      const raw = JSON.stringify({
        id: `evt_fail_${Date.now()}`,
        event: 'payment.failed',
        providerOrderId,
        providerPaymentId: 'pay_declined',
      })

      const delivered = await fetch(`${BASE}/webhooks/razorpay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
        },
        body: raw,
      })
      check('the failure webhook is accepted', delivered.status === 200, `status ${delivered.status}`)

      await settle()

      const after = (await call('/notifications', { jar: customer })).json?.data?.notifications ?? []
      const failure = after.find((n) => n.type === 'order.payment_failed')

      check('the customer is told', Boolean(failure), `${before.length} → ${after.length} notifications`)
      check(
        'the notice names their order',
        failure?.title?.includes(order.orderNumber),
        failure?.title ?? 'none',
      )
      check(
        'it says the order is still theirs to retry',
        /again|retry|held/i.test(failure?.body ?? ''),
        failure?.body ?? 'none',
      )
      check(
        'it does not leak provider jargon at the customer',
        !/provider reported|payment.failed|declined by issuer/i.test(failure?.body ?? ''),
        failure?.body ?? 'none',
      )

      // The order must survive for the retry to be possible.
      const still = await call(`/orders/${order.id}`, { jar: customer })
      check(
        'the order is still awaiting payment',
        still.json?.data?.order?.status === 'PENDING_PAYMENT',
        still.json?.data?.order?.status ?? 'none',
      )
    }
  }
}

// ══════════════════════════════════════ the log
section('M15  The delivery log answers "did they get it?"')

{
  const r = await call('/admin/messaging/logs', { jar: superAdmin })
  check('the log loads', r.status === 200, `status ${r.status}`)
  check('it paginates', typeof r.json?.meta?.pagination?.total === 'number')

  const filtered = await call('/admin/messaging/logs?channel=EMAIL', { jar: superAdmin })
  check(
    'it filters by channel',
    (filtered.json?.data?.logs ?? []).every((l) => l.channel === 'EMAIL'),
  )

  const bad = await call('/admin/messaging/logs?status=NONSENSE', { jar: superAdmin })
  check('an unknown status is refused', bad.status === 422, `status ${bad.status}`)
}

// ══════════════════════════════════════ access
section('Access  Who may manage messaging')

{
  const customer = await signIn(CUSTOMER.email, CUSTOMER.password)

  for (const path of ['/admin/messaging/templates', '/admin/messaging/logs']) {
    const r = await call(path, { jar: customer })
    check(`a customer cannot reach ${path}`, r.status === 403, `status ${r.status}`)
  }

  const send = await call('/admin/messaging/templates/test-send', {
    method: 'POST',
    jar: customer,
    body: { key: 'order.placed', channel: 'EMAIL' },
  })
  check('a customer cannot send a test', send.status === 403, `status ${send.status}`)

  const anonymous = await call('/admin/messaging/templates')
  check('an anonymous request is rejected', anonymous.status === 401, `status ${anonymous.status}`)
}

// ─── restore the template this suite edited ───
if (original) {
  await call('/admin/messaging/templates', {
    method: 'PUT',
    jar: superAdmin,
    body: {
      key: sample.key,
      channel: sample.channel,
      name: sample.name,
      subject: original.subject,
      body: original.body,
      providerTemplateId: sample.providerTemplateId,
      variables: sample.variables,
      isActive: sample.isActive,
    },
  })

  const restored = await call('/admin/messaging/templates', { jar: superAdmin })
  const now = (restored.json?.data?.templates ?? []).find(
    (t) => t.key === sample.key && t.channel === sample.channel,
  )
  check('the seeded template is restored', now?.subject === original.subject, now?.subject)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
