import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import type { PutFileInput, StorageProvider, StoredFile } from './storage.types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..', env.STORAGE_LOCAL_DIR)

/** Filesystem-backed storage for local development. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local'

  urlFor(key: string): string {
    return `${env.STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${key}`
  }

  async put({ folder, filename, contentType, body }: PutFileInput): Promise<StoredFile> {
    const safeFolder = sanitiseSegment(folder)
    const key = `${safeFolder}/${uniqueName(filename)}`
    const target = path.join(ROOT, key)

    // Defence in depth: a crafted filename must never escape the storage root.
    if (!target.startsWith(ROOT)) throw new Error('Resolved path escapes the storage root')

    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)

    return { key, url: this.urlFor(key), size: body.byteLength, contentType }
  }

  async delete(key: string): Promise<void> {
    const target = path.join(ROOT, key)
    if (!target.startsWith(ROOT)) throw new Error('Resolved path escapes the storage root')

    try {
      await unlink(target)
    } catch (err) {
      // Deleting an already-absent file is not an error worth failing a request for.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, key }, 'Local storage delete failed')
      }
    }
  }
}

function sanitiseSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'misc'
}

function uniqueName(original: string): string {
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)
  const stem = path
    .basename(original, path.extname(original))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  return `${stem || 'file'}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`
}
