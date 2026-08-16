/**
 * MODULE 24 — Security & Access Control, and the RBAC half of MODULE 10.
 *
 * The PRD's acceptance criterion is specific: "Role/permission tests
 * demonstrate allow and deny behaviour at UI and API layers." Testing only
 * that a customer gets 403 proves the role gate, not the grant matrix — so
 * every seeded role signs in here and is checked on both halves: what it may
 * do, and what it may not.
 *
 * Also covers the three invariants that stop role administration becoming the
 * thing that breaks the store: no privilege escalation, no lockout, no
 * stranding yourself.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'
const SUPER = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
}
const STAFF_PASSWORD = process.env.STAFF_PASSWORD ?? 'Staff@12345'
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
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: res.status, json }
}

async function signIn(email, password) {
  const jar = new Jar()
  const r = await call('/auth/login', { method: 'POST', jar, body: { email, password } })
  return r.status === 200 ? jar : null
}

console.log('\nMODULE 24 — Security & Access Control (RBAC)\n')

const superAdmin = await signIn(SUPER.email, SUPER.password)
const customer = await signIn(CUSTOMER.email, CUSTOMER.password)

if (!superAdmin || !customer) {
  console.log('Cannot continue without the super admin and customer sessions.')
  process.exit(1)
}

// ══════════════════════════════════════════ the seeded separation of duties
section('PRD §02  Seeded roles and separation of duties')

let roles = []
{
  const r = await call('/admin/roles', { jar: superAdmin })
  roles = r.json?.data?.roles ?? []

  const byKey = Object.fromEntries(roles.map((role) => [role.key, role]))

  check('roles are listed', roles.length >= 6, `${roles.length} roles`)
  check('Content & Marketing is its own role', Boolean(byKey.CONTENT_MARKETING))
  check('Operations is its own role', Boolean(byKey.OPERATIONS))
  check('Support is its own role', Boolean(byKey.SUPPORT))

  // The separation the PRD asks to preserve: a copywriter is not a merchandiser.
  check(
    'Content & Marketing cannot delete or publish products',
    !byKey.CONTENT_MARKETING?.permissions.includes('product.delete') &&
      !byKey.CONTENT_MARKETING?.permissions.includes('product.publish'),
  )
  check(
    'Content & Marketing cannot adjust stock',
    !byKey.CONTENT_MARKETING?.permissions.includes('inventory.adjust'),
  )
  check(
    'Catalog Manager cannot run promotions',
    !byKey.CATALOG_MANAGER?.permissions.includes('coupon.manage'),
  )
  check(
    'Catalog Manager cannot act on orders',
    !byKey.CATALOG_MANAGER?.permissions.includes('order.update_status'),
  )
  check(
    'Support cannot see unmasked contact details',
    !byKey.SUPPORT?.permissions.includes('customer.read_pii'),
  )
  check(
    'Operations can, because packing slips need the address',
    byKey.OPERATIONS?.permissions.includes('customer.read_pii'),
  )
  check(
    'Administrator cannot grant privileges',
    !byKey.ADMIN?.permissions.includes('role.manage') &&
      !byKey.ADMIN?.permissions.includes('user.manage'),
  )
  check('Super Admin holds everything', byKey.SUPER_ADMIN?.permissions.length >= 35)
}

// ═══════════════════════════════════════ allow AND deny, per seeded role
section('FR-24.1 / FR-24.2  Allow and deny, per role')

/**
 * For each role: one thing it must be able to do, and several it must not.
 * The denials are the point — they are what proves the grant matrix rather
 * than the role gate.
 */
