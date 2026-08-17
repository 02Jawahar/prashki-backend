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
import { ALL, MESSAGE_TEMPLATES, PERMISSIONS, ROLES } from './seed-data.js'

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })

const here = path.dirname(fileURLToPath(import.meta.url))
// prisma/ -> repository root
const REPO_ROOT = path.resolve(here, '..')

// ---------------------------------------------------------------------------
// Permissions and roles
// ---------------------------------------------------------------------------







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

/**
 * Refuses to wipe a production database.
 *
 * DEPLOYMENT.md asks the operator to run this once on a fresh deploy to create
 * the first admin, and warns that it deletes orders. A warning in a document
 * is not a control — the person reading it on day one is not the person who
 * runs it from memory on day thirty.
 *
 * `npm run db:bootstrap` is the safe path for production: it creates roles,
 * permissions, settings and one admin, and refuses to touch a database that
 * already has users.
 *
 * If a wipe is genuinely wanted in production, it has to be asked for in a
 * sentence nobody types by accident.
 */
const DESTRUCTIVE_OVERRIDE = 'yes-delete-everything'

function assertSafeToWipe() {
  if (env.NODE_ENV !== 'production') return
  if (process.env.ALLOW_DESTRUCTIVE_SEED === DESTRUCTIVE_OVERRIDE) {
    console.warn('\n  ⚠  Wiping a PRODUCTION database because ALLOW_DESTRUCTIVE_SEED is set.\n')
    return
  }

  console.error(
    [
      '',
      '  Refusing to seed: NODE_ENV is production and this script deletes every',
      '  order, customer and product before rebuilding the demo catalogue.',
      '',
      '  To create the first admin on a fresh deploy, use:',
      '',
      '      npm run db:bootstrap',
      '',
      '  It is idempotent, adds no demo data, and refuses to run if the database',
      '  already has users.',
      '',
      `  If you really do mean to wipe production, set ALLOW_DESTRUCTIVE_SEED=${DESTRUCTIVE_OVERRIDE}.`,
      '',
    ].join('\n'),
  )
  process.exit(1)
}

async function wipe() {
  // Children before parents where cascades don't cover it.
  await prisma.auditLog.deleteMany()
  await prisma.analyticsEvent.deleteMany()
  await prisma.messageLog.deleteMany()
  await prisma.messageTemplate.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.notificationPreference.deleteMany()
  await prisma.webhookEvent.deleteMany()
  await prisma.paymentTransaction.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.refund.deleteMany()
  await prisma.returnStatusHistory.deleteMany()
  await prisma.returnItem.deleteMany()
  await prisma.returnRequest.deleteMany()
  await prisma.shipmentEvent.deleteMany()
  await prisma.shipmentItem.deleteMany()
  await prisma.shipment.deleteMany()
  await prisma.review.deleteMany()
  await prisma.wishlistItem.deleteMany()
  await prisma.couponRedemption.deleteMany()
  await prisma.couponProduct.deleteMany()
  await prisma.couponCategory.deleteMany()
  await prisma.coupon.deleteMany()
  await prisma.checkoutSession.deleteMany()
  await prisma.orderStatusHistory.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.shippingRate.deleteMany()
  await prisma.shippingMethod.deleteMany()
  await prisma.shippingZone.deleteMany()
  await prisma.showcaseProduct.deleteMany()
  await prisma.showcaseItem.deleteMany()
  await prisma.pageRevision.deleteMany()
  await prisma.page.deleteMany()
  await prisma.redirect.deleteMany()
  await prisma.consent.deleteMany()
  await prisma.customerNote.deleteMany()
  await prisma.passwordResetToken.deleteMany()
  await prisma.variantAttributeValue.deleteMany()
  await prisma.attributeValue.deleteMany()
  await prisma.attribute.deleteMany()
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

/**
 * One staff account per seeded role.
 *
 * Not decoration: without a user who holds *only* Support, there is no way to
 * prove that Support is denied a refund. The RBAC suite signs in as each of
 * these and checks both halves — what the role may do, and what it may not.
 */
const STAFF = [
  { key: 'ADMIN', name: 'Priya Menon', email: 'admin.general@example.com' },
  { key: 'CATALOG_MANAGER', name: 'Rohan Iyer', email: 'catalog@example.com' },
  { key: 'CONTENT_MARKETING', name: 'Sana Qureshi', email: 'content@example.com' },
  { key: 'OPERATIONS', name: 'Vikram Shah', email: 'operations@example.com' },
  { key: 'SUPPORT', name: 'Neha Kulkarni', email: 'support@example.com' },
] as const

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

  // One shared password across the demo staff, from the environment — never
  // hard-coded, same rule as the admin and customer accounts.
  const staffHash = await hash(env.STAFF_PASSWORD)

  for (const member of STAFF) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: member.key } })
    await prisma.user.create({
      data: {
        name: member.name,
        email: member.email,
        passwordHash: staffHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerified: true,
        roles: { create: { roleId: role.id } },
      },
    })
  }

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
          /**
           * Shipping weight, so the rate bands have something real to work
           * with. A saree is heavier than a scarf, and the deterministic
           * seed keeps the numbers stable across re-runs.
           */
          weightGrams:
            p.optionSet === 'onesize'
              ? seededInt(`${sku}-w`, 120, 400)
              : seededInt(`${sku}-w`, 450, 1_400),
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
          type: 'showcase',
          heading: 'As worn by you',
          body: 'Our pieces, out in the world. Shared with permission.',
          limit: 8,
        },
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

