import type { RequestHandler } from 'express'
import type { ZodTypeAny, z } from 'zod'
import { ValidationError } from '../utils/errors.js'

/**
 * Schema validation for body / query / params (spec §47).
 *
 * The parsed (and therefore coerced and stripped) result replaces the raw input
 * on a `validated` property, so handlers read typed data and never the raw
 * request. Express 5 makes req.query a getter, so we cannot assign over it.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated?: { body?: unknown; query?: unknown; params?: unknown }
    }
  }
}

interface Schemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
}

export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    req.validated ??= {}

    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key]
      if (!schema) continue

      const result = schema.safeParse(req[key])
      if (!result.success) {
        return next(
          new ValidationError(
            'Validation failed',
            result.error.issues.map((i) => ({
              path: [key, ...i.path].join('.'),
              message: i.message,
            })),
          ),
        )
      }
      req.validated[key] = result.data
    }

    next()
  }
}

/** Typed accessors so handlers don't cast at every call site. */
export const body = <T extends ZodTypeAny>(req: Express.Request, _schema?: T): z.infer<T> =>
  req.validated?.body as z.infer<T>
export const query = <T extends ZodTypeAny>(req: Express.Request, _schema?: T): z.infer<T> =>
  req.validated?.query as z.infer<T>
export const params = <T extends ZodTypeAny>(req: Express.Request, _schema?: T): z.infer<T> =>
  req.validated?.params as z.infer<T>
