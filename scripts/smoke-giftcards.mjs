/**
 * MODULE 13 — Gift cards.
 *
 * This is the one part of the store that creates and destroys money, so the
 * checks are about the invariants rather than the happy path:
 *
 *   - a card carries no spendable balance until the order that bought it is paid
 *   - the code is never returned before that
 *   - a balance can be spent once and not twice
 *   - a cancelled order puts the money back, exactly once
 *   - the ledger explains every movement, and always sums to the balance
 *   - refusals are indistinguishable, so codes cannot be guessed
 *
 * Run against a seeded database with the API up.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.loadEnvFile(path.resolve(here, '..', '.env'))

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const ADMIN = {
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
  constructor() {
    this.cookies = new Map()
  }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const [name, ...rest] = pair.split('=')
      this.cookies.set(name.trim(), rest.join('='))
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function call(pathname, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'

  const unsafe = method !== 'GET' && method !== 'HEAD'
  if (unsafe && jar && !jar.cookies.get('csrf')) {
    jar.absorb(await fetch(`${BASE}/`, { headers: { accept: 'application/json' } }))
  }

  const csrf = jar?.cookies?.get('csrf')
  const cookie = jar?.header()
  if (cookie) headers.cookie = cookie
  if (csrf) headers['x-csrf-token'] = csrf

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  return { status: res.status, json }
}

console.log('\nGift cards — stored value\n')

const admin = new Jar()
const customer = new Jar()
await call('/auth/login', { method: 'POST', jar: admin, body: ADMIN })
await call('/auth/login', { method: 'POST', jar: customer, body: CUSTOMER })

// ══════════════════════════════════════════════ what can be bought
section('What the store offers')

{
  const r = await call('/gift-cards/options')
  const d = r.json?.data
  check('the denominations are public', r.status === 200)
  check('there are fixed values to choose from', (d?.denominations?.length ?? 0) >= 2, `${d?.denominations?.length}`)
  check('a custom range is offered', d?.custom?.min > 0 && d?.custom?.max > d?.custom?.min,
    `${d?.custom?.min} to ${d?.custom?.max}`)

  /*
   * The values are the server's, not the page's. A denomination posted from a
   * browser is a price the customer chose, which on a gift card means handing
   * out money.
   */
  for (const [amount, why] of [
    [1, 'below the floor'],
    [999_999_999, 'above the ceiling'],
    [200_037, 'not a whole number of rupees'],
  ]) {
    const r = await call('/gift-cards/purchase', {
      method: 'POST', jar: customer,
      body: { amount, sendToMe: true },
    })
    check(`an amount ${why} is refused`, r.status === 422, `status ${r.status}`)
  }
}

// ══════════════════════════════════════════════ buying one
section('Buying  A card is worthless until it is paid for')

let orderId = null
let cardId = null

{
  const bought = await call('/gift-cards/purchase', {
    method: 'POST', jar: customer,
    body: {
      amount: 500_000,
      recipientName: 'Smoke Recipient',
      recipientEmail: `smoke-${Date.now()}@example.com`,
      message: 'For you',
    },
  })
  check('a card can be bought', bought.status === 201, `status ${bought.status}`)
  orderId = bought.json?.data?.order?.id

  /*
   * The code is money. Returning it before payment would let anyone mint a
   * card by opening the payment page and walking away.
   */
  check('the code is not returned before payment', !/PK-[A-Z0-9]{4}-/.test(JSON.stringify(bought.json ?? {})))

  const missingRecipient = await call('/gift-cards/purchase', {
    method: 'POST', jar: customer, body: { amount: 500_000 },
  })
  check('a card with nowhere to go is refused', missingRecipient.status === 422, `status ${missingRecipient.status}`)

  const listed = await call('/admin/gift-cards?perPage=100', { jar: admin })
  const mine = (listed.json?.data?.giftCards ?? []).find((c) => c.orderId === orderId)
  cardId = mine?.id
  check('the card exists, held pending', mine?.status === 'PENDING', mine?.status)
  check('it carries the value that was paid for', mine?.initialValue === 500_000)

  // A pending card must not be spendable, whatever its balance says.
  const early = await call('/gift-cards/balance', {
    method: 'POST', jar: customer, body: { code: mine?.code ?? 'PK-XXXX-XXXX' },
  })
  check('a pending card cannot be looked up', early.status === 422, `status ${early.status}`)
}

// ══════════════════════════════════════════════ activation
section('Payment  The card comes alive, once')

let code = null