// ---------------------------------------------------------------------------
// Attributes, shipping, content and messaging
// ---------------------------------------------------------------------------

/**
 * The faceting vocabulary. Values are attached to the seeded variants so the
 * storefront's size filter has something to filter on from the first run.
 */
async function seedAttributes() {
  const size = await prisma.attribute.create({
    data: {
      name: 'Size',
      slug: 'size',
      isSwatch: false,
      isFilterable: true,
      position: 0,
      values: {
        create: [...SIZES, 'One size'].map((value, position) => ({
          value,
          slug: value.toLowerCase().replace(/\s+/g, '-'),
          position,
        })),
      },
    },
    include: { values: true },
  })

  await prisma.attribute.create({
    data: {
      name: 'Colour',
      slug: 'colour',
      isSwatch: true,
      isFilterable: true,
      position: 1,
      values: {
        create: [
          { value: 'Sage', slug: 'sage', colorHex: '#838E5E', position: 0 },
          { value: 'Ivory', slug: 'ivory', colorHex: '#F3EFE6', position: 1 },
          { value: 'Clay', slug: 'clay', colorHex: '#B08968', position: 2 },
          { value: 'Ink', slug: 'ink', colorHex: '#2B2B2B', position: 3 },
        ],
      },
    },
  })

  // Link each variant to the size value whose name it already carries.
  const bySlug = new Map(size.values.map((v) => [v.value, v.id]))
  const variants = await prisma.productVariant.findMany({ select: { id: true, name: true } })

  const links = variants
    .map((variant) => {
      const valueId = bySlug.get(variant.name === 'Default' ? 'One size' : variant.name)
      return valueId ? { variantId: variant.id, attributeValueId: valueId } : null
    })
    .filter((row): row is { variantId: string; attributeValueId: string } => row !== null)

  if (links.length > 0) await prisma.variantAttributeValue.createMany({ data: links })

  return links.length
}

/**
 * Shipping configuration (M21).
 *
 * Three zones, matched in `position` order:
 *
 *   0  Not serviceable — a PIN blocklist that refuses before anything else
 *      gets a chance to offer delivery
 *   1  Metro cities   — cheaper and faster, matched by state or PIN prefix
 *   2  India          — the default, which is what keeps an unusual address
 *                       deliverable rather than stranded
 *
 * Standard delivery carries weight bands, so a heavy parcel costs more than a
 * scarf. Express is a flat rate with a carrier weight ceiling.
 */
