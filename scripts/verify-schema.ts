/**
 * Development check that the seeded graph is actually connected — that STEP 2
 * produced relationships, not just rows.
 */
import { PrismaClient } from '@prisma/client'
import { env } from '../src/config/env.js'

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })

const checks: Array<[string, () => Promise<boolean>, () => Promise<string>]> = [
  [
    'admin user resolves to permissions through roles',
    async () => {
      const admin = await prisma.user.findFirst({
        where: { role: 'ADMIN' },
        include: { roles: { include: { role: { include: { permissions: true } } } } },
      })
      return (admin?.roles[0]?.role.permissions.length ?? 0) > 0
    },
    async () => {
      const admin = await prisma.user.findFirst({
        where: { role: 'ADMIN' },
        include: { roles: { include: { role: { include: { permissions: true } } } } },
      })
      return `${admin?.email} -> ${admin?.roles.map((r) => r.role.key).join(',')} -> ${admin?.roles[0]?.role.permissions.length} perms`
    },
  ],
  [
    'every product has a category, images and at least one variant',
    async () => {
      const bad = await prisma.product.count({
        where: { OR: [{ categoryId: null }, { images: { none: {} } }, { variants: { none: {} } }] },
      })
      return bad === 0
    },
    async () => `${await prisma.product.count()} products checked`,
  ],
  [
    'every variant has exactly one inventory row',
    async () => {
      const variants = await prisma.productVariant.count()
      const inv = await prisma.inventory.count()
      const orphan = await prisma.productVariant.count({ where: { inventory: null } })
      return variants === inv && orphan === 0
    },
    async () => `${await prisma.productVariant.count()} variants / ${await prisma.inventory.count()} inventory rows`,
  ],
  [
    'inventory balance matches its movement ledger',
    async () => {
      const rows = await prisma.inventory.findMany({ include: { movements: true } })
      return rows.every(
        (r) => r.movements.reduce((sum, m) => sum + m.quantity, 0) === r.availableStock,
      )
    },
    async () => `${await prisma.inventoryMovement.count()} movements`,
  ],
  [
    'categories form a tree under a parent',
    async () => (await prisma.category.count({ where: { parentId: { not: null } } })) > 0,
    async () => {
      const parents = await prisma.category.findMany({
        where: { parentId: null },
        include: { children: true },
      })
      return parents.map((p) => `${p.slug}(${p.children.length} children)`).join(', ')
    },
  ],
  [
    'customer has an address',
    async () => (await prisma.address.count()) > 0,
    async () => `${await prisma.address.count()} addresses`,
  ],
  [
    'settings include navigation and homepage config',
    async () =>
      (await prisma.setting.count({ where: { key: { in: ['nav.main', 'home.sections'] } } })) === 2,
    async () => `${await prisma.setting.count()} settings`,
  ],
  [
    'money is integer paise, never fractional',
    async () => {
      const products = await prisma.product.findMany({ select: { price: true, compareAtPrice: true } })
      return products.every(
        (p) => Number.isInteger(p.price) && (p.compareAtPrice === null || Number.isInteger(p.compareAtPrice)),
      )
    },
    async () => {
      const agg = await prisma.product.aggregate({ _min: { price: true }, _max: { price: true } })
      return `range ₹${(agg._min.price ?? 0) / 100} – ₹${(agg._max.price ?? 0) / 100}`
    },
  ],
]

let failures = 0
for (const [name, check, detail] of checks) {
  const passed = await check()
  if (!passed) failures++
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${await detail()}`)
}

console.log(failures === 0 ? '\nAll relationship checks passed.' : `\n${failures} check(s) failed.`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
