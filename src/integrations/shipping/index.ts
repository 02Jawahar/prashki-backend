import { prisma } from '../../config/db.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { FakeShippingProvider } from './fake.provider.js'
import { ShiprocketProvider } from './shiprocket.provider.js'
import { ManualShippingProvider } from './manual.provider.js'
import type { ShippingProvider } from './shipping.types.js'

export type * from './shipping.types.js'
export { ManualShippingProvider, mapCarrierStatus } from './manual.provider.js'

/**
 * Registered carrier adapters (FR-21.3), keyed by the name that goes in
 * `SHIPPING_PROVIDER` or in a shipping method's `provider` column.
 *
 * A registry rather than one configured provider, because a store legitimately
 * uses more than one carrier at a time: a courier for metro pincodes, India
 * Post for the rest, and hand-booked parcels for the pieces that travel in a
 * box no API understands. The method decides, so choosing a carrier is a data
 * change in the admin screen rather than a deploy.
 *
 * Only `manual` ships in the box, because the carrier is an open decision in
 * the PRD and an adapter written against a guessed API is worse than none. A
 * real carrier is added here — implement `ShippingProvider`, add one line
 * below — and nothing outside this folder changes.
 */
type AdapterFactory = () => ShippingProvider

const ADAPTERS: Record<string, AdapterFactory> = {
  manual: () => new ManualShippingProvider(),
  shiprocket: () => new ShiprocketProvider(),
  /**
   * A carrier that behaves, for proving the shop's own half. It refuses to
   * configure itself in production, so a stray SHIPPING_PROVIDER=fake there
   * books nothing rather than booking parcels nobody collects.
   */
  fake: () => new FakeShippingProvider(),
}

/** Adapters hold state — HTTP agents, cached auth tokens — so one instance each. */
const instances = new Map<string, ShippingProvider>()

function normalise(name: string): string {
  return name.trim().toLowerCase()
}

/** Every carrier name this build can actually talk to. */
export function listShippingProviders(): string[] {
  return Object.keys(ADAPTERS)
}

export function isRegisteredProvider(name: string): boolean {
  // `Object.hasOwn`, not `name in ADAPTERS` — the name arrives from the
  // database, and a plain lookup would resolve "constructor" or "toString" to
  // something inherited from Object.prototype and treat it as an adapter.
  return Object.hasOwn(ADAPTERS, normalise(name))
}

/**
 * Resolves a carrier adapter by name, defaulting to `SHIPPING_PROVIDER`.
 *
 * Throws for a name nobody registered, which is the right outcome even at
 * booking time: falling back to manual would leave an operator believing a
 * parcel was booked with a courier that never heard of it.
 */
export function getShippingProvider(name?: string | null): ShippingProvider {
  const key = normalise(name ?? env.SHIPPING_PROVIDER)

  const cached = instances.get(key)
  if (cached) return cached

  if (!Object.hasOwn(ADAPTERS, key)) {
    throw new Error(
      `Shipping provider "${key}" is not registered. ` +
        `Available: ${listShippingProviders().join(', ')}. ` +
        `Implement ShippingProvider and register it in src/integrations/shipping/index.ts.`,
    )
  }

  const provider = ADAPTERS[key]!()
  instances.set(key, provider)
  return provider
}

/**
 * Checks every carrier the store could reach for, at boot.
 *
 * The environment default *and* each one named on an active shipping method,
 * because a method pointing at an unregistered or unconfigured adapter is
 * invisible until the day someone tries to ship on it. Called after the
 * database is up so the method check is available.
 */
export async function assertShippingConfigured(): Promise<void> {
  const fallback = getShippingProvider()
  if (!fallback.isConfigured()) {
    throw new Error(`Shipping provider "${fallback.name}" is selected but not configured`)
  }

  const methods = await prisma.shippingMethod
    .findMany({
      where: { isActive: true, provider: { not: null } },
      select: { name: true, provider: true },
    })
    // A container can start before its migrations have run. That is the
    // migration's problem to report, not this check's.
    .catch(() => [] as Array<{ name: string; provider: string | null }>)

  for (const method of methods) {
    const provider = getShippingProvider(method.provider)
    if (!provider.isConfigured()) {
      throw new Error(
        `Shipping method "${method.name}" books with "${provider.name}", which is not configured`,
      )
    }
  }

  const active = [...new Set([fallback.name, ...methods.map((m) => normalise(m.provider!))])]

  logger.info(
    {
      default: fallback.name,
      active,
      canCreateShipments: active.filter((name) => getShippingProvider(name).canCreateShipments),
    },
    'Shipping providers ready',
  )

  /**
   * Not fatal. A studio that books every parcel by hand and never wires up a
   * callback is a legitimate way to run, and refusing to start would be worse
   * than the silence. But a carrier that *is* posting status updates gets a
   * 400 on every one of them, and the first sign of that is a customer asking
   * where their parcel is — so it goes in the log at boot.
   */
  if (!env.SHIPPING_WEBHOOK_SECRET) {
    logger.warn(
      'SHIPPING_WEBHOOK_SECRET is not set — carrier status callbacks cannot be verified and will be rejected',
    )
  }
}