async function seedShipping() {
  // Andaman & Nicobar and Lakshadweep — genuinely hard to reach by surface
  // courier, and a working example of how a refusal is expressed.
  await prisma.shippingZone.create({
    data: {
      name: 'Not currently serviced',
      countries: ['IN'],
      regions: ['744', '682555', 'Andaman and Nicobar Islands', 'Lakshadweep'],
      isServiceable: false,
      unserviceableMessage:
        'We are not able to deliver to that PIN code yet. Write to us and we will try to arrange something.',
      isActive: true,
      position: 0,
    },
  })

  const metro = await prisma.shippingZone.create({
    data: {
      name: 'Metro cities',
      countries: ['IN'],
      // Matched by state name or PIN prefix — see resolveZone.
      regions: ['Delhi', 'Maharashtra', 'Karnataka', 'Telangana', 'Tamil Nadu'],
      isActive: true,
      position: 1,
      methods: {
        create: [
          {
            name: 'Standard delivery',
            description: 'Delivered by our courier partners.',
            rate: 9_000,
            freeAbove: 300_000,
            minDays: 2,
            maxDays: 4,
            position: 0,
          },
          {
            name: 'Next-day delivery',
            description: 'Order before 2pm for delivery tomorrow.',
            rate: 29_000,
            maxWeightGrams: 5_000,
            minDays: 1,
            maxDays: 1,
            position: 1,
          },
        ],
      },
    },
    include: { methods: true },
  })

  const india = await prisma.shippingZone.create({
    data: {
      name: 'India',
      countries: ['IN'],
      regions: [],
      isDefault: true,
      isActive: true,
      position: 2,
      methods: {
        create: [
          {
            name: 'Standard delivery',
            description: 'Delivered by our courier partners.',
            rate: 15_000,
            freeAbove: 500_000,
            minDays: 4,
            maxDays: 7,
            position: 0,
          },
          {
            name: 'Express delivery',
            description: 'Priority despatch, tracked end to end.',
            rate: 35_000,
            maxWeightGrams: 10_000,
            minDays: 2,
            maxDays: 3,
            position: 1,
          },
          {
            name: 'Cash on delivery',
            description: 'Pay the courier when your order arrives.',
            rate: 15_000,
            isCod: true,
            codFee: 5_000,
            maxSubtotal: 1_500_000,
            minDays: 4,
            maxDays: 7,
            position: 2,
          },
        ],
      },
    },
    include: { methods: true },
  })

  /**
   * Weight bands on standard delivery in both zones. Bounds are
   * inclusive-lower, exclusive-upper, so 500 g falls in the second band.
   */
  const bands = (methodId: string, base: number) => [
    { methodId, label: 'Up to 500 g', maxWeightGrams: 500, amount: base, position: 0 },
    {
      methodId,
      label: '500 g – 2 kg',
      minWeightGrams: 500,
      maxWeightGrams: 2_000,
      amount: base + 4_000,
      position: 1,
    },
    {
      methodId,
      label: '2 kg – 5 kg',
      minWeightGrams: 2_000,
      maxWeightGrams: 5_000,
      amount: base + 10_000,
      position: 2,
    },
    { methodId, label: 'Over 5 kg', minWeightGrams: 5_000, amount: base + 20_000, position: 3 },
  ]

  const metroStandard = metro.methods.find((m) => m.name === 'Standard delivery')!
  const indiaStandard = india.methods.find((m) => m.name === 'Standard delivery')!

  await prisma.shippingRate.createMany({
    data: [...bands(metroStandard.id, 9_000), ...bands(indiaStandard.id, 15_000)],
  })

  return { zones: 3, methods: metro.methods.length + india.methods.length, bands: 8 }
}

