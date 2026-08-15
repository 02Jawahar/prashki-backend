/**
 * Development seed (spec §60).
 *
 * Safe to re-run: everything is wiped first, so `npm run db:seed` always lands
 * on the same known state.
 *
 * Credentials come from the environment (spec §6, §61) — never hard-coded here.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient, Prisma } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { env } from '../src/config/env.js'

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })

const here = path.dirname(fileURLToPath(import.meta.url))
// prisma/ -> repository root
const REPO_ROOT = path.resolve(here, '..')

// ---------------------------------------------------------------------------
// Permissions and roles
// ---------------------------------------------------------------------------

const PERMISSIONS = [
  { key: 'dashboard.read', group: 'Dashboard', label: 'View the dashboard' },

  { key: 'product.read', group: 'Catalog', label: 'View products' },
  { key: 'product.create', group: 'Catalog', label: 'Create products' },
  { key: 'product.update', group: 'Catalog', label: 'Edit products' },
  { key: 'product.delete', group: 'Catalog', label: 'Delete products' },
  { key: 'product.publish', group: 'Catalog', label: 'Publish and unpublish products' },
  { key: 'category.manage', group: 'Catalog', label: 'Manage categories' },
  { key: 'media.upload', group: 'Catalog', label: 'Upload product media' },

  { key: 'inventory.read', group: 'Inventory', label: 'View stock' },
  { key: 'inventory.adjust', group: 'Inventory', label: 'Adjust stock' },

  { key: 'order.read', group: 'Orders', label: 'View orders' },
  { key: 'order.update_status', group: 'Orders', label: 'Change order status' },
  { key: 'order.cancel', group: 'Orders', label: 'Cancel orders' },

  { key: 'customer.read', group: 'Customers', label: 'View customers' },
  { key: 'customer.update', group: 'Customers', label: 'Edit customers' },

  { key: 'settings.read', group: 'Settings', label: 'View settings' },
  { key: 'settings.update', group: 'Settings', label: 'Change settings' },

  { key: 'user.manage', group: 'System', label: 'Manage staff accounts' },
  { key: 'role.manage', group: 'System', label: 'Manage roles' },
  { key: 'audit.read', group: 'System', label: 'Read the audit log' },
] as const

const ALL = PERMISSIONS.map((p) => p.key)

const ROLES = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Unrestricted access, including staff and role management.',
    permissions: ALL,
  },
  {
    key: 'CATALOG_MANAGER',
    name: 'Catalog Manager',
    description: 'Products, categories, media and stock.',
    permissions: [
      'dashboard.read', 'product.read', 'product.create', 'product.update',
      'product.delete', 'product.publish', 'category.manage', 'media.upload',
      'inventory.read', 'inventory.adjust', 'order.read',
    ],
  },
  {
    key: 'ORDER_MANAGER',
    name: 'Order Manager',
    description: 'Order fulfilment and customer lookup.',
    permissions: [
      'dashboard.read', 'product.read', 'inventory.read', 'order.read',
      'order.update_status', 'order.cancel', 'customer.read',
    ],
  },
  {
    key: 'SUPPORT',
    name: 'Support',
    description: 'Read-only access for answering customer questions.',
    permissions: ['dashboard.read', 'product.read', 'order.read', 'customer.read'],
  },
] as const

// ---------------------------------------------------------------------------
// Catalogue source
// ---------------------------------------------------------------------------

interface CatalogProduct {
  handle: string
  title: string
  subtitle?: string
  description: string
  fabric?: string
  price: number
  compareAtPrice?: number
  collections: string[]
  optionSet: 'size' | 'topbottom' | 'onesize'
  isBestseller?: boolean
}

/** Only these five ship in the boilerplate (spec §60). */
const CATEGORY_DEFS = [
  { slug: 'dresses', name: 'Dresses', description: 'Fluid silhouettes in hand-finished cloth.' },
  { slug: 'kurta-sets', name: 'Kurta Sets', description: 'Considered separates, made to be worn together.' },
  { slug: 'co-ord-sets', name: 'Co-ord Sets', description: 'Matched sets, cut to move together.' },
  { slug: 'sarees', name: 'Sarees', description: 'Handwoven and hand-finished, six yards at a time.' },
  { slug: 'accessories', name: 'Accessories', description: 'Small objects, carefully made.' },
]

