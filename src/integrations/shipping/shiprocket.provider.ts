import crypto from 'node:crypto'
import type { ShipmentStatus } from '@prisma/client'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { IntegrationError } from '../../utils/errors.js'
import type {
  CarrierEvent,
  CarrierRate,
  CreateProviderShipmentInput,
  ProviderShipment,
  ServiceabilityResult,
  ShipmentAddress,
  ShippingProvider,
  WebhookHeaders,
} from './shipping.types.js'

/**
 * Shiprocket (M21).
 *
 * An aggregator rather than a carrier: it holds accounts with a few dozen
 * couriers and picks between them. Two consequences run through this file.
 *
 * Booking is two calls, not one. `/orders/create/adhoc` registers the order
 * and returns a shipment id; `/courier/assign/awb` then picks a courier and
 * returns the tracking number. A parcel is only really booked after the
 * second, so a failure between them leaves an order in their panel with no
 * AWB — which is recoverable by hand, and is why the order id is returned
 * even when the AWB step fails.
 *
 * And the courier is chosen per parcel. Which one is the store's decision,
 * not Shiprocket's, so `SHIPROCKET_COURIER_RULE` picks between cheapest and
 * fastest rather than accepting whatever comes back first.
 *
 * The base URL is configurable because their sandbox and live hosts differ and
 * pointing at the wrong one produces an authentication failure that reads like
 * bad credentials.
 */

/** Their vocabulary → ours. Anything unlisted is deliberately ignored. */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  'awb assigned': 'READY_TO_SHIP',
  'label generated': 'READY_TO_SHIP',
  'pickup scheduled': 'READY_TO_SHIP',
  'pickup generated': 'READY_TO_SHIP',
  'pickup queued': 'READY_TO_SHIP',
  'out for pickup': 'READY_TO_SHIP',
  'picked up': 'IN_TRANSIT',
  shipped: 'IN_TRANSIT',
  'in transit': 'IN_TRANSIT',
  'reached at destination hub': 'IN_TRANSIT',
  'out for delivery': 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  'rto initiated': 'RETURNED_TO_ORIGIN',
  'rto in transit': 'RETURNED_TO_ORIGIN',
  'rto delivered': 'RETURNED_TO_ORIGIN',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  'lost/damaged': 'FAILED',
  // Recoverable: nobody home, a wrong address, weather. Distinct from FAILED,
  // which is the end of the attempt.
  undelivered: 'EXCEPTION',
  'delivery failed': 'EXCEPTION',
  'address incorrect': 'EXCEPTION',
  'customer not available': 'EXCEPTION',
}

interface CourierQuote {
  courier_company_id: number
  courier_name: string
  rate: number
  etd?: string
  estimated_delivery_days?: string | number
  cod?: number | boolean
  is_surface?: boolean
}

export class ShiprocketProvider implements ShippingProvider {
  readonly name = 'shiprocket'
  readonly canCreateShipments = true

  /** Their token lasts ten days; held until it expires or is refused. */
  private token: string | null = null
  private tokenExpiresAt = 0

  /**
   * The API password, however it was supplied.
   *
   * Shiprocket issues these and will not let you choose them, and they contain
   * `#` — which begins a comment in most .env parsers, so the value silently
   * arrives truncated. The base64 form exists for exactly that, and wins when
   * both are set because somebody who went to the trouble of encoding it meant
   * the encoded one.
   */
  private static password(): string | undefined {
    if (env.SHIPROCKET_PASSWORD_B64) {
      return Buffer.from(env.SHIPROCKET_PASSWORD_B64, 'base64').toString('utf8')
    }
    return env.SHIPROCKET_PASSWORD
  }

  isConfigured(): boolean {
    return Boolean(
      env.SHIPROCKET_EMAIL && ShiprocketProvider.password() && env.SHIPROCKET_PICKUP_LOCATION,
    )
  }

  // ------------------------------------------------------------------ auth

