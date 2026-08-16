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

  { key: 'attribute.manage', group: 'Catalog', label: 'Manage sizes, colours and other options' },

  { key: 'inventory.read', group: 'Inventory', label: 'View stock' },
  { key: 'inventory.adjust', group: 'Inventory', label: 'Adjust stock' },

  { key: 'order.read', group: 'Orders', label: 'View orders' },
  { key: 'order.update', group: 'Orders', label: 'Edit order details and internal notes' },
  { key: 'order.update_status', group: 'Orders', label: 'Change order status' },
  { key: 'order.cancel', group: 'Orders', label: 'Cancel orders' },
  { key: 'shipment.manage', group: 'Orders', label: 'Create shipments and add tracking' },

  { key: 'return.read', group: 'Returns', label: 'View return requests' },
  { key: 'return.manage', group: 'Returns', label: 'Approve, reject and process returns' },
  { key: 'refund.create', group: 'Returns', label: 'Issue refunds' },

  { key: 'coupon.read', group: 'Marketing', label: 'View coupons' },
  { key: 'coupon.manage', group: 'Marketing', label: 'Create and edit coupons' },
  { key: 'review.moderate', group: 'Marketing', label: 'Moderate product reviews' },
  { key: 'message.manage', group: 'Marketing', label: 'Edit email and WhatsApp templates' },

  { key: 'content.read', group: 'Content', label: 'View pages and redirects' },
  { key: 'content.manage', group: 'Content', label: 'Edit pages, blocks and redirects' },

  { key: 'customer.read', group: 'Customers', label: 'View customers' },
  { key: 'customer.update', group: 'Customers', label: 'Edit customers' },
  /**
   * Contact details are masked for everyone without this. It is a separate
   * capability from customer.read so support staff can do their job without
   * every phone number in the database passing through their screen.
   */
  { key: 'customer.read_pii', group: 'Customers', label: 'See unmasked contact details' },

  { key: 'report.read', group: 'Reports', label: 'View sales and inventory reports' },

  { key: 'settings.read', group: 'Settings', label: 'View settings' },
  { key: 'settings.update', group: 'Settings', label: 'Change settings' },
  { key: 'shipping.manage', group: 'Settings', label: 'Manage shipping zones and rates' },

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
    description: 'Products, categories, media, stock and merchandising content.',
    permissions: [
      'dashboard.read', 'product.read', 'product.create', 'product.update',
      'product.delete', 'product.publish', 'category.manage', 'media.upload',
      'attribute.manage', 'inventory.read', 'inventory.adjust', 'order.read',
      'coupon.read', 'coupon.manage', 'review.moderate',
      'content.read', 'content.manage', 'report.read',
    ],
  },
  {
    key: 'ORDER_MANAGER',
    name: 'Order Manager',
    description: 'Order fulfilment, shipping, returns and customer lookup.',
    permissions: [
      'dashboard.read', 'product.read', 'inventory.read', 'order.read',
      'order.update', 'order.update_status', 'order.cancel', 'shipment.manage',
      'return.read', 'return.manage', 'refund.create',
      // Packing slips and courier handovers need the real address and phone.
      'customer.read', 'customer.read_pii', 'report.read',
    ],
  },
  {
    key: 'SUPPORT',
    name: 'Support',
    description: 'Answering customer questions. Reads widely, changes little.',
    permissions: [
      'dashboard.read', 'product.read', 'order.read', 'order.update',
      'customer.read', 'return.read', 'coupon.read', 'content.read',
    ],
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
  await prisma.shippingMethod.deleteMany()
  await prisma.shippingZone.deleteMany()
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
 * One India-wide zone plus a metro zone that ships faster. The default flag on
 * the national zone is what keeps an unusual address deliverable.
 */
async function seedShipping() {
  await prisma.shippingZone.create({
    data: {
      name: 'India',
      countries: ['IN'],
      regions: [],
      isDefault: true,
      isActive: true,
      position: 1,
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
  })

  await prisma.shippingZone.create({
    data: {
      name: 'Metro cities',
      countries: ['IN'],
      // Matched by state name or PIN prefix — see resolveZone.
      regions: ['Delhi', 'Maharashtra', 'Karnataka', 'Telangana', 'Tamil Nadu'],
      isActive: true,
      position: 0,
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
            minDays: 1,
            maxDays: 1,
            position: 1,
          },
        ],
      },
    },
  })
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
  const templates: Array<{
    key: string
    channel: 'EMAIL' | 'WHATSAPP' | 'SMS'
    name: string
    subject?: string
    body: string
    variables: string[]
  }> = [
    {
      key: 'account.welcome',
      channel: 'EMAIL',
      name: 'Welcome',
      subject: 'Welcome to Prash & Ki',
      body: 'Hello {{name}},\n\nThank you for joining us. Your account is ready.\n\nPrash & Ki',
      variables: ['name'],
    },
    {
      key: 'account.password_reset',
      channel: 'EMAIL',
      name: 'Password reset',
      subject: 'Reset your password',
      body: 'Hello {{name}},\n\nUse this link to set a new password. It expires in {{expiresInMinutes}} minutes:\n\n{{url}}\n\nIf you did not ask for this, you can ignore this email.',
      variables: ['name', 'url', 'expiresInMinutes'],
    },
    {
      key: 'order.placed',
      channel: 'EMAIL',
      name: 'Order confirmation',
      subject: 'Order {{orderNumber}} received',
      body: 'Hello {{name}},\n\nWe have your order {{orderNumber}} for {{total}}.\n\n{{items}}\n\nWe will email again when it ships.',
      variables: ['name', 'orderNumber', 'total', 'items', 'itemCount'],
    },
    {
      key: 'order.placed',
      channel: 'WHATSAPP',
      name: 'Order confirmation (WhatsApp)',
      body: 'Hi {{name}} — we have your Prash & Ki order {{orderNumber}} for {{total}}.',
      variables: ['name', 'orderNumber', 'total'],
    },
    {
      key: 'order.paid',
      channel: 'EMAIL',
      name: 'Payment received',
      subject: 'Payment received for {{orderNumber}}',
      body: 'Hello {{name}},\n\nWe have received {{total}} for order {{orderNumber}}. Thank you.',
      variables: ['name', 'orderNumber', 'total'],
    },
    {
      key: 'order.paid',
      channel: 'SMS',
      name: 'Payment received (SMS)',
      body: 'Prash & Ki: payment of {{total}} received for order {{orderNumber}}.',
      variables: ['orderNumber', 'total'],
    },
    {
      key: 'order.shipped',
      channel: 'EMAIL',
      name: 'Order shipped',
      subject: 'Order {{orderNumber}} is on its way',
      body: 'Hello {{name}},\n\nYour order {{orderNumber}} has left the studio.\n\nCarrier: {{carrier}}\nTracking: {{trackingNumber}}\n{{trackingUrl}}',
      variables: ['name', 'orderNumber', 'carrier', 'trackingNumber', 'trackingUrl'],
    },
    {
      key: 'order.shipped',
      channel: 'WHATSAPP',
      name: 'Order shipped (WhatsApp)',
      body: 'Hi {{name}} — order {{orderNumber}} has shipped. Track it here: {{trackingUrl}}',
      variables: ['name', 'orderNumber', 'trackingUrl'],
    },
    {
      key: 'order.delivered',
      channel: 'EMAIL',
      name: 'Order delivered',
      subject: 'Order {{orderNumber}} delivered',
      body: 'Hello {{name}},\n\nOrder {{orderNumber}} has been delivered. We would love to know what you think.',
      variables: ['name', 'orderNumber'],
    },
    {
      key: 'order.cancelled',
      channel: 'EMAIL',
      name: 'Order cancelled',
      subject: 'Order {{orderNumber}} cancelled',
      body: 'Hello {{name}},\n\nOrder {{orderNumber}} has been cancelled. Any payment taken will be returned to your original method.',
      variables: ['name', 'orderNumber'],
    },
    {
      key: 'return.updated',
      channel: 'EMAIL',
      name: 'Return update',
      subject: 'Update on return {{returnNumber}}',
      body: 'Hello {{name}},\n\nYour return {{returnNumber}} is now {{status}}.\n\n{{note}}',
      variables: ['name', 'returnNumber', 'status', 'note'],
    },
    {
      key: 'refund.issued',
      channel: 'EMAIL',
      name: 'Refund issued',
      subject: 'Refund for order {{orderNumber}}',
      body: 'Hello {{name}},\n\nWe have sent {{amount}} back to your original payment method for order {{orderNumber}}. It usually arrives within 5-7 working days.',
      variables: ['name', 'orderNumber', 'amount'],
    },
  ]

  await prisma.messageTemplate.createMany({
    data: templates.map((t) => ({
      key: t.key,
      channel: t.channel,
      name: t.name,
      subject: t.subject ?? null,
      body: t.body,
      variables: t.variables,
      isActive: true,
    })),
  })

  return templates.length
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

  // Attributes come after products so the size values can be linked to the
  // variants that already exist.
  const attributeLinks = await seedAttributes()
  console.log(`  2 attributes, ${attributeLinks} variant options`)

  await seedShipping()
  console.log('  2 shipping zones, 5 delivery methods')

  const pages = await seedPages()
  console.log(`  ${pages} content pages`)

  const templates = await seedMessageTemplates()
  console.log(`  ${templates} message templates`)

  const coupons = await seedCoupons()
  console.log(`  ${coupons} coupons`)
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
