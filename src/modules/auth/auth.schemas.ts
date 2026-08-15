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
})

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