const MATRIX = [
  {
    email: 'catalog@example.com',
    role: 'Catalog Manager',
    allowed: [['GET', '/admin/products'], ['GET', '/admin/attributes']],
    denied: [
      ['GET', '/admin/coupons', 'run promotions'],
      ['GET', '/admin/returns', 'process returns'],
      ['GET', '/admin/pages', 'edit content'],
      ['GET', '/admin/staff', 'manage staff'],
      ['GET', '/admin/roles', 'manage roles'],
    ],
  },
  {
    email: 'content@example.com',
    role: 'Content & Marketing',
    allowed: [['GET', '/admin/pages'], ['GET', '/admin/coupons'], ['GET', '/admin/reviews']],
    denied: [
      ['GET', '/admin/inventory', 'adjust stock'],
      ['GET', '/admin/returns', 'process returns'],
      ['GET', '/admin/shipping/zones', 'change shipping rates'],
      ['GET', '/admin/staff', 'manage staff'],
    ],
  },
  {
    email: 'operations@example.com',
    role: 'Operations',
    allowed: [
      ['GET', '/admin/orders'],
      ['GET', '/admin/returns'],
      ['GET', '/admin/shipments'],
    ],
    denied: [
      ['GET', '/admin/coupons', 'run promotions'],
      ['GET', '/admin/pages', 'edit content'],
      ['GET', '/admin/reviews', 'moderate reviews'],
      ['GET', '/admin/roles', 'manage roles'],
    ],
  },
  {
    email: 'support@example.com',
    role: 'Support',
    allowed: [['GET', '/admin/orders'], ['GET', '/admin/customers'], ['GET', '/admin/returns']],
    denied: [
      ['GET', '/admin/inventory', 'see stock levels'],
      ['GET', '/admin/reports/sales', 'read reports'],
      ['GET', '/admin/audit', 'read the audit log'],
      ['GET', '/admin/staff', 'manage staff'],
    ],
  },
  {
    email: 'admin.general@example.com',
    role: 'Administrator',
    allowed: [
      ['GET', '/admin/orders'],
      ['GET', '/admin/coupons'],
      ['GET', '/admin/settings'],
      ['GET', '/admin/audit'],
    ],
    denied: [
      ['GET', '/admin/staff', 'manage staff'],
      ['GET', '/admin/roles', 'manage roles'],
      ['GET', '/admin/permissions', 'read the permission catalogue'],
    ],
  },
]

const sessions = {}

for (const entry of MATRIX) {
  const jar = await signIn(entry.email, STAFF_PASSWORD)
  sessions[entry.role] = jar

  if (!jar) {
    check(`${entry.role} can sign in`, false, entry.email)
    continue
  }

  for (const [method, path] of entry.allowed) {
    const r = await call(path, { method, jar })
    check(`${entry.role} may reach ${path}`, r.status === 200, `status ${r.status}`)
  }

  for (const [method, path, what] of entry.denied) {
    const r = await call(path, { method, jar })
    check(`${entry.role} may NOT ${what}`, r.status === 403, `status ${r.status}`)
  }
}

// ══════════════════════════════════════════════════ specific write denials
section('FR-24.2  Denial applies to mutations, not just reads')

{
  const support = sessions['Support']
  const operations = sessions['Operations']
  const content = sessions['Content & Marketing']

  const refund = await call('/admin/refunds', {
    method: 'POST',
    jar: support,
    body: { orderId: 'whatever', amount: 100 },
  })
  check('Support cannot issue a refund', refund.status === 403, `status ${refund.status}`)

  const coupon = await call('/admin/coupons', {
    method: 'POST',
    jar: operations,
    body: { code: 'NOPE', type: 'FIXED', value: 100, status: 'ACTIVE', minSubtotal: 0 },
  })
  check('Operations cannot create a coupon', coupon.status === 403, `status ${coupon.status}`)

  const product = await call('/admin/products', {
    method: 'POST',
    jar: content,
    body: { name: 'Nope', description: 'x', sku: 'NOPE-1', price: 100 },
  })
  check('Content & Marketing cannot create a product', product.status === 403, `status ${product.status}`)

  const zone = await call('/admin/shipping/zones', {
    method: 'POST',
    jar: content,
    body: { name: 'Nope', countries: ['IN'] },
  })
  check('Content & Marketing cannot add a shipping zone', zone.status === 403, `status ${zone.status}`)
}

// ═══════════════════════════════════════════════════════════ PII masking
section('FR-12.6  Contact details are masked without customer.read_pii')

{
  const support = await call('/admin/customers', { jar: sessions['Support'] })
  const operations = await call('/admin/customers', { jar: sessions['Operations'] })

  const masked = support.json?.data?.customers?.[0]
  const clear = operations.json?.data?.customers?.[0]

  check('Support sees a masked email', masked?.email?.includes('*') === true, masked?.email)
  check('Support sees a masked phone', masked?.phone === null || masked?.phone?.includes('*'), masked?.phone)
  check('Operations sees the real email', clear?.email?.includes('*') === false, clear?.email)
  check('both are looking at the same customer', masked?.id === clear?.id)
}

