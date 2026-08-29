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
  { key: 'store.email', value: 'care@prashandki.in', type: 'STRING', group: 'general', label: 'Store email' },
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
 * The policy pages the storefront links to.
 *
 * Shared with the production bootstrap, not seed-only: the footer links
 * /about, /contact, /shipping-policy and /returns-policy unconditionally, and
 * the CMS catch-all 404s on a slug with no published page — so without these
 * rows a fresh install ships four dead links in the footer of every page.
 *
 * Marked `isSystem`, so admin cannot delete them. The wording is editable, and
 * bootstrap never overwrites a page that already exists.
 *
 * The returns copy states a 7-day window because that is what the software
 * enforces — `RETURN_WINDOW_DAYS` in the returns service. Change one and you
 * must change the other, or the published policy promises a window the store
 * will refuse to honour.
 */
export interface SeedPage {
  slug: string
  title: string
  blocks: Array<{ type: string; data: Record<string, unknown> }>
  seoDescription: string
}

export const SYSTEM_PAGES: SeedPage[] = [
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
    title: 'Returns & exchanges',
    blocks: [
      {
        type: 'richText',
        data: {
          html: `<p>Every piece is cut and finished by hand. If something is not right, you have 7 days from delivery to send it back.</p>

<h2>The return window</h2>
<p>You may request a return or exchange within <strong>7 days of delivery</strong>. The window opens when your order is marked delivered and closes 7 days later; your account shows the exact closing date for each order. Once it has closed a request can no longer be raised.</p>

<h2>Condition of returned items</h2>
<p>Pieces must come back in the state they arrived in. We can only accept items that are:</p>
<ul>
<li>Unworn, unwashed and unaltered, with no marks, stains, perfume, deodorant or smoke odour.</li>
<li>Complete with all original tags, labels and brand seals still attached.</li>
<li>Returned in their original packaging, including dust bags, garment covers and hangers where supplied.</li>
<li>Accompanied by the invoice or the order number.</li>
</ul>
<p>Items that reach us worn, damaged, altered or missing their tags will be sent back to you at your cost, and no refund will be issued.</p>

<h2>What cannot be returned</h2>
<ul>
<li>Made-to-measure, custom-sized and personalised pieces, which are cut specifically for you.</li>
<li>Items marked final sale, or bought during a clearance or archive sale.</li>
<li>Innerwear, lingerie, swimwear, bodysuits and socks, for hygiene reasons.</li>
<li>Pierced jewellery, and accessories whose seal or hygiene sticker has been removed.</li>
<li>Gift cards and store credit.</li>
<li>Items already altered, tailored or dry-cleaned after delivery.</li>
</ul>

<h2>How to start a return</h2>
<ol>
<li>Sign in and open <a href="/account/orders">your orders</a>, then choose the delivered order you want to send back.</li>
<li>Pick the items and quantities, tell us the reason, and choose a refund, an exchange or store credit.</li>
<li>We review the request and confirm it, along with the pickup or shipping address.</li>
<li>Pack the piece with its tags and packaging intact and hand it to the courier, or ship it to the address given.</li>
</ol>
<p>You can follow a request — approved, in transit, received, inspected, completed — from <a href="/account/returns">your returns</a>. Please do not send anything back before the request has been approved: unannounced parcels cannot be matched to an order and may be refused.</p>

<h2>Exchanges</h2>
<p>Exchanges are offered for a different size or colour of the same style, subject to availability, and are limited to one exchange per item. If the replacement is unavailable we will issue a refund or store credit, whichever you prefer. The replacement is dispatched once the original piece reaches us and passes inspection.</p>

<h2>Refunds</h2>
<p>We inspect returns within 3 working days of arrival. Approved refunds go back to the original payment method and typically appear within <strong>7 to 10 working days</strong>, depending on your bank. Cash-on-delivery orders are refunded by bank transfer to details you provide. Store credit, where you choose it, is added to your account as soon as the return is completed.</p>
<p>A refund covers the price paid for the item. Original delivery charges, cash-on-delivery handling fees and gift wrapping are not refundable unless the item was faulty or incorrectly sent.</p>

<h2>Return shipping</h2>
<p>Where a reverse pickup is available at your pincode we will arrange it. A flat return shipping fee may be deducted from the refund on change-of-mind returns; the amount is confirmed when your request is approved.</p>
<p>If pickup is not available in your area, ship the parcel to the address we provide using a tracked service and share the tracking number with us. We cannot be responsible for returns lost in transit.</p>

<h2>Damaged, faulty or wrong items</h2>
<p>Please check your parcel on arrival. If a piece is damaged, faulty or not what you ordered, tell us within <strong>48 hours of delivery</strong> and include photographs of the item, its tag and the outer packaging. We will arrange a free pickup and send a replacement or a full refund, delivery charges included.</p>
<p>Small irregularities in weave, hand embroidery and natural dye are characteristic of hand-finished garments and are not treated as faults.</p>

<h2>Cancelling an order</h2>
<p>Orders can be cancelled free of charge at any point before dispatch — email us as soon as you can. Once a parcel has left the studio the order can no longer be cancelled, and the return process above applies instead. Made-to-measure orders cannot be cancelled once cutting has begun.</p>

<h2>Sale and promotional items</h2>
<p>Discounted items may be exchanged, or refunded as store credit, unless the product page says otherwise. Items marked final sale are not returnable. Where a gift or a threshold discount applied to the order, returning items that take the order below that threshold means the benefit is deducted from the refund.</p>

<h2>International orders</h2>
<p>Returns from outside India are accepted within the same 7-day window, but return shipping, duties and taxes are borne by the customer, and duties already paid are not refundable. Mark the parcel clearly as a returned good to avoid a second round of duty.</p>

<h2>Need help?</h2>
<p>Write to us at <a href="mailto:care@prashandki.in">care@prashandki.in</a>, Monday to Saturday, 10am to 6pm IST. This policy sits alongside our <a href="/terms">terms &amp; conditions</a> and does not affect your statutory rights under consumer law.</p>`,
        },
      },
    ],
    seoDescription:
      'How to return or exchange a piece: the 7-day window, condition requirements, refund timelines and what cannot be returned.',
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
    title: 'Terms & conditions',
    blocks: [
      {
        type: 'richText',
        data: {
          html: `<p>These terms govern your use of this website and every order you place with Prash &amp; Ki. Please read them before buying.</p>

<h2>1. About these terms</h2>
<p>This website is operated by Prash &amp; Ki. By browsing the site, creating an account or placing an order you agree to these terms. If you do not accept them, please do not use the site. We may update them from time to time; the version published here when you place an order is the one that applies to that order.</p>

<h2>2. Your account</h2>
<p>You may shop as a guest or create an account. If you create one, keep your password confidential and give us accurate contact and delivery details — we are not responsible for orders that fail because the details entered were wrong.</p>
<p>You must be at least 18, or have the consent of a parent or guardian, to place an order. We may suspend or close an account that is used fraudulently or in breach of these terms.</p>

<h2>3. Products and how they are described</h2>
<p>Our pieces are cut and finished by hand, and many are made to order. Small variations in colour, weave, embroidery and finish are part of that process and are not defects. Fabric texture and shade may also differ slightly between batches.</p>
<p>We photograph every product as faithfully as we can, but screens vary and colour on your device may not match the garment exactly. Please use the size guide on each product page; measurements are given with a small tolerance for hand finishing.</p>

<h2>4. Prices and taxes</h2>
<p>Prices are shown in Indian Rupees and include applicable GST unless stated otherwise. Delivery charges, where they apply, are calculated for your address and shown at checkout before you pay.</p>
<p>We may change prices at any time, but a change will never affect an order we have already accepted. If a product is listed at an obviously incorrect price because of a technical or human error, we may cancel the order and refund you in full rather than supply at that price.</p>

<h2>5. Orders and acceptance</h2>
<p>Placing an order is an offer to buy. The order confirmation we send acknowledges receipt; the contract is formed when we confirm dispatch of the items. We may decline or cancel an order if the item is out of stock, if a listing contained an error, if payment is not authorised, or if we suspect fraud or resale. Where we cancel, you are refunded in full.</p>

<h2>6. Payment</h2>
<p>Payment is taken through our payment provider using the methods shown at checkout. We do not store your full card details. Orders are processed once payment is confirmed; where cash on delivery is offered, a handling fee may apply and is shown before you place the order.</p>

<h2>7. Delivery</h2>
<p>Orders are despatched within two working days, and made-to-order pieces within the lead time shown on the product page. The delivery estimate for your address is shown at checkout. Estimates are estimates, not guarantees, and can be affected by couriers, weather and public holidays.</p>
<p>Risk in the goods passes to you on delivery. If a parcel is returned to us because nobody was available or the address was incorrect, we may charge the cost of re-delivery.</p>

<h2>8. Returns, exchanges and cancellations</h2>
<p>You may return most items within 7 days of delivery, provided they are unworn and their tags are attached. Made-to-measure pieces and items marked final sale are not returnable. Orders can be cancelled free of charge before dispatch.</p>
<p>The full conditions, timelines and the steps to raise a request are set out in our <a href="/returns-policy">returns &amp; exchanges policy</a>, which forms part of these terms.</p>

<h2>9. Care of your garments</h2>
<p>Follow the care label and the care notes on the product page. Damage caused by incorrect washing, ironing, bleaching or dry-cleaning is not a manufacturing fault and is not covered by our returns policy.</p>

<h2>10. Promotions and vouchers</h2>
<p>Discount codes, vouchers and gift cards are subject to the conditions published with them. Unless we say otherwise, they cannot be combined, have no cash value, cannot be exchanged for cash, and may be withdrawn at any time. We may cancel orders where a code has been misused.</p>

<h2>11. Intellectual property</h2>
<p>The designs, garment patterns, photography, text, logos and layout on this site belong to Prash &amp; Ki or our licensors. You may use the site for personal, non-commercial purposes. You may not copy our designs or imagery, reproduce our products, or use our name or marks without written permission.</p>

<h2>12. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
<li>Use the site for anything unlawful, or in a way that damages or disrupts it.</li>
<li>Scrape, mine or bulk-copy content, prices or images from the site.</li>
<li>Buy with the intention of unauthorised resale, or place orders in another person's name.</li>
<li>Upload or submit content that is unlawful, misleading, offensive or infringes someone else's rights.</li>
</ul>
<p>Anything you submit — a review, a photograph, a comment — you grant us a non-exclusive, royalty-free licence to display and use in connection with the store. You remain responsible for it.</p>

<h2>13. Availability of the site</h2>
<p>We aim to keep the store available, but we do not guarantee uninterrupted access. We may suspend, withdraw or change any part of the site for maintenance or business reasons without notice.</p>

<h2>14. Liability</h2>
<p>Our products are sold for personal use. To the extent permitted by law, we are not liable for indirect or consequential loss, loss of profit, or loss arising from your misuse of a garment or failure to follow the care instructions.</p>
<p>Nothing in these terms excludes liability for death or personal injury caused by our negligence, for fraud, or for anything else that cannot be excluded under Indian law. Where we are liable, our liability is limited to the amount you paid for the order concerned.</p>

<h2>15. Privacy</h2>
<p>We collect only what we need to process your order and run the store, and we do not sell your personal data. Payment details are handled by our payment provider. You can ask us to correct or delete your account data at any time by writing to us. See our <a href="/privacy-policy">privacy policy</a> for detail.</p>

<h2>16. Events outside our control</h2>
<p>We are not liable for delay or failure to perform caused by events beyond our reasonable control, including strikes, courier failure, fire, flood, epidemic, or restrictions imposed by an authority. We will let you know and, if the delay is substantial, you may cancel the affected order for a full refund.</p>

<h2>17. Governing law</h2>
<p>These terms are governed by the laws of India, and the courts of India have exclusive jurisdiction over any dispute arising from them. Nothing here limits your rights under the Consumer Protection Act, 2019.</p>

<h2>18. Contact us</h2>
<p>Write to us at <a href="mailto:care@prashandki.in">care@prashandki.in</a>, Monday to Saturday, 10am to 6pm IST. For anything to do with an order you have already placed, quoting the order number gets you an answer fastest.</p>`,
        },
      },
    ],
    seoDescription:
      'The terms on which we sell: orders, pricing, delivery, returns, intellectual property and liability.',
  },
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
