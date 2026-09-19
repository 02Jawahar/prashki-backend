import { env, isProduction } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { MockPaymentProvider } from './mock.provider.js'
import { RazorpayProvider } from './razorpay.provider.js'
import type { PaymentProvider } from './payment.types.js'

export type * from './payment.types.js'
export { MockPaymentProvider } from './mock.provider.js'

let provider: PaymentProvider | null = null

export function getPaymentProvider(): PaymentProvider {
  if (provider) return provider

  if (env.PAYMENT_PROVIDER === 'razorpay') {
    const razorpay = new RazorpayProvider()
    if (!razorpay.isConfigured()) {
      // Failing loudly beats silently taking fake payments in production.
      if (isProduction) {
        throw new Error('PAYMENT_PROVIDER=razorpay but RAZORPAY_KEY_ID/SECRET are missing')
      }
      logger.warn('Razorpay selected but not configured — falling back to the mock provider')
      provider = new MockPaymentProvider()
      return provider
    }
    provider = razorpay
    return provider
  }

  if (isProduction) {
    throw new Error('The mock payment provider cannot be used in production. Set PAYMENT_PROVIDER=razorpay.')
  }

  provider = new MockPaymentProvider()
  logger.info('Payment provider: mock (development only)')
  return provider
}

/**
 * Resolves the payment provider at boot, so a store that cannot take money
 * fails the deploy rather than the first customer.
 *
 * `getPaymentProvider` already refuses the mock provider in production and
 * throws on missing Razorpay credentials — but it is called lazily, from the
 * checkout request. Without this the container starts, passes its health
 * check, serves the whole catalogue, and only breaks at the one moment it
 * cannot afford to: someone with a full bag pressing Pay.
 */
export function assertPaymentConfigured(): void {
  const active = getPaymentProvider()
  logger.info({ provider: active.name }, 'Payment provider ready')
}
