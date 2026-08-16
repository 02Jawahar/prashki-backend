/**
 * Payment provider contract (spec §30).
 *
 * Order and payment logic only ever sees this interface. Swapping Razorpay for
 * another gateway means implementing it again — no changes to orders, cart or
 * the database schema, which already stores `provider` and the provider's ids.
 */
export interface CreateProviderOrderInput {
  orderId: string
  orderNumber: string
  /** integer paise */
  amount: number
  currency: string
  customerEmail: string
  customerName: string
}

export interface ProviderOrder {
  /** The provider's own order id, handed to the client to open checkout. */
  providerOrderId: string
  amount: number
  currency: string
  /** Publishable key the browser needs. Never a secret. */
  publicKey?: string
}

export interface VerifyPaymentInput {
  providerOrderId: string
  providerPaymentId: string
  signature: string
}

export interface VerifiedPayment {
  valid: boolean
  providerPaymentId: string
  reason?: string
}

export interface WebhookEvent {
  /** Provider's unique event id — the idempotency key. */
  eventId: string
  eventType: string
  providerOrderId?: string
  providerPaymentId?: string
  /** 'paid' | 'failed' | 'ignored' */
  outcome: 'paid' | 'failed' | 'ignored'
  amount?: number
  payload: unknown
}

export interface RefundInput {
  /** The gateway's payment id, captured when the payment succeeded. */
  providerPaymentId: string
  /** integer paise; may be less than the payment for a partial refund. */
  amount: number
  /** Our own reference, so the gateway dashboard lines up with our records. */
  reference: string
  reason?: string
}

export interface ProviderRefund {
  /** The gateway's refund id. Stored unique so a replayed webhook is a no-op. */
  providerRefundId: string
  amount: number
  /** 'pending' while the gateway is still processing; 'processed' when done. */
  status: 'pending' | 'processed' | 'failed'
  raw: unknown
}

export interface PaymentProvider {
  readonly name: string
  /** True when the provider has everything it needs to actually transact. */
  isConfigured(): boolean
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>
  /** Verifies the client-side callback signature. Must run server-side. */
  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment>
  /** Verifies a webhook against its signature, using the RAW body bytes. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent | null
  /** Sends money back. Never called from a customer-facing route. */
  refund(input: RefundInput): Promise<ProviderRefund>
}
