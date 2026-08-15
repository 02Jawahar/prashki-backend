/**
 * STEP 3 verification — exercises the real HTTP surface, cookies and all.
 * Run with the backend up:  node backend/scripts/smoke-auth.mjs
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4100/api/v1'

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

/** Minimal cookie jar so we can hold separate admin and customer sessions. */
class Jar {
  constructor() {
    this.cookies = new Map()
  }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const idx = pair.indexOf('=')
      const name = pair.slice(0, idx).trim()
      const value = pair.slice(idx + 1).trim()
      if (value === '' ) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  has(name) {
    return this.cookies.has(name)
  }
}

async function call(path, { method = 'GET', body, jar } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (jar?.header()) headers.cookie = jar.header()

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  jar?.absorb(res)
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

console.log('\nSTEP 3 — authentication\n')

// ---------------------------------------------------------------- anonymous
{
  const r = await call('/auth/me')
  check('GET /auth/me is 401 when anonymous', r.status === 401, `got ${r.status} ${r.json?.error?.code}`)
}

// ----------------------------------------------------------------- customer
const customerJar = new Jar()
{
  const r = await call('/auth/login', {
    method: 'POST',
    jar: customerJar,
    body: { email: 'customer@example.com', password: 'Customer@12345' },
  })
  check('customer can log in', r.status === 200 && r.json?.success === true, `status ${r.status}`)
  check('access + refresh cookies are set', customerJar.has('at') && customerJar.has('rt'))
  check('customer role is CUSTOMER', r.json?.data?.user?.role === 'CUSTOMER')
  check('no password hash in response', !JSON.stringify(r.json).includes('passwordHash'))
}
{
  const r = await call('/auth/me', { jar: customerJar })
  check('GET /auth/me works with session', r.status === 200 && r.json?.data?.user?.email === 'customer@example.com')
  check('customer has no admin permissions', (r.json?.data?.user?.permissions ?? []).length === 0)
}

// wrong password
{
  const r = await call('/auth/login', {
    method: 'POST',
    body: { email: 'customer@example.com', password: 'wrong-password' },
  })
  check('wrong password is rejected', r.status === 401, `${r.json?.error?.code}`)
}

// unknown email must look identical to a wrong password
{
  const r = await call('/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'whatever123' },
  })
  check(
    'unknown email gives the same error as a wrong password',
    r.status === 401 && r.json?.error?.code === 'INVALID_CREDENTIALS',
    r.json?.error?.code,
  )
}

// validation
{
  const r = await call('/auth/register', { method: 'POST', body: { name: 'x', email: 'nope', password: 'short' } })
  check('registration validates input', r.status === 422 && r.json?.error?.code === 'VALIDATION_ERROR')
}

// ------------------------------------------------------------------- admin
const adminJar = new Jar()
{
  const r = await call('/auth/login', {
    method: 'POST',
    jar: adminJar,
    body: { email: 'admin@example.com', password: 'Admin@12345' },
  })
  check('admin can log in', r.status === 200, `status ${r.status}`)
  check('admin role is ADMIN', r.json?.data?.user?.role === 'ADMIN')
  const perms = r.json?.data?.user?.permissions ?? []
  check('admin carries permissions', perms.length >= 20, `${perms.length} permissions`)
}

// ------------------------------------------------------------------ rotation
{
  const before = adminJar.cookies.get('rt')
  const r = await call('/auth/refresh', { method: 'POST', jar: adminJar })
  const after = adminJar.cookies.get('rt')
  check('refresh returns a new session', r.status === 200)
  check('refresh token is rotated', before !== after)

  // Replaying the old token must be detected and kill the family.
  const replayJar = new Jar()
  replayJar.cookies.set('rt', before)
  const replay = await call('/auth/refresh', { method: 'POST', jar: replayJar })
  check(
    'replaying a rotated refresh token is rejected',
    replay.status === 401 && replay.json?.error?.code === 'TOKEN_REUSE_DETECTED',
    replay.json?.error?.code,
  )

  // ...and the reuse should have revoked the whole family.
  const afterReuse = await call('/auth/refresh', { method: 'POST', jar: adminJar })
  check('token reuse revokes the whole family', afterReuse.status === 401, `status ${afterReuse.status}`)
}

// -------------------------------------------------------------- new sign-up
{
  const jar = new Jar()
  const email = `smoke_${Date.now()}@example.com`
  const r = await call('/auth/register', {
    method: 'POST',
    jar,
    body: { name: 'Smoke Test', email, password: 'Password@123' },
  })
  check('registration succeeds', r.status === 201, `status ${r.status}`)
  check('self-registration can only create a CUSTOMER', r.json?.data?.user?.role === 'CUSTOMER')

  const dup = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Smoke Test', email, password: 'Password@123' },
  })
  check('duplicate email is rejected', dup.status === 409 && dup.json?.error?.code === 'EMAIL_TAKEN')

  const out = await call('/auth/logout', { method: 'POST', jar })
  check('logout clears cookies', out.status === 200 && !jar.has('at') && !jar.has('rt'))

  const after = await call('/auth/me', { jar })
  check('session is dead after logout', after.status === 401)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
