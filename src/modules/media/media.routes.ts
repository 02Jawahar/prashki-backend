import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../../middleware/auth.js'
import { mediaUpload, mediaLimits } from '../../middleware/upload.js'
import { writeLimiter } from '../../middleware/rate-limit.js'
import { created, noContent, ok } from '../../utils/response.js'
import { ValidationError } from '../../utils/errors.js'
import { recordAudit } from '../../utils/audit.js'
import { getStorage } from '../../integrations/storage/index.js'

/**
 * Site media (hero artwork, banners, category imagery).
 *
 * Separate from product images because it is not tied to a product row — the
 * caller gets a URL back and decides where to store it, which for homepage
 * sections is the `home.sections` setting.
 *
 * Everything still goes through the StorageProvider, so filenames are generated
 * server-side and moving to S3/R2 changes nothing here.
 */
export const adminMediaRouter: Router = Router()

/** Folders are an allow-list — the client cannot invent a path. */
const FOLDERS = ['home', 'banners', 'categories', 'misc'] as const

const uploadSchema = z.object({
  folder: z.enum(FOLDERS).default('home'),
})

adminMediaRouter.get('/limits', requirePermission('media.upload'), (_req, res) =>
  ok(res, { ...mediaLimits, folders: FOLDERS }),
)

adminMediaRouter.post(
  '/',
  writeLimiter,
  requirePermission('media.upload'),
  mediaUpload.single('file'),
  async (req, res) => {
    const file = req.file
    if (!file) throw new ValidationError('No file was uploaded')

    // multer parses the multipart body, so validate the text field afterwards.
    const parsed = uploadSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      throw new ValidationError('Invalid folder', parsed.error.issues)
    }

    const stored = await getStorage().put({
      folder: parsed.data.folder,
      filename: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    })

    recordAudit({
      action: 'MEDIA_UPLOADED',
      entityType: 'Media',
      entityId: stored.key,
      metadata: { folder: parsed.data.folder, size: stored.size, contentType: stored.contentType },
      req,
    })

    return created(res, {
      url: stored.url,
      key: stored.key,
      size: stored.size,
      contentType: stored.contentType,
      kind: file.mimetype.startsWith('video/') ? 'video' : 'image',
    })
  },
)

const deleteSchema = z.object({ key: z.string().trim().min(1).max(300) })

adminMediaRouter.delete(
  '/',
  writeLimiter,
  requirePermission('media.upload'),
  async (req, res) => {
    const parsed = deleteSchema.safeParse(req.query)
    if (!parsed.success) throw new ValidationError('A storage key is required')

    // The provider rejects any key that escapes the storage root.
    await getStorage().delete(parsed.data.key)

    recordAudit({ action: 'MEDIA_DELETED', entityType: 'Media', entityId: parsed.data.key, req })
    return noContent(res)
  },
)
