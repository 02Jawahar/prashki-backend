import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { authLimiter } from '../../middleware/rate-limit.js'
import { changePasswordSchema, loginSchema, registerSchema } from './auth.schemas.js'
import {
  changePasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
} from './auth.controller.js'

export const authRouter: Router = Router()

// Credential endpoints carry the tight rate limit (spec §48).
authRouter.post('/register', authLimiter, validate({ body: registerSchema }), registerHandler)
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), loginHandler)
authRouter.post('/refresh', refreshHandler)
authRouter.post('/logout', logoutHandler)

authRouter.get('/me', requireAuth, meHandler)
authRouter.post(
  '/change-password',
  authLimiter,
  requireAuth,
  validate({ body: changePasswordSchema }),
  changePasswordHandler,
)
