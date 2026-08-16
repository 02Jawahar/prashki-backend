import type { Request, Response } from 'express'
import { prisma } from '../../config/db.js'
import { ok, created } from '../../utils/response.js'
import { AuthenticationError } from '../../utils/errors.js'
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../../utils/tokens.js'
import * as authService from './auth.service.js'
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './auth.schemas.js'
import { mergeGuestCart } from '../cart/cart.service.js'

export async function registerHandler(req: Request, res: Response) {
  const input = req.validated!.body as RegisterInput
  const { user, tokens } = await authService.register(input, req)

  setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.role)
  // A guest may have been building a cart before signing up (spec §36).
  await mergeGuestCart(req, user.id)

  return created(res, { user })
}

export async function loginHandler(req: Request, res: Response) {
  const input = req.validated!.body as LoginInput
  const { user, tokens } = await authService.login(input, req)

  setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.role)
  await mergeGuestCart(req, user.id)

  return ok(res, { user })
}

export async function refreshHandler(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE]
  if (!token) throw new AuthenticationError('No session to refresh', 'NO_REFRESH_TOKEN')

  try {
    const { user, tokens } = await authService.refresh(token, req)
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.role)
    return ok(res, { user })
  } catch (err) {
    // A refresh that fails is a dead session — don't leave stale cookies behind.
    clearAuthCookies(res)
    throw err
  }
}

export async function logoutHandler(req: Request, res: Response) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE])
  clearAuthCookies(res)
  return ok(res, { loggedOut: true })
}

export async function meHandler(req: Request, res: Response) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
  return ok(res, { user: authService.toPublicUser(user, [...req.user!.permissions]) })
}

export async function changePasswordHandler(req: Request, res: Response) {
  const input = req.validated!.body as ChangePasswordInput
  await authService.changePassword(req.user!.id, input.currentPassword, input.newPassword, req)

  clearAuthCookies(res)
  return ok(res, { passwordChanged: true })
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  const { email } = req.validated!.body as ForgotPasswordInput
  await authService.requestPasswordReset(email, req)

  // Always the same answer — see the service for why.
  return ok(res, {
    requested: true,
    message: 'If that email has an account, a reset link is on its way.',
  })
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const input = req.validated!.body as ResetPasswordInput
  await authService.resetPassword(input.token, input.password, req)

  // Every session was revoked, so any cookies this browser holds are now dead.
  clearAuthCookies(res)
  return ok(res, { passwordReset: true })
}

export async function updateProfileHandler(req: Request, res: Response) {
  const input = req.validated!.body as UpdateProfileInput
  const user = await authService.updateProfile(req.user!.id, input, req)
  return ok(res, { user })
}
