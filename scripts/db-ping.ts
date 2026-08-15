/** Reports which database the app would actually talk to, and whether it works. */
import { PrismaClient } from '@prisma/client'
import { ensureDatabase } from '../src/config/embedded-db.js'

const db = await ensureDatabase()
console.log('resolved URL =', db.url.replace(/:[^:@]+@/, ':****@'), db.started ? '(started by us)' : '(already running)')

const prisma = new PrismaClient({ datasources: { db: { url: db.url } } })
try {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
  const [users, products] = await Promise.all([prisma.user.count(), prisma.product.count()])
  console.log('OK —', rows[0]?.now, `| users: ${users} | products: ${products}`)
} catch (err) {
  const message = err instanceof Error ? err.message.trim() : String(err)
  console.error('FAILED:', message.split('\n').filter(Boolean).join(' | '))
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
  if (db.started) await db.stop()
}