  private async authenticate(): Promise<string> {
    const res = await fetch(`${env.SHIPROCKET_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        email: env.SHIPROCKET_EMAIL,
        password: ShiprocketProvider.password(),
      }),
    })

    const body: unknown = await res.json().catch(() => null)
    const token = (body as { token?: string } | null)?.token

    if (!res.ok || !token) {
      const message = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`

      /**
       * Logged as an error, not only thrown.
       *
       * Every caller catches this and falls back to a flat rate, which is the
       * right behaviour for an outage and the wrong behaviour to be silent
       * about. A store ran for hours quoting flat rates with a Shiprocket
       * account locked out behind it, and nothing anywhere said so — the
       * symptom was a price that looked deliberate.
       */
      logger.error(
        { status: res.status, message, baseUrl: env.SHIPROCKET_BASE_URL },
        'Shiprocket authentication failed — every quote will fall back to the flat rate until this is fixed',
      )

      /**
       * Their lockout deserves its own sentence. It is not a wrong password
       * any more, it is the consequence of one, and the fix is to wait rather
       * than to keep changing credentials — which extends the block.
       */
      const blocked = /blocked|too many failed/i.test(message)

      // The base URL is named here on purpose: pointing at the wrong host is
      // the most common cause, and it reports as bad credentials.
      throw new IntegrationError(
        blocked
          ? `Shiprocket has locked this API user after repeated failed logins (${message}). ` +
            'Wait for the block to clear before retrying, then check the password survived the ' +
            'environment — one containing # is truncated by most .env parsers, which is what ' +
            'causes the repeated failures. SHIPROCKET_PASSWORD_B64 avoids that entirely.'
          : `Shiprocket refused the credentials (${message}). Check SHIPROCKET_EMAIL and SHIPROCKET_BASE_URL — ${env.SHIPROCKET_BASE_URL}`,
        'SHIPROCKET_AUTH_FAILED',
      )
    }

    this.token = token

    /**
     * The token's own expiry, not an assumed one. Their documented life is ten
     * days but the sandbox issues a year, and hard-coding the shorter number
     * would re-authenticate every ten days for no reason — and the longer one
     * would keep using a dead token for a year. An hour of margin so a long
     * call does not start valid and arrive expired.
     */
    const expiresAt = ShiprocketProvider.tokenExpiry(token)
    this.tokenExpiresAt = (expiresAt ?? Date.now() + 240 * 60 * 60 * 1000) - 60 * 60 * 1000
    logger.info({ provider: 'shiprocket' }, 'Shiprocket session established')
    return token
  }