/** Policy pages the footer and checkout link to. Marked system so they stay. */
async function seedPages() {
  const pages = [
    {
      slug: 'about',
      title: 'About Prash & Ki',
      blocks: [
        {
          type: 'richText',
          data: {
            html: '<p>Prash &amp; Ki is a small studio making crafted couture in limited runs. Every piece is cut, sewn and finished by hand.</p>',
          },
        },
      ],
      seoDescription: 'A small studio making crafted couture in limited runs.',
    },
    {
      slug: 'contact',
      title: 'Contact',
      blocks: [
        {
          type: 'richText',
          data: {
            html: '<p>Write to us and we will reply within one working day.</p>',
          },
        },
      ],
      seoDescription: 'Get in touch with the Prash & Ki studio.',
    },
    {
      slug: 'shipping-policy',
      title: 'Shipping',
      blocks: [
        {
          type: 'richText',
          data: {
            html: '<p>Orders are despatched within two working days. Delivery estimates are shown at checkout for your address.</p>',
          },
        },
      ],
      seoDescription: 'How and when we deliver.',
    },
    {
      slug: 'returns-policy',
      title: 'Returns',
      blocks: [
        {
          type: 'richText',
          data: {
            html: '<p>Unworn pieces may be returned within seven days of delivery. Start a return from your account.</p>',
          },
        },
      ],
      seoDescription: 'Our seven-day return policy.',
    },
    {
      slug: 'privacy-policy',
      title: 'Privacy',
      blocks: [
        {
          type: 'richText',
          data: {
            html: '<p>We collect only what an order needs, and never sell your details.</p>',
          },
        },
      ],
      seoDescription: 'What we collect, and why.',
    },
    {
      slug: 'terms',
      title: 'Terms of Service',
      blocks: [
        { type: 'richText', data: { html: '<p>The terms that apply when you buy from us.</p>' } },
      ],
      seoDescription: 'The terms that apply when you buy from us.',
    },
  ]

  for (const page of pages) {
    await prisma.page.create({
      data: {
        slug: page.slug,
        title: page.title,
        status: 'PUBLISHED',
        isSystem: true,
        publishedAt: new Date(),
        blocks: page.blocks as unknown as Prisma.InputJsonValue,
        seoDescription: page.seoDescription,
        revisions: {
          create: {
            version: 1,
            title: page.title,
            blocks: page.blocks as unknown as Prisma.InputJsonValue,
            note: 'Seeded',
          },
        },
      },
    })
  }

  return pages.length
}

/**
 * Default copy for every message the store sends. Editable from admin, so this
 * is a starting point rather than the final wording.
 */
async function seedMessageTemplates() {
  await prisma.messageTemplate.createMany({
    data: MESSAGE_TEMPLATES.map((t) => ({
      key: t.key,
      channel: t.channel,
      name: t.name,
      subject: t.subject ?? null,
      body: t.body,
      variables: t.variables,
      isActive: true,
    })),
  })

  return MESSAGE_TEMPLATES.length
}

