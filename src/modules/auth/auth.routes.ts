import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { authLimiter } from '../../middleware/rate-limit.js'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schemas.js'
import {
  changePasswordHandler,
  forgotPasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
  resetPasswordHandler,
  updateProfileHandler,
} from './auth.controller.js'

export const authRouter: Router = Router()

// Credential endpoints carry the tight rate limit (spec §48).
authRouter.post('/register', authLimiter, validate({ body: registerSchema }), registerHandler)
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), loginHandler)
authRouter.post('/refresh', refreshHandler)
authRouter.post('/logout', logoutHandler)

/**
 * Password reset. Both halves are rate limited: the request half because it
 * sends email on someone else's behalf, the completion half because a token is
 * being guessed at. `skipSuccessfulRequests` on the limiter means a legitimate
 * user is never locked out by their own successful reset.
 */
authRouter.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  forgotPasswordHandler,
)
authRouter.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  resetPasswordHandler,
)

authRouter.get('/me', requireAuth, meHandler)
authRouter.patch(
  '/profile',
  requireAuth,
  validate({ body: updateProfileSchema }),
  updateProfileHandler,
)
authRouter.post(
  '/change-password',
  authLimiter,
  requireAuth,
  validate({ body: changePasswordSchema }),
  changePasswordHandler,
)