const CATEGORY_SLUGS = new Set(CATEGORY_DEFS.map((c) => c.slug))

const SIZES = ['S', 'M', 'L', 'XL']

/** Deterministic stock so re-seeding gives identical numbers. */
function seededInt(key: string, min: number, max: number): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return min + (Math.abs(h) % (max - min + 1))
}

function skuBase(slug: string): string {
  return slug
    .split('-')
    .slice(0, 2)
    .map((w) => w.slice(0, 3).toUpperCase())
    .join('')
}

// ---------------------------------------------------------------------------

async function wipe() {
  // Children before parents where cascades don't cover it.
  await prisma.auditLog.deleteMany()
  await prisma.webhookEvent.deleteMany()
  await prisma.paymentTransaction.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.orderStatusHistory.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.cartItem.deleteMany()
  await prisma.cart.deleteMany()
  await prisma.inventoryMovement.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.productImage.deleteMany()
  await prisma.productVariant.deleteMany()
  await prisma.product.deleteMany()
  await prisma.category.deleteMany()
  await prisma.address.deleteMany()
  await prisma.refreshToken.deleteMany()
  await prisma.rolePermission.deleteMany()
  await prisma.userRoleAssignment.deleteMany()
  await prisma.user.deleteMany()
  await prisma.role.deleteMany()
  await prisma.permission.deleteMany()
  await prisma.setting.deleteMany()
}

async function seedRbac() {
  await prisma.permission.createMany({ data: PERMISSIONS as unknown as Prisma.PermissionCreateManyInput[] })
  const perms = await prisma.permission.findMany({ select: { id: true, key: true } })
  const permId = new Map(perms.map((p) => [p.key, p.id]))

  for (const role of ROLES) {
    const created = await prisma.role.create({
      data: { key: role.key, name: role.name, description: role.description, isSystem: true },
    })
    await prisma.rolePermission.createMany({
      data: role.permissions
        .filter((k) => permId.has(k))
        .map((k) => ({ roleId: created.id, permissionId: permId.get(k)! })),
    })
  }
}

