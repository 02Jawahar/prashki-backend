/**
 * Typed application errors.
 *
 * Every error carries a stable machine-readable `code` (spec §46) so the
 * frontend can branch on it without string-matching human messages.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
    Error.captureStackTrace?.(this, new.target)
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(422, 'VALIDATION_ERROR', message, details)
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(401, code, message)
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to do that', details?: unknown) {
    super(403, 'FORBIDDEN', message, details)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super(404, code, `${resource} not found`)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message)
  }
}

export class PaymentError extends AppError {
  constructor(message: string, code = 'PAYMENT_ERROR') {
    super(402, code, message)
  }
}

export class IntegrationError extends AppError {
  constructor(message: string, code = 'INTEGRATION_ERROR') {
    super(502, code, message)
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please slow down') {
    super(429, 'RATE_LIMITED', message)
  }
}
