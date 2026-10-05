import { prisma } from '../../config/db.js'
import { logger } from '../../config/logger.js'
import { STUDIO_WHATSAPP_KEY } from './studio-alert.js'

/**
 * The two WhatsApp numbers the shop knows about, and the code that makes sure
 * a row exists for each.
 *
 * Settings live in the database so they can be changed without a deploy, which
 * means a newly added one has to get there somehow. The seed only runs against
 * a fresh database, so a setting introduced in a release would simply be absent
 * in production — and absent reads the same as empty, so the feature would
 * quietly do nothing.
 *
 * Both start blank on purpose. Blank is the off switch: no number, no floating
 * button on the storefront and no copies sent. Nothing starts messaging anybody
 * until somebody types a number in.
 *
 * They are two settings rather than one because they are genuinely different
 * things, and conflating them would be a privacy bug waiting to happen. One is
 * published to every visitor; the other is an internal address. Today they hold
 * the same number, and they do not have to tomorrow.
 */

/**
 * Where customers are sent when they tap the WhatsApp button. `general` is a
 * group the public settings endpoint exposes, which is the point — the
 * storefront has to read it.
 */
export const PUBLIC_WHATSAPP_KEY = 'store.whatsapp'

const DEFAULTS = [
  {
    key: PUBLIC_WHATSAPP_KEY,
    group: 'general',
    label: 'WhatsApp number shown to customers',
  },
  {
    key: STUDIO_WHATSAPP_KEY,
    // Not `general`, and not any other published group. This one is only ever
    // read on the server.
    group: 'notifications',
    label: 'WhatsApp number that receives order alerts',
  },
]

export async function ensureContactSettings(): Promise<void> {
  let added = 0

  for (const setting of DEFAULTS) {
    const existing = await prisma.setting.findUnique({
      where: { key: setting.key },
      select: { id: true },
    })
    // Never overwrites. A number somebody typed in is not a deploy's business.
    if (existing) continue

    await prisma.setting.create({
      data: { key: setting.key, value: '', type: 'STRING', group: setting.group, label: setting.label },
    })
    added++
  }

  if (added > 0) logger.info({ added }, 'Created missing contact settings')
}