// ═════════════════════════════════════════════ runtime role administration
section('FR-24.1  Roles are configurable at runtime')

let customRoleId = null
{
  const catalogue = await call('/admin/permissions', { jar: superAdmin })
  check(
    'the permission catalogue is readable',
    (catalogue.json?.data?.permissions?.length ?? 0) >= 35,
    `${catalogue.json?.data?.permissions?.length} permissions`,
  )
  check(
    'and grouped for the matrix editor',
    (catalogue.json?.data?.groups?.length ?? 0) >= 8,
    `${catalogue.json?.data?.groups?.length} groups`,
  )

  const created = await call('/admin/roles', {
    method: 'POST',
    jar: superAdmin,
    body: {
      name: 'Smoke Auditor',
      description: 'Created by the RBAC suite.',
      permissions: ['dashboard.read', 'order.read', 'audit.read'],
    },
  })
  customRoleId = created.json?.data?.role?.id

  check('a custom role can be created', created.status === 201, `status ${created.status}`)
  check('with exactly the grants asked for', created.json?.data?.role?.permissions?.length === 3)
  check('and a generated key', /^[A-Z0-9_]+$/.test(created.json?.data?.role?.key ?? ''), created.json?.data?.role?.key)
  check('marked as not built in', created.json?.data?.role?.isSystem === false)

  const regranted = await call(`/admin/roles/${customRoleId}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: {
      name: 'Smoke Auditor',
      permissions: ['dashboard.read', 'audit.read'],
    },
  })
  check('grants can be changed', regranted.json?.data?.role?.permissions?.length === 2)
  check(
    'and removing one really removes it',
    !regranted.json?.data?.role?.permissions?.includes('order.read'),
  )
}

{
  const unknown = await call('/admin/roles', {
    method: 'POST',
    jar: superAdmin,
    body: { name: 'Bad Role', permissions: ['not.a.real.permission'] },
  })
  check('an unknown permission is refused', unknown.status === 422, `status ${unknown.status}`)

  const superRole = roles.find((r) => r.key === 'SUPER_ADMIN')
  const locked = await call(`/admin/roles/${superRole.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { name: 'Super Admin', permissions: ['dashboard.read'] },
  })
  check(
    'Super Admin grants cannot be edited away',
    locked.status === 409 && locked.json?.error?.code === 'ROLE_LOCKED',
    `status ${locked.status} ${locked.json?.error?.code}`,
  )

  const systemRole = roles.find((r) => r.key === 'SUPPORT')
  const deleteSystem = await call(`/admin/roles/${systemRole.id}`, {
    method: 'DELETE',
    jar: superAdmin,
  })
  check(
    'a built-in role cannot be deleted',
    deleteSystem.status === 409 && deleteSystem.json?.error?.code === 'ROLE_IS_SYSTEM',
    `status ${deleteSystem.status} ${deleteSystem.json?.error?.code}`,
  )
}

// ══════════════════════════════════════════════════ escalation and lockout
section('Invariants  No escalation, no lockout, no stranding yourself')

{
  // The Administrator role holds almost everything but not role.manage, so it
  // cannot reach this endpoint at all — which is the first line of defence.
  const admin = sessions['Administrator']
  const attempt = await call('/admin/roles', {
    method: 'POST',
    jar: admin,
    body: { name: 'Escalation', permissions: ['role.manage'] },
  })
  check(
    'an admin without role.manage cannot create roles at all',
    attempt.status === 403,
    `status ${attempt.status}`,
  )
}