/** Two live coupons so the cart's discount path is exercised from day one. */
async function seedCoupons() {
  await prisma.coupon.createMany({
    data: [
      {
        code: 'WELCOME10',
        description: '10% off your first order',
        type: 'PERCENTAGE',
        status: 'ACTIVE',
        // basis points: 1000 = 10%
        value: 1000,
        maxDiscount: 200_000,
        minSubtotal: 500_000,
        perUserLimit: 1,
        firstOrderOnly: true,
        excludeDiscounted: true,
      },
      {
        code: 'FREESHIP',
        description: 'Free delivery, no minimum',
        type: 'FREE_SHIPPING',
        status: 'ACTIVE',
        value: 0,
      },
    ],
  })
  return 2
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

/**
 * Demo customer showcase.
 *
 * Seeded as IMAGE items using the demo photography already in `seed-assets/`,
 * not video: shipping a 40 MB clip in the repository to demonstrate a homepage
 * section would be a poor trade, and the video path is covered by the tests
 * instead. A real store replaces these with customer clips from admin.
 *
 * Consent is stamped on every seeded row so the wall renders — the guard that
 * blocks publishing without it is exercised in `smoke-showcase.mjs`, where a
 * missing consent date is supposed to fail.
 */
async function seedShowcase() {

  const ITEMS: Array<{
    handle: string
    altText: string
    caption: string
    creditName: string
    creditHandle: string
  }> = [
    {
      handle: 'amaira-halterneck-column-dress',
      altText: 'A customer in the Amaira halterneck column dress on a hotel terrace at golden hour',
      caption: 'Wore this to a rooftop dinner and did not want to take it off.',
      creditName: 'Ananya R.',
      creditHandle: 'ananya.wears',
    },
    {
      handle: 'anjum-block-print-kurta-set',
      altText: 'A customer in the Anjum block-print kurta set standing in a garden',
      caption: 'The block print is even better in daylight.',
      creditName: 'Meera S.',
      creditHandle: 'meera.and.co',
    },
    {
      handle: 'bela-pintuck-kurta-set',
      altText: 'A customer in the Bela pintuck kurta set at a family lunch',
      caption: 'Third wedding in this. Nobody has noticed.',
      creditName: 'Divya K.',
      creditHandle: 'divyakrishnan',
    },
    {
      handle: 'kiran-silk-scarf',
      altText: 'A customer wearing the Kiran silk scarf knotted at the neck',
      caption: 'Bought it for one trip, have not taken it off since.',
      creditName: 'Riya P.',
      creditHandle: 'riya.p',
    },
  ]

  const slugs = ITEMS.map((item) => item.handle)
  const products = await prisma.product.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  })
  const bySlug = new Map(products.map((p) => [p.slug, p]))

  const consentGrantedAt = new Date()
  let created = 0

  for (const [index, item] of ITEMS.entries()) {
    const product = bySlug.get(item.handle)
    if (!product) continue

    await prisma.showcaseItem.create({
      data: {
        mediaType: 'IMAGE',
        mediaUrl: `${env.STORAGE_PUBLIC_URL}/products/${item.handle}-1.jpg`,
        posterUrl: `${env.STORAGE_PUBLIC_URL}/products/${item.handle}-1.jpg`,
        altText: item.altText,
        caption: item.caption,
        creditName: item.creditName,
        creditHandle: item.creditHandle,
        consentGrantedAt,
        consentNote: 'Demo content — permission recorded at seed time',
        status: 'ACTIVE',
        publishedAt: consentGrantedAt,
        position: index,
        products: { create: [{ productId: product.id, position: 0 }] },
      },
    })
    created++
  }

  return created
}

async function main() {
  assertSafeToWipe()

  console.log('Seeding...')
  installSeedMedia()
  await wipe()

  await seedRbac()
  console.log(`  ${PERMISSIONS.length} permissions across ${ROLES.length} roles`)

  const { admin } = await seedUsers()
  console.log(`  ${STAFF.length + 2} users (1 super admin, ${STAFF.length} staff, 1 customer)`)

  const categoryIds = await seedCategories()
  console.log(`  ${categoryIds.size + 1} categories`)

  const products = await seedProducts(categoryIds, admin.id)
  await seedSettings()

  const [variants, stock] = await Promise.all([
    prisma.productVariant.count(),
    prisma.inventory.aggregate({ _sum: { availableStock: true } }),
  ])

  console.log(`  ${products} products, ${variants} variants, ${stock._sum.availableStock} units in stock`)

  // Attributes come after products so the size values can be linked to the
  // variants that already exist.
  const attributeLinks = await seedAttributes()
  console.log(`  2 attributes, ${attributeLinks} variant options`)

  const shipping = await seedShipping()
  console.log(
    `  ${shipping.zones} shipping zones (1 non-serviceable), ${shipping.methods} methods, ${shipping.bands} rate bands`,
  )

  const pages = await seedPages()
  console.log(`  ${pages} content pages`)

  const templates = await seedMessageTemplates()
  console.log(`  ${templates} message templates`)

  const coupons = await seedCoupons()
  console.log(`  ${coupons} coupons`)

  const showcase = await seedShowcase()
  console.log(`  ${showcase} customer showcase items`)
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