async function seedUsers() {
  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } })

  const admin = await prisma.user.create({
    data: {
      name: 'Store Admin',
      email: env.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await hash(env.ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
      roles: { create: { roleId: superAdmin.id } },
    },
  })

  const customer = await prisma.user.create({
    data: {
      name: 'Aditi Rao',
      email: env.CUSTOMER_EMAIL.toLowerCase(),
      phone: '+919810000000',
      passwordHash: await hash(env.CUSTOMER_PASSWORD),
      role: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  })

  await prisma.address.create({
    data: {
      userId: customer.id,
      label: 'Home',
      name: 'Aditi Rao',
      phone: '+919810000000',
      addressLine1: '14 Sunder Nagar',
      addressLine2: 'Ground Floor',
      city: 'New Delhi',
      state: 'Delhi',
      postalCode: '110003',
      country: 'IN',
      isDefault: true,
    },
  })

  return { admin, customer }
}

async function seedCategories() {
  const parent = await prisma.category.create({
    data: {
      name: "Women's",
      slug: 'womens',
      description: 'The full collection.',
      status: 'ACTIVE',
      sortOrder: 0,
    },
  })

  const ids = new Map<string, string>()
  for (const [i, def] of CATEGORY_DEFS.entries()) {
    const created = await prisma.category.create({
      data: {
        name: def.name,
        slug: def.slug,
        description: def.description,
        image: `/collections/${def.slug}.jpg`,
        status: 'ACTIVE',
        sortOrder: i + 1,
        parentId: parent.id,
      },
    })
    ids.set(def.slug, created.id)
  }
  return ids
}

async function seedProducts(categoryIds: Map<string, string>, adminId: string) {
  const catalog = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'data', 'catalog.json'), 'utf-8'),
  ) as { products: CatalogProduct[] }

  const eligible = catalog.products.filter((p) =>
    p.collections.some((c) => CATEGORY_SLUGS.has(c)),
  )

  let count = 0
  for (const [index, p] of eligible.entries()) {
    const categorySlug = p.collections.find((c) => CATEGORY_SLUGS.has(c))!
    const base = skuBase(p.handle)

    const product = await prisma.product.create({
      data: {
        name: p.title,
        slug: p.handle,
        description: p.description,
        shortDescription: p.subtitle ?? null,
        sku: `PK-${base}`,
        price: p.price,
        compareAtPrice: p.compareAtPrice ?? null,
        status: 'ACTIVE',
        featured: Boolean(p.isBestseller),
        categoryId: categoryIds.get(categorySlug)!,
        publishedAt: new Date(Date.now() - index * 36 * 60 * 60 * 1000),
        images: {
          create: [
            { url: `${env.STORAGE_PUBLIC_URL}/products/${p.handle}-1.jpg`, altText: p.title, sortOrder: 0 },
            { url: `${env.STORAGE_PUBLIC_URL}/products/${p.handle}-2.jpg`, altText: `${p.title} — detail`, sortOrder: 1 },
          ],
        },
      },
    })

    // Accessories are one-size; apparel gets S/M/L/XL. Single-SKU products still
    // get one variant so cart, order and inventory logic never branches.
    const variantNames = p.optionSet === 'onesize' ? ['Default'] : SIZES

    for (const [vi, name] of variantNames.entries()) {
      const sku = `PK-${base}-${name === 'Default' ? 'OS' : name}`
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          name,
          sku,
          price: null, // inherit the product price
          status: 'ACTIVE',
          position: vi,
        },
      })

      const stock = seededInt(sku, 4, 25)
      const inventory = await prisma.inventory.create({
        data: {
          variantId: variant.id,
          availableStock: stock,
          reservedStock: 0,
          lowStockThreshold: 5,
        },
      })

      // Opening balance is a ledger entry like any other.
      await prisma.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'INITIAL_STOCK',
          quantity: stock,
          balanceAfter: stock,
          reason: 'Opening stock (seed)',
          createdById: adminId,
        },
      })
    }
    count++
  }
  return count
}