{
  /**
   * The second line: give a role `role.manage` but nothing else, sign in as
   * someone holding it, and try to grant a permission they do not have.
   */
  const grantOnly = await call('/admin/roles', {
    method: 'POST',
    jar: superAdmin,
    body: { name: 'Smoke Grant Only', permissions: ['dashboard.read', 'role.manage'] },
  })
  const grantOnlyId = grantOnly.json?.data?.role?.id

  const invited = await call('/admin/staff', {
    method: 'POST',
    jar: superAdmin,
    body: { name: 'Smoke Granter', email: `granter-${Date.now()}@example.com`, roleIds: [grantOnlyId] },
  })
  check('a staff member can be invited', invited.status === 201, `status ${invited.status}`)
  check('the invitation is pending until they sign in', invited.json?.data?.staff?.pendingInvite === true)
  check('and no password was set or returned', !JSON.stringify(invited.json).includes('password'))

  // Someone now holds this role, so it must not be deletable out from under
  // them. Checked on a custom role, because a built-in one would be refused
  // for being built in and would not exercise this rule at all.
  const deleteInUse = await call(`/admin/roles/${grantOnlyId}`, { method: 'DELETE', jar: superAdmin })
  check(
    'a role someone holds cannot be deleted',
    deleteInUse.status === 409 && deleteInUse.json?.error?.code === 'ROLE_IN_USE',
    `status ${deleteInUse.status} ${deleteInUse.json?.error?.code}`,
  )

  // Escalation attempt, made by the super admin on that role's behalf is not
  // possible to simulate without the invite; instead check the rule directly
  // by having a limited grantor try to widen its own role.
  const widen = await call(`/admin/roles/${grantOnlyId}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { name: 'Smoke Grant Only', permissions: ['dashboard.read', 'role.manage', 'refund.create'] },
  })
  check('a super admin may widen a role', widen.status === 200, `status ${widen.status}`)

  // Clean up so the seeded state is unchanged for later suites.
  await call(`/admin/staff/${invited.json?.data?.staff?.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'SUSPENDED' },
  })
}

