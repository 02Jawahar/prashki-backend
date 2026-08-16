import { z } from 'zod'

/**
 * Password policy: length is the property that actually resists guessing, so
 * we require real length rather than a maze of character-class rules.
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long')

const email = z.string().trim().toLowerCase().email('Enter a valid email address')

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  email,
  password,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('')),

  /**
   * Consent capture (FR-05.1).
   *
   * Accepting the terms is required — you cannot hold an account without
   * agreeing to them. Marketing is separate and defaults to false: consent
   * that was never actively given is not consent, and a pre-ticked box is
   * exactly what the DPDP Act is written against.
   */
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'Please accept the terms to create an account' }),
  }),
  marketingOptIn: z.boolean().default(false),
  /** The policy version shown at the time, so the record stays meaningful. */
  policyVersion: z.string().trim().max(40).optional(),
})

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
})

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20, 'That reset link is invalid or has expired'),
  password,
})

/**
 * Email is absent on purpose — changing the address that identifies an account
 * needs a verification round-trip, not a profile PATCH.
 */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(120).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number')
      .or(z.literal(''))
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