async function seedSettings() {
  const settings: Array<{
    key: string
    value: string
    type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON'
    group: string
    label: string
  }> = [
    { key: 'store.name', value: 'Prash & Ki', type: 'STRING', group: 'general', label: 'Store name' },
    { key: 'store.email', value: 'care@example.com', type: 'STRING', group: 'general', label: 'Store email' },
    { key: 'store.phone', value: '+91 98100 00000', type: 'STRING', group: 'general', label: 'Store phone' },
    { key: 'store.currency', value: 'INR', type: 'STRING', group: 'general', label: 'Currency' },
    { key: 'store.country', value: 'IN', type: 'STRING', group: 'general', label: 'Country' },
    { key: 'tax.default_percent', value: '0', type: 'NUMBER', group: 'checkout', label: 'Default tax %' },
    { key: 'shipping.default_fee', value: '0', type: 'NUMBER', group: 'checkout', label: 'Default shipping fee (paise)' },
    { key: 'shipping.free_threshold', value: '0', type: 'NUMBER', group: 'checkout', label: 'Free shipping above (paise)' },
    {
      key: 'nav.main',
      type: 'JSON',
      group: 'navigation',
      label: 'Main navigation',
      // Seeded now; an admin-managed menu can replace this without touching the
      // header component (spec §17).
      value: JSON.stringify([
        { label: 'New In', href: '/products?sort=newest' },
        {
          label: "Women's",
          href: '/categories/womens',
          children: CATEGORY_DEFS.map((c) => ({ label: c.name, href: `/categories/${c.slug}` })),
        },
        { label: 'Dresses', href: '/categories/dresses' },
        { label: 'Sarees', href: '/categories/sarees' },
        { label: 'Accessories', href: '/categories/accessories' },
      ]),
    },
    {
      key: 'home.sections',
      type: 'JSON',
      group: 'homepage',
      label: 'Homepage sections',
      value: JSON.stringify([
        {
          type: 'hero',
          image: '/home/hero.jpg',
          eyebrow: 'Autumn Collection',
          heading: 'Gather',
          body: 'Hand-worked linens and softened silks, cut for ease.',
          ctaLabel: 'Explore the collection',
          ctaHref: '/products',
        },
        {
          type: 'services',
          items: [
            { title: 'Made to order', body: 'Cut and finished for you, in 15-20 days.' },
            { title: 'Studio fittings', body: 'By appointment, six days a week.' },
            { title: 'Free shipping', body: 'Complimentary across India.' },
            { title: 'Hand-finished', body: 'Every seam closed by hand.' },
          ],
        },
        { type: 'featured-products', heading: 'Featured', limit: 4 },
        {
          type: 'banner',
          image: '/home/gather.jpg',
          eyebrow: 'The Collection',
          heading: 'Gather',
          body: 'A collection for the long table, the late evening, the people you keep close.',
          ctaLabel: 'Shop the collection',
          ctaHref: '/categories/dresses',
        },
        { type: 'new-arrivals', heading: 'New Arrivals', limit: 8 },
        {
          type: 'category-banner',
          heading: 'Shop by category',
          slugs: CATEGORY_DEFS.map((c) => c.slug),
        },
        // No newsletter block here — the footer carries one on every page, and
        // two on the homepage reads as a mistake.
      ]),
    },
  ]

  await prisma.setting.createMany({ data: settings })
}

/**
 * Copies the committed demo imagery into the storage directory.
 *
 * `uploads/` is a runtime directory (gitignored, a volume in production), so the
 * seed's product images ship in `seed-assets/` and are copied across on run.
 * Without this the catalogue would reference images that do not exist.
 *
 * Only runs for the local storage provider — with S3/R2 the media must be
 * uploaded to the bucket separately.
 */
function installSeedMedia() {
  if (env.STORAGE_PROVIDER !== 'local') {
    console.log('  storage provider is not local — skipping demo media')
    return
  }

  const source = path.join(REPO_ROOT, 'seed-assets', 'products')
  if (!existsSync(source)) {
    console.log('  no seed-assets/products — product images will be missing')
    return
  }

  const target = path.join(REPO_ROOT, env.STORAGE_LOCAL_DIR, 'products')
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
  console.log(`  demo media copied into ${env.STORAGE_LOCAL_DIR}/products`)
}

async function main() {
  console.log('Seeding...')
  installSeedMedia()
  await wipe()

  await seedRbac()
  console.log(`  ${PERMISSIONS.length} permissions across ${ROLES.length} roles`)

  const { admin } = await seedUsers()
  console.log('  2 users (1 admin, 1 customer)')

  const categoryIds = await seedCategories()
  console.log(`  ${categoryIds.size + 1} categories`)

  const products = await seedProducts(categoryIds, admin.id)
  await seedSettings()

  const [variants, stock] = await Promise.all([
    prisma.productVariant.count(),
    prisma.inventory.aggregate({ _sum: { availableStock: true } }),
  ])

  console.log(`  ${products} products, ${variants} variants, ${stock._sum.availableStock} units in stock`)
  console.log('\nSign in (development only — from your environment):')
  console.log(`  admin     ${env.ADMIN_EMAIL} / ${env.ADMIN_PASSWORD}`)
  console.log(`  customer  ${env.CUSTOMER_EMAIL} / ${env.CUSTOMER_PASSWORD}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