  /** Reads `exp` from the token without verifying it — it is theirs to verify. */
  private static tokenExpiry(token: string): number | null {
    try {
      const [, payload] = token.split('.')
      if (!payload) return null
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }
      return claims.exp ? claims.exp * 1000 : null
    } catch {
      return null
    }
  }

  private async withToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token
    return this.authenticate()
  }

  /**
   * One request, retried once if the token was refused.
   *
   * A ten-day token can still be revoked — a password change in their panel,
   * an admin deleting the API user — and the only way to find out is a 401.
   * The retry re-authenticates rather than failing a customer's checkout for
   * something invisible from here.
   */
  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
    retry = true,
  ): Promise<T> {
    const token = await this.withToken()
    // Serviceability answers on its own host — theirs is split that way in
    // sandbox and production alike.
    const base = path.startsWith('/courier/serviceability')
      ? (env.SHIPROCKET_SERVICEABILITY_BASE_URL ?? env.SHIPROCKET_BASE_URL)
      : env.SHIPROCKET_BASE_URL
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)

    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })

    if (res.status === 401 && retry) {
      this.token = null
      return this.call<T>(path, init, false)
    }

    const body: unknown = await res.json().catch(() => null)

    if (!res.ok) {
      const message =
        (body as { message?: string } | null)?.message ??
        (body as { errors?: unknown } | null)?.errors ??
        `HTTP ${res.status}`
      throw new IntegrationError(
        `Shiprocket ${path} failed: ${typeof message === 'string' ? message : JSON.stringify(message)}`,
        'SHIPROCKET_REQUEST_FAILED',
      )
    }

    return body as T
  }

  // --------------------------------------------------------- serviceability

  async checkServiceability(
    postalCode: string,
    options: { country?: string; cod?: boolean; weightGrams?: number } = {},
  ): Promise<ServiceabilityResult> {
    if (options.country && options.country.toUpperCase() !== 'IN') {
      return { serviceable: false, codAvailable: false, reason: 'India only' }
    }

    try {
      const body = await this.call<{ data?: { available_courier_companies?: CourierQuote[] } }>(
        '/courier/serviceability/',
        {
          query: {
            pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE ?? '',
            delivery_postcode: postalCode,
            // Their API works in kilograms. A parcel with no weight recorded
            // is quoted at half a kilo rather than zero, which they reject.
            weight: String(Math.max(options.weightGrams ?? 500, 50) / 1000),
            cod: options.cod ? '1' : '0',
          },
        },
      )

      const couriers = body.data?.available_courier_companies ?? []
      if (couriers.length === 0) {
        return { serviceable: false, codAvailable: false, reason: 'No courier serves that PIN code' }
      }

      const days = couriers
        .map((c) => Number(c.estimated_delivery_days ?? NaN))
        .filter((d) => Number.isFinite(d) && d > 0)

      return {
        serviceable: true,
        codAvailable: couriers.some((c) => Boolean(c.cod)),
        estimatedDays: days.length > 0 ? Math.min(...days) : null,
      }
    } catch (err) {
      /**
       * A serviceability check that cannot be made is not a "we do not
       * deliver there". Saying no because their API is down turns an outage
       * into lost orders; the zones configured in admin remain the authority
       * on where this shop delivers.
       */
      logger.warn({ err, postalCode }, 'Shiprocket serviceability check failed')
      throw new IntegrationError(
        'Could not check that PIN code just now',
        'SHIPROCKET_SERVICEABILITY_UNAVAILABLE',
      )
    }
  }

  /**
   * What the carriers charge for this parcel, as the two choices a customer
   * actually cares about: the cheap one and the quick one.
   *
   * Fifteen couriers on a route is a menu nobody wants. Cheapest and fastest
   * are collapsed to one entry when the same courier wins both, so the page
   * never offers the same thing twice at the same price under two names.
   */
  async quoteRates(
    postalCode: string,
    options: { weightGrams: number; cod?: boolean; country?: string },
  ): Promise<CarrierRate[]> {
    if (options.country && options.country.toUpperCase() !== 'IN') return []

    const body = await this.call<{ data?: { available_courier_companies?: CourierQuote[] } }>(
      '/courier/serviceability/',
      {
        query: {
          pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE ?? '',
          delivery_postcode: postalCode,
          weight: String(Math.max(options.weightGrams, 50) / 1000),
          cod: options.cod ? '1' : '0',
        },
      },
    )

    const couriers = (body.data?.available_courier_companies ?? []).filter(
      (c) => Number.isFinite(Number(c.rate)) && Number(c.rate) > 0,
    )
    if (couriers.length === 0) return []

    const days = (c: CourierQuote) => Number(c.estimated_delivery_days ?? 99)

    const cheapest = [...couriers].sort((a, b) => a.rate - b.rate || days(a) - days(b))[0]!
    const fastest = [...couriers].sort((a, b) => days(a) - days(b) || a.rate - b.rate)[0]!

    const toRate = (c: CourierQuote, rule: 'cheapest' | 'fastest'): CarrierRate => ({
      rule,
      courierId: String(c.courier_company_id),
      courierName: c.courier_name,
      // Theirs is rupees with decimals; ours is paise.
      amount: Math.round(Number(c.rate) * 100),
      estimatedDays: Number.isFinite(days(c)) && days(c) < 99 ? days(c) : null,
    })

    // The same courier winning both is common on short routes.
    if (cheapest.courier_company_id === fastest.courier_company_id) {
      return [toRate(cheapest, 'cheapest')]
    }

    return [toRate(cheapest, 'cheapest'), toRate(fastest, 'fastest')]
  }

  // ---------------------------------------------------------------- booking

  private static splitName(name: string): { first: string; last: string } {
    const parts = name.trim().split(/\s+/)
    // Their API wants the two separately and rejects an empty surname.
    return { first: parts[0] ?? 'Customer', last: parts.slice(1).join(' ') || '.' }
  }

  private static addressPayload(to: ShipmentAddress) {
    const { first, last } = ShiprocketProvider.splitName(to.name)
    return {
      billing_customer_name: first,
      billing_last_name: last,
      billing_address: to.addressLine1,
      billing_address_2: to.addressLine2 ?? '',
      billing_city: to.city,
      billing_pincode: to.postalCode,
      billing_state: to.state,
      billing_country: to.country === 'IN' ? 'India' : to.country,
      billing_email: env.SHIPROCKET_ORDER_EMAIL ?? '',
      billing_phone: to.phone.replace(/\D/g, '').slice(-10),
      shipping_is_billing: true,
    }
  }

  /**
   * The couriers worth trying, best first.
   *
   * A list rather than one choice, because a courier that quotes for a route
   * can still refuse the individual parcel — a weight it will not take, a hub
   * that is down, an upstream account problem. Blue Dart quoted the cheapest
   * rate for a Chennai to Delhi parcel and then answered "Error in generating
   * awb with bluedart [BD-003]"; Xpressbees, next on the list, took it. Giving
   * up on the first refusal leaves an order registered with no AWB and a
   * parcel nobody is collecting.
   */
  private rankCouriers(couriers: CourierQuote[]): CourierQuote[] {
    if (couriers.length === 0) return []

    const days = (c: CourierQuote) => Number(c.estimated_delivery_days ?? 99)
    const byRule =
      env.SHIPROCKET_COURIER_RULE === 'fastest'
        ? [...couriers].sort((a, b) => days(a) - days(b) || a.rate - b.rate)
        : [...couriers].sort((a, b) => a.rate - b.rate || days(a) - days(b))

    if (!env.SHIPROCKET_COURIER_ID) return byRule

    // A preferred courier goes first, but the rest stay behind it as fallbacks
    // rather than being discarded.
    const preferred = byRule.find((c) => String(c.courier_company_id) === env.SHIPROCKET_COURIER_ID)
    if (!preferred) {
      logger.warn(
        { preferred: env.SHIPROCKET_COURIER_ID },
        'Preferred courier does not serve this parcel; falling back to the rule',
      )
      return byRule
    }
    return [preferred, ...byRule.filter((c) => c !== preferred)]
  }

  async createShipment(input: CreateProviderShipmentInput): Promise<ProviderShipment> {
    if (!this.isConfigured()) {
      throw new IntegrationError(
        'Shiprocket is not configured — set SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD and SHIPROCKET_PICKUP_LOCATION',
        'SHIPROCKET_NOT_CONFIGURED',
      )
    }

    const created = await this.call<{ order_id?: number; shipment_id?: number; status?: string }>(
      '/orders/create/adhoc',
      {
        method: 'POST',
        body: {
          // Ours, so a parcel can always be traced back to an order.
          order_id: input.shipmentNumber,
          order_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
          pickup_location: env.SHIPROCKET_PICKUP_LOCATION,
          ...ShiprocketProvider.addressPayload(input.to),
          order_items: input.items.map((item) => ({
            name: item.name,
            sku: item.sku,
            units: item.quantity,
            // Rupees, not paise — theirs is a decimal API.
            selling_price: item.unitPrice / 100,
          })),
          payment_method: (input.codAmount ?? 0) > 0 ? 'COD' : 'Prepaid',
          sub_total:
            input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) / 100,
          // Centimetres and kilograms. Defaults are deliberately small rather
          // than zero: they reject a parcel with no dimensions, and a wrong
          // guess is corrected at pickup, where a zero is simply refused.
          length: (input.lengthMm ?? 300) / 10,
          breadth: (input.widthMm ?? 250) / 10,
          height: (input.heightMm ?? 80) / 10,
          weight: Math.max(input.weightGrams, 50) / 1000,
        },
      },
    )

    if (!created.shipment_id) {
      throw new IntegrationError(
        'Shiprocket accepted the order but returned no shipment id',
        'SHIPROCKET_NO_SHIPMENT_ID',
      )
    }

    const providerShipmentId = String(created.shipment_id)

    /**
     * The parcel is not really booked until an AWB exists. If this half fails
     * the order is still in their panel and can be completed by hand, so the
     * id is returned rather than thrown away — losing it would mean a
     * duplicate order on the next attempt.
     */
    try {
      const quotes = await this.call<{ data?: { available_courier_companies?: CourierQuote[] } }>(
        '/courier/serviceability/',
        {
          query: {
            pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE ?? '',
            delivery_postcode: input.to.postalCode,
            weight: String(Math.max(input.weightGrams, 50) / 1000),
            cod: (input.codAmount ?? 0) > 0 ? '1' : '0',
          },
        },
      )

      const ranked = this.rankCouriers(quotes.data?.available_courier_companies ?? [])

      /**
       * Down the list until one takes it. Their API answers 200 whether the
       * courier accepted or refused — the refusal is a string in the body —
       * so success is "an AWB came back", not "the request did not throw".
       */
      let assignedData: { awb_code?: string; courier_name?: string } | null = null
      let courier: CourierQuote | null = null
      const refusals: string[] = []

      for (const candidate of ranked.slice(0, 4)) {
        const attempt = await this.call<{
          response?: { data?: { awb_code?: string; courier_name?: string } | string }
        }>('/courier/assign/awb', {
          method: 'POST',
          body: {
            shipment_id: Number(providerShipmentId),
            courier_id: candidate.courier_company_id,
          },
        }).catch((err) => {
          refusals.push(`${candidate.courier_name}: ${String(err).slice(0, 120)}`)
          return null
        })

        const data = attempt?.response?.data
        if (data && typeof data === 'object' && data.awb_code) {
          assignedData = data
          courier = candidate
          break
        }

        refusals.push(
          `${candidate.courier_name}: ${typeof data === 'string' ? data.slice(0, 120) : 'no AWB returned'}`,
        )
      }

      if (!assignedData) {
        logger.error(
          { providerShipmentId, refusals },
          'Every courier refused the parcel — the order is registered but has no AWB',
        )
      }

      const awb = { response: { data: assignedData } }
      const assigned = awb.response?.data

      /**
       * The label, so an operator has something to print and stick on the box.
       *
       * Only possible once an AWB exists — it is the barcode on the label — and
       * its absence must not undo a booking that succeeded. A parcel with a
       * tracking number and no label is a printing problem; a parcel with no
       * AWB is a parcel that was never booked.
       */
      let labelUrl: string | null = null
      try {
        const label = await this.call<{ label_url?: string; label_created?: number }>(
          '/courier/generate/label',
          { method: 'POST', body: { shipment_id: [Number(providerShipmentId)] } },
        )
        labelUrl = label.label_url ?? null
      } catch (err) {
        logger.warn(
          { err, providerShipmentId },
          'Shiprocket booked the parcel but would not generate a label yet',
        )
      }

      return {
        providerShipmentId,
        trackingNumber: assigned?.awb_code ?? null,
        carrier: assigned?.courier_name ?? courier?.courier_name ?? 'Shiprocket',
        labelUrl,
        estimatedAt: null,
        raw: { created, awb },
      }
    } catch (err) {
      logger.error(
        { err, shipmentNumber: input.shipmentNumber, providerShipmentId },
        'Shiprocket order created but AWB assignment failed — assign it by hand in their panel',
      )
      return {
        providerShipmentId,
        trackingNumber: null,
        carrier: null,
        raw: { created, awbError: String(err) },
      }
    }
  }

  /**
   * Asks for the label of a parcel already booked.
   *
   * Their endpoint is generate-or-return: calling it again for a parcel that
   * already has one hands back the same URL rather than making a second
   * label, so this is safe to press twice.
   */
  async fetchLabel(providerShipmentId: string): Promise<string | null> {
    const body = await this.call<{ label_url?: string; label_created?: number }>(
      '/courier/generate/label',
      { method: 'POST', body: { shipment_id: [Number(providerShipmentId)] } },
    )
    return body.label_url ?? null
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    await this.call('/orders/cancel/shipment/awbs', {
      method: 'POST',
      body: { awbs: [providerShipmentId] },
    }).catch(async () => {
      // Before an AWB exists there is nothing to cancel at the courier, only
      // the order in their panel.
      await this.call('/orders/cancel', {
        method: 'POST',
        body: { ids: [Number(providerShipmentId)] },
      })
    })
  }

  // ---------------------------------------------------------------- inbound

  /**
   * Their tracking callback.
   *
   * Shiprocket authenticates webhooks with a token the store sets in their
   * panel and they send back in `x-api-key`. It is a shared secret rather than
   * a signature, so it is compared in constant time and the body is not
   * trusted to identify itself — a callback with no token configured is
   * refused rather than accepted, because an open tracking endpoint lets
   * anyone mark an order delivered.
   */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): CarrierEvent | null {
    const expected = env.SHIPROCKET_WEBHOOK_TOKEN
    if (!expected) {
      logger.error('Shiprocket webhook received but SHIPROCKET_WEBHOOK_TOKEN is not set')
      return null
    }

    const given = headers['x-api-key'] ?? ''
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      throw new IntegrationError('Shiprocket webhook body is not JSON', 'SHIPROCKET_BAD_PAYLOAD')
    }

    return this.normalizeWebhook(payload)
  }

  normalizeWebhook(payload: unknown): CarrierEvent {
    const body = payload as {
      /**
       * A number in their own published sample, not a string. Ours is a string
       * column, and a number reaching the lookup does not fail to match — it
       * throws, so the update is recorded as failed and the parcel never
       * moves. Normalised below rather than trusted.
       */
      awb?: string | number
      order_id?: string | number
      shipment_status?: string
      current_status?: string
      scan_date?: string
      current_timestamp?: string
      location?: string
      sr_status_label?: string
      etd?: string
      /** The tracking history. Where the location and the wording live. */
      scans?: Array<{ date?: string; activity?: string; location?: string }>
    }

    /**
     * The most recent scan, which is not reliably the first or last in the
     * array — their sample is newest-first, and that is not something to
     * depend on. Sorted by date instead.
     */
    const latestScan = [...(body.scans ?? [])]
      .filter((s) => s?.date)
      .sort((a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime())[0]

    const providerStatus = String(
      body.shipment_status ?? body.current_status ?? body.sr_status_label ?? '',
    )
    const status = STATUS_MAP[providerStatus.trim().toLowerCase()]

    if (!status) {
      // Authentic but unusable: a status we have no mapping for. Thrown rather
      // than guessed, so an unmapped state is noticed instead of silently
      // becoming "in transit".
      throw new IntegrationError(
        `Shiprocket sent an unmapped status: ${providerStatus}`,
        'SHIPROCKET_UNMAPPED_STATUS',
      )
    }

    const occurredAt = new Date(
      body.scan_date ?? latestScan?.date ?? body.current_timestamp ?? Date.now(),
    )

    /** Their own sample sends this as a number; the column is text. */
    const trackingNumber = body.awb == null ? null : String(body.awb).trim() || null

    return {
      /**
       * They send no event id, so one is derived from the facts that make an
       * event unique. A redelivery of the same scan hashes the same and is
       * discarded; a genuine later scan hashes differently.
       */
      eventId: crypto
        .createHash('sha256')
        .update(`${trackingNumber ?? body.order_id ?? ''}|${providerStatus}|${occurredAt.toISOString()}`)
        .digest('hex')
        .slice(0, 32),
      providerShipmentId: body.order_id == null ? null : String(body.order_id),
      trackingNumber,
      status,
      providerStatus,
      /**
       * Their sample carries neither a top-level label nor a location — both
       * live on the scans. Falling back to the newest scan is what puts
       * "SHIPMENT OUT FOR DELIVERY, PATIALA" on the customer's timeline
       * instead of a blank line.
       */
      message: body.sr_status_label ?? latestScan?.activity ?? null,
      location: body.location ?? latestScan?.location ?? null,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      payload,
    }
  }
}
