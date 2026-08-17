/**
 * The definitions the seed and the production bootstrap both need.
 *
 * Kept in one file on purpose: two copies of the permission catalogue is two
 * places for a new capability to be forgotten, and the one that gets forgotten
 * is always the production path.
 */

export const PERMISSIONS = [
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

export const ALL = PERMISSIONS.map((p) => p.key)

export /**
 * Seeded roles, mapped to the separation of duties in PRD §02.
 *
 *   Content / Marketing   CMS, promotions, SEO, campaigns
 *   Operations            orders, fulfilment, shipping, returns
 *   Support               view context, plus explicitly permitted actions
 *   Admin / Super Admin   configuration, users, permissions
 *
 * Catalogue is separated out as its own role because M02 and M11 name a
 * merchandiser as a distinct actor from a content manager — a copywriter
 * scheduling a banner has no business deleting a product or adjusting stock.
 *
 * These are defaults, not a fixed set. An admin holding `role.manage` can
 * create further roles and re-grant any of them at runtime; `isSystem` only
 * stops them being deleted.
 */
const ROLES = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Unrestricted access, including staff and role management.',
    permissions: ALL,
  },
  {
    /**
     * Runs the whole store but cannot grant privileges. That is the single
     * most valuable separation here: someone who can configure everything
     * still cannot quietly promote themselves or anyone else.
     */
    key: 'ADMIN',
    name: 'Administrator',
    description: 'Full store configuration. Cannot manage staff, roles or permissions.',
    permissions: ALL.filter((key) => !['user.manage', 'role.manage'].includes(key)),
  },
  {
    key: 'CATALOG_MANAGER',
    name: 'Catalog Manager',
    description: 'Products, categories, options, media and stock.',
    permissions: [
      'dashboard.read', 'product.read', 'product.create', 'product.update',
      'product.delete', 'product.publish', 'category.manage', 'media.upload',
      'attribute.manage', 'inventory.read', 'inventory.adjust',
      // Sees orders to know what is selling, but cannot act on them.
      'order.read', 'report.read',
    ],
  },
  {
    key: 'CONTENT_MARKETING',
    name: 'Content & Marketing',
    description: 'Pages, banners, SEO, promotions, reviews and customer messaging.',
    permissions: [
      'dashboard.read',
      // Read-only on the catalogue: needed to target a coupon or a banner at a
      // product, but not to change or publish one.
      'product.read', 'media.upload',
      'content.read', 'content.manage',
      'coupon.read', 'coupon.manage',
      'review.moderate', 'message.manage',
      'report.read',
    ],
  },
  {
    key: 'OPERATIONS',
    name: 'Operations',
    description: 'Orders, fulfilment, shipping, returns and refunds.',
    permissions: [
      'dashboard.read', 'product.read', 'inventory.read', 'inventory.adjust',
      'order.read', 'order.update', 'order.update_status', 'order.cancel',
      'shipment.manage', 'shipping.manage',
      'return.read', 'return.manage', 'refund.create',
      // Packing slips and courier handovers need the real address and phone.
      'customer.read', 'customer.read_pii',
      'report.read',
    ],
  },
  {
    key: 'SUPPORT',
    name: 'Support',
    description: 'Answering customer questions. Reads widely, changes little.',
    permissions: [
      'dashboard.read', 'product.read',
      // "Explicitly permitted support actions": internal notes on an order and
      // on a customer. Not status changes, not refunds.
      'order.read', 'order.update',
      'customer.read', 'customer.update',
      'return.read', 'coupon.read', 'content.read',
    ],
  },
] as const

/**
 * Store configuration a real shop cannot run without.
 *
 * Deliberately excludes `nav.main` and `home.sections` — those reference the
 * demo categories and belong to the seed. A production store builds its own
 * navigation and homepage from its own catalogue, and pointing the header at
 * categories that do not exist is worse than an empty header.
 */
export const DEFAULT_SETTINGS: Array<{
  key: string
  value: string
  type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON'
  group: string
  label: string
}> = [
  { key: 'store.name', value: 'Prash & Ki', type: 'STRING', group: 'general', label: 'Store name' },
  { key: 'store.email', value: 'care@example.com', type: 'STRING', group: 'general', label: 'Store email' },
  { key: 'store.phone', value: '', type: 'STRING', group: 'general', label: 'Store phone' },
  { key: 'store.currency', value: 'INR', type: 'STRING', group: 'general', label: 'Currency' },
  { key: 'store.country', value: 'IN', type: 'STRING', group: 'general', label: 'Country' },
  { key: 'tax.default_percent', value: '0', type: 'NUMBER', group: 'checkout', label: 'Default tax %' },
  { key: 'shipping.default_fee', value: '0', type: 'NUMBER', group: 'checkout', label: 'Default shipping fee (paise)' },
  { key: 'shipping.free_threshold', value: '0', type: 'NUMBER', group: 'checkout', label: 'Free shipping above (paise)' },
  { key: 'nav.main', value: '[]', type: 'JSON', group: 'navigation', label: 'Main navigation' },
  { key: 'home.sections', value: '[]', type: 'JSON', group: 'homepage', label: 'Homepage sections' },
]

/**
 * The messages the store sends.
 *
 * Shared with the production bootstrap, not seed-only: without these rows
 * `sendMessage` finds no template and returns before sending anything, so a
 * correctly configured mail provider still delivers nothing — and the delivery
 * log stays empty, because a message that was never attempted has nothing to
 * log. A store cannot send a receipt or an invitation without them, so they
 * are part of a working install rather than demo data.
 */
export interface SeedTemplate {
  key: string
  channel: 'EMAIL' | 'WHATSAPP' | 'SMS'
  name: string
  subject?: string
  body: string
  variables: string[]
}

export const MESSAGE_TEMPLATES: SeedTemplate[] = [
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
      key: 'account.staff_invite',
      channel: 'EMAIL',
      name: 'Staff invitation',
      subject: 'You have been invited to the Prash & Ki admin',
      body: 'Hello {{name}},\n\n{{invitedBy}} has invited you to the Prash & Ki admin panel.\n\nSet your password using this link, which expires in {{expiresInDays}} days:\n\n{{url}}\n\nIf you were not expecting this, ignore this email — the account cannot be used until the link is opened.',
      variables: ['name', 'url', 'invitedBy', 'expiresInDays'],
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