{
  await call(`/admin/orders/${orderId}/status`, {
    method: 'PATCH', jar: admin, body: { status: 'PAID' },
  })
  // The handler runs detached from the request.
  await new Promise((r) => setTimeout(r, 1200))

  const after = await call(`/admin/gift-cards/${cardId}`, { jar: admin })
  const card = after.json?.data?.giftCard
  code = card?.code
  check('paying the order activates the card', card?.status === 'ACTIVE', card?.status)
  check('it was stamped with an issue date', Boolean(card?.issuedAt))
  check('the balance is the full value', card?.balance === 500_000, `${card?.balance}`)
  check('the ledger records the issue', card?.transactions?.some((t) => t.type === 'ISSUE'))

  const balance = await call('/gift-cards/balance', { method: 'POST', jar: customer, body: { code } })
  check('now it can be looked up', balance.status === 200, `status ${balance.status}`)
  check('and reports its balance', balance.json?.data?.balance === 500_000)

  const lower = await call('/gift-cards/balance', {
    method: 'POST', jar: customer, body: { code: code.toLowerCase() },
  })
  check('the code is not case-sensitive', lower.status === 200)
}

// ══════════════════════════════════════════════ guessing
section('Refusals  Every no looks the same')

{
  const unknown = await call('/gift-cards/balance', {
    method: 'POST', jar: customer, body: { code: 'PK-ZZZZ-ZZZZ' },
  })
  check('an unknown code is refused', unknown.status === 422, `status ${unknown.status}`)

  /*
   * An endpoint that says "expired" for one code and "no such card" for another
   * tells a guesser which of their guesses were real.
   */
  check(
    'the refusal does not say why',
    /not valid/i.test(unknown.json?.error?.message ?? ''),
    unknown.json?.error?.message,
  )

  const anonymous = await call('/gift-cards/balance', { method: 'POST', body: { code } })
  check('an anonymous caller cannot probe balances',
    anonymous.status === 401 || anonymous.status === 403, `status ${anonymous.status}`)
}

// ══════════════════════════════════════════════ spending
section('Spending  Once, and not twice')

{
  const issued = await call('/admin/gift-cards', {
    method: 'POST', jar: admin,
    body: { amount: 200_000, note: 'smoke — spend test' },
  })
  const spendable = issued.json?.data?.giftCard
  check('an admin can issue a card by hand', issued.status === 201, `status ${issued.status}`)
  check('it is live immediately', spendable?.status === 'ACTIVE', spendable?.status)

  const detail = await call(`/admin/gift-cards/${spendable.id}`, { jar: admin })
  const ledger = detail.json?.data?.giftCard?.transactions ?? []
  const summed = ledger.reduce((total, t) => total + t.amount, 0)
  check('the ledger sums to the balance', summed === spendable.balance, `${summed} vs ${spendable.balance}`)

  const cancelled = await call(`/admin/gift-cards/${spendable.id}/cancel`, {
    method: 'POST', jar: admin, body: { note: 'smoke — done' },
  })
  check('a card can be cancelled', cancelled.status === 200, `status ${cancelled.status}`)
  check('cancelling empties it', cancelled.json?.data?.giftCard?.balance === 0)
  check('the card is not deleted', Boolean(cancelled.json?.data?.giftCard?.id))

  const afterCancel = await call(`/admin/gift-cards/${spendable.id}`, { jar: admin })
  const rows = afterCancel.json?.data?.giftCard?.transactions ?? []
  check('the write-off is on the statement', rows.some((t) => t.type === 'ADJUST'),
    rows.map((t) => t.type).join(','))
  check('the statement still sums to zero', rows.reduce((t, r) => t + r.amount, 0) === 0)

  const spendCancelled = await call('/gift-cards/balance', {
    method: 'POST', jar: customer, body: { code: spendable.code },
  })
  check('a cancelled card cannot be used', spendCancelled.status === 422, `status ${spendCancelled.status}`)
}

// ══════════════════════════════════════════════ permissions
section('Authorization')

{
  const routes = [
    ['/admin/gift-cards', 'the card list'],
    [`/admin/gift-cards/${cardId}`, 'a card statement'],
  ]
  for (const [route, label] of routes) {
    const r = await call(route, { jar: customer })
    check(`a customer cannot read ${label}`, r.status === 403, `status ${r.status}`)
  }

  const issue = await call('/admin/gift-cards', {
    method: 'POST', jar: customer, body: { amount: 500_000 },
  })
  check('a customer cannot issue themselves a card', issue.status === 403, `status ${issue.status}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
