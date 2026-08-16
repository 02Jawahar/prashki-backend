import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { ManualShippingProvider } from './manual.provider.js'
import type { ShippingProvider } from './shipping.types.js'

export type * from './shipping.types.js'
export { ManualShippingProvider, mapCarrierStatus } from './manual.provider.js'

let provider: ShippingProvider | null = null

/**
 * Resolves the configured carrier adapter (FR-21.3).
 *
 * Only `manual` ships in the box, because the carrier is an open decision in
 * the PRD and an adapter written against a guessed API is worse than none. A
 * real carrier is added here: implement `ShippingProvider`, register it in the
 * switch, set SHIPPING_PROVIDER. Nothing outside this folder changes.
 */
export function getShippingProvider(): ShippingProvider {
  if (provider) return provider

  switch (env.SHIPPING_PROVIDER) {
    case 'manual':
      provider = new ManualShippingProvider()
      return provider

    default:
      // A carrier named but not implemented must fail loudly at boot rather
      // than quietly falling back and letting parcels go unbooked.
      throw new Error(
        `SHIPPING_PROVIDER=${env.SHIPPING_PROVIDER} is declared but no adapter is registered. ` +
          `Implement ShippingProvider and register it in src/integrations/shipping/index.ts, ` +
          `or set SHIPPING_PROVIDER=manual.`,
      )
  }
}

/** Called at boot so a misconfiguration surfaces before the first request. */
export function assertShippingConfigured(): void {
  const active = getShippingProvider()
  if (!active.isConfigured()) {
    throw new Error(`Shipping provider "${active.name}" is selected but not configured`)
  }
  logger.info(
    { provider: active.name, canCreateShipments: active.canCreateShipments },
    'Shipping provider ready',
  )
}
