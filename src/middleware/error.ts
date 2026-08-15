import type { ErrorRequestHandler, RequestHandler } from 'express'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { MulterError } from 'multer'
import { AppError } from '../utils/errors.js'
import { fail } from '../utils/response.js'
import { logger } from '../config/logger.js'
import { isProduction } from '../config/env.js'

export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`)
}

/**
 * Central error handler (spec §49). Maps every known failure onto a status and
 * a stable code. Stack traces never leave the process in production.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Our own typed errors already know what they are.
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err, url: req.originalUrl }, err.message)
    else logger.debug({ code: err.code, url: req.originalUrl }, err.message)
    return fail(res, err.statusCode, err.code, err.message, err.details)
  }

  if (err instanceof ZodError) {
    return fail(
      res,
      422,
      'VALIDATION_ERROR',
      'Validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }

  if (err instanceof MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR'
    return fail(res, 400, code, err.message)
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field'
        return fail(res, 409, 'DUPLICATE_VALUE', `That ${target} is already in use`)
      }
      case 'P2025':
        return fail(res, 404, 'NOT_FOUND', 'Record not found')
      case 'P2003':
        return fail(res, 409, 'FOREIGN_KEY_CONSTRAINT', 'Related record is missing or still in use')
      default:
        logger.error({ err }, 'Prisma known request error')
        return fail(res, 400, 'DATABASE_ERROR', 'The request could not be completed')
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.error({ err }, 'Prisma validation error')
    return fail(res, 400, 'DATABASE_ERROR', 'The request could not be completed')
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON')
  }

  // Anything unrecognised is a bug: log it fully, tell the client nothing.
  logger.error({ err, url: req.originalUrl }, 'Unhandled error')
  return fail(
    res,
    500,
    'INTERNAL_ERROR',
    isProduction ? 'Something went wrong' : (err as Error)?.message ?? 'Something went wrong',
  )
}