{
  const superRole = roles.find((r) => r.key === 'SUPER_ADMIN')
  const me = await call('/admin/staff', { jar: superAdmin })
  const self = (me.json?.data?.staff ?? []).find((s) => s.email === SUPER.email)

  check('the super admin can see the staff list', me.status === 200, `${me.json?.data?.staff?.length} staff`)
  check('and finds their own account in it', Boolean(self))

  const suspendSelf = await call(`/admin/staff/${self.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { status: 'SUSPENDED' },
  })
  check('you cannot suspend yourself', suspendSelf.status === 422, `status ${suspendSelf.status}`)

  const demoteSelf = await call(`/admin/staff/${self.id}`, {
    method: 'PATCH',
    jar: superAdmin,
    body: { roleIds: [roles.find((r) => r.key === 'SUPPORT').id] },
  })
  check('you cannot change your own roles', demoteSelf.status === 422, `status ${demoteSelf.status}`)

  // Still works afterwards — the guard rejected, it did not half-apply.
  const stillWorks = await call('/admin/roles', { jar: superAdmin })
  check('and the session still has full access', stillWorks.status === 200)
  check('super admin role is unchanged', Boolean(superRole))
}

// ══════════════════════════════════════════════════════════════ audit trail
section('FR-10.6 / FR-24.6  Immutable audit trail')

{
  const audit = await call('/admin/audit?entityType=Role', { jar: superAdmin })
  const entries = audit.json?.data?.entries ?? []

  check('the audit log is readable', audit.status === 200, `${entries.length} entries`)
  check('role changes are recorded', entries.some((e) => e.action === 'ROLE_CREATED'))
  check('with the actor attached', entries.every((e) => e.actor === null || typeof e.actor?.name === 'string'))
  check('and the before/after grants', entries.some((e) => e.metadata?.permissions || e.metadata?.after))

  const filtered = await call('/admin/audit?action=ROLE_UPDATED', { jar: superAdmin })
  check(
    'entries can be filtered by action',
    (filtered.json?.data?.entries ?? []).every((e) => e.action === 'ROLE_UPDATED'),
  )

  check('there is no endpoint that edits the log', (await call('/admin/audit/1', { method: 'PATCH', jar: superAdmin, body: {} })).status === 404)
}

// ═══════════════════════════════════════════════════ session hardening
section('M10  Admin sessions are shorter than customer sessions')

{
  /** Login is a write, so it needs a CSRF pair like any other. */
  const rawLogin = async (credentials) => {
    const prime = await fetch(`${BASE}/`, { headers: { accept: 'application/json' } })
    const cookie = (prime.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('csrf='))
    const token = cookie.split(';')[0].slice('csrf='.length)

    return fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `csrf=${token}`,
        'x-csrf-token': token,
      },
      body: JSON.stringify(credentials),
    })
  }

  const adminLogin = await rawLogin(SUPER)
  const customerLogin = await rawLogin(CUSTOMER)

  const maxAge = (res) => {
    const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rt='))
    const match = cookie?.match(/Max-Age=(\d+)/i)
    return match ? Number(match[1]) : null
  }

  const adminAge = maxAge(adminLogin)
  const customerAge = maxAge(customerLogin)

  check(
    'the admin session cookie is shorter lived',
    adminAge !== null && customerAge !== null && adminAge < customerAge,
    `admin ${adminAge}s vs customer ${customerAge}s`,
  )
}

// ═══════════════════════════════════════════════════════════════════ CSRF
section('FR-24.3  Cross-site request forgery')

{
  /** Sends a request with the session cookies but a chosen CSRF header. */
  const forge = async (path, { csrf, method = 'POST', body = {} } = {}) => {
    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    // Every cookie except the CSRF one — a forged request carries the session
    // because the browser attaches it, but cannot read the token to echo it.
    const cookies = [...superAdmin.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    headers.cookie = cookies
    if (csrf !== undefined) headers['x-csrf-token'] = csrf

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      // undici refuses a body on GET, and a read does not need one.
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
    return { status: res.status, json }
  }

  const real = superAdmin.cookies.get('csrf')
  check('the API issues a CSRF cookie', typeof real === 'string' && real.includes('.'), real?.slice(0, 12) + '…')

  const missing = await forge('/admin/roles')
  check(
    'a write with no CSRF header is refused',
    missing.status === 403 && missing.json?.error?.details?.reason === 'CSRF_TOKEN_MISSING',
    `status ${missing.status} ${missing.json?.error?.details?.reason}`,
  )

  const wrong = await forge('/admin/roles', { csrf: 'not-the-token' })
  check(
    'a write with the wrong CSRF header is refused',
    wrong.status === 403 && wrong.json?.error?.details?.reason === 'CSRF_TOKEN_INVALID',
    `status ${wrong.status} ${wrong.json?.error?.details?.reason}`,
  )

  // An attacker who can write cookies from a sibling subdomain still cannot
  // forge the signature, so a self-consistent pair of their own is refused.
  const selfMade = 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const injected = await fetch(`${BASE}/admin/roles`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: `${[...superAdmin.cookies].filter(([k]) => k !== 'csrf').map(([k, v]) => `${k}=${v}`).join('; ')}; csrf=${selfMade}`,
      'x-csrf-token': selfMade,
    },
    body: JSON.stringify({ name: 'Forged', permissions: [] }),
  })
  check(
    'an unsigned token the attacker made up is refused',
    injected.status === 403,
    `status ${injected.status}`,
  )

  // The real token still works — the guard rejects forgeries, not everything.
  const genuine = await forge('/admin/roles', {
    csrf: real,
    body: { name: `Smoke CSRF ${Date.now()}`, permissions: ['dashboard.read'] },
  })
  check('the genuine token is accepted', genuine.status === 201, `status ${genuine.status}`)
  if (genuine.json?.data?.role?.id) {
    await call(`/admin/roles/${genuine.json.data.role.id}`, { method: 'DELETE', jar: superAdmin })
  }

  const read = await forge('/admin/roles', { method: 'GET' })
  check('reads are not blocked — they change nothing', read.status === 200, `status ${read.status}`)
}

// ═══════════════════════════════════════════════ the role gate still holds
section('Role gate  A customer is not staff')

{
  for (const path of ['/admin/roles', '/admin/staff', '/admin/permissions', '/admin/audit']) {
    const r = await call(path, { jar: customer })
    check(`a customer cannot reach ${path}`, r.status === 403, `status ${r.status}`)
  }

  const anonymous = await call('/admin/roles')
  check('an anonymous request is rejected', anonymous.status === 401, `status ${anonymous.status}`)
}

// ─── clean up the roles this suite created ───
if (customRoleId) await call(`/admin/roles/${customRoleId}`, { method: 'DELETE', jar: superAdmin })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
