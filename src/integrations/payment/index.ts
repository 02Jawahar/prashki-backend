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
