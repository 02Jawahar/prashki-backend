import multer from 'multer'
import { ValidationError } from '../utils/errors.js'

/**
 * Upload constraints (spec §48).
 *
 * Files are held in memory and handed to the storage provider — nothing is
 * written to disk by multer, so there is no temp-file cleanup and no path the
 * client can influence. The MIME allow-list is a filter, not a guarantee, which
 * is why the storage provider also generates its own filenames.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_FILES = 8

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new ValidationError(`Unsupported image type: ${file.mimetype}. Use JPEG, PNG, WebP or AVIF.`))
      return
    }
    cb(null, true)
  },
})

export const uploadLimits = { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, allowed: [...ALLOWED] }

/**
 * Site media — hero and banner artwork, which may be video.
 *
 * Video gets a much larger ceiling than product photography, so it has its own
 * uploader rather than loosening the product limits. Still memory-backed: at
 * 40 MB that is acceptable for an admin-only endpoint, and it keeps the
 * "filenames are generated, nothing touches disk directly" property. Move to
 * streaming uploads if this ever needs to accept large video routinely.
 */
const MAX_MEDIA_BYTES = 40 * 1024 * 1024 // 40 MB

const ALLOWED_MEDIA = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
])

export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MEDIA.has(file.mimetype)) {
      cb(
        new ValidationError(
          `Unsupported file type: ${file.mimetype}. Use JPEG, PNG, WebP, AVIF, GIF, SVG, MP4 or WebM.`,
        ),
      )
      return
    }
    cb(null, true)
  },
})

export const mediaLimits = {
  maxFileBytes: MAX_MEDIA_BYTES,
  allowed: [...ALLOWED_MEDIA],
}
