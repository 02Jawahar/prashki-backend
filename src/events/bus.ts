import { EventEmitter } from 'node:events'
import { logger } from '../config/logger.js'

/**
 * Internal event bus (spec §43).
 *
 * Deliberately small: an in-process emitter with typed payloads. Business logic
 * emits, side effects (email, SMS, WhatsApp) subscribe — so adding a
 * notification never means editing the order service.
 *
 * Handlers are isolated: one throwing must not break the emitter or the request
 * that emitted. When this needs durability and retries, the same call sites can
 * push to BullMQ/Redis instead without touching the emitters.
 */
export interface EventMap {
  USER_REGISTERED: { userId: string; email: string; name: string }
  PRODUCT_CREATED: { productId: string; name: string }
  PRODUCT_UPDATED: { productId: string; changes: string[] }
  INVENTORY_UPDATED: { variantId: string; availableStock: number }
  ORDER_CREATED: { orderId: string; orderNumber: string; userId: string; total: number }
  ORDER_PAID: { orderId: string; orderNumber: string; userId: string; total: number }
  ORDER_FAILED: {
    orderId: string
    orderNumber: string
    /// Null only if the order vanished between the failure and the lookup.
    userId: string | null
    reason: string
  }
  ORDER_CANCELLED: { orderId: string; orderNumber: string }
  ORDER_SHIPPED: { orderId: string; orderNumber: string }
  ORDER_DELIVERED: { orderId: string; orderNumber: string }
  RETURN_UPDATED: {
    returnRequestId: string
    returnNumber: string
    userId: string
    status: string
    note: string | null
  }
  REFUND_ISSUED: {
    refundId: string
    orderId: string
    orderNumber: string
    userId: string
    amount: number
  }
}

export type EventName = keyof EventMap

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

export function emit<K extends EventName>(name: K, payload: EventMap[K]): void {
  logger.debug({ event: name, payload }, 'event emitted')
  emitter.emit(name, payload)
}

export function on<K extends EventName>(name: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
  emitter.on(name, (payload: EventMap[K]) => {
    void Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.error({ err, event: name }, 'Event handler failed'))
  })
}
