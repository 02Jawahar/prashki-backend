import type { Response } from 'express'

/**
 * The only two response shapes the API emits (spec §46).
 *
 *   { success: true,  data: ... }
 *   { success: false, error: { code, message, details? } }
 */
export interface ApiSuccess<T> {
  success: true
  data: T
  meta?: Record<string, unknown>
}

export interface ApiFailure {
  success: false
  error: { code: string; message: string; details?: unknown }
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>) {
  const body: ApiSuccess<T> = { success: true, data }
  if (meta) body.meta = meta
  return res.json(body)
}

export function created<T>(res: Response, data: T) {
  return res.status(201).json({ success: true, data } satisfies ApiSuccess<T>)
}

export function noContent(res: Response) {
  return res.status(204).send()
}

export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiFailure = { success: false, error: { code, message } }
  if (details !== undefined) body.error.details = details
  return res.status(status).json(body)
}

export interface PageMeta {
  page: number
  perPage: number
  total: number
  pageCount: number
}

export function pageMeta(page: number, perPage: number, total: number): PageMeta {
  return { page, perPage, total, pageCount: Math.max(1, Math.ceil(total / perPage)) }
}
