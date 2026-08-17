import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { LocalStorageProvider } from './local.provider.js'
import { S3StorageProvider } from './s3.provider.js'
import type { StorageProvider } from './storage.types.js'

export type { StorageProvider, StoredFile, PutFileInput } from './storage.types.js'

let provider: StorageProvider | null = null

export function getStorage(): StorageProvider {
  if (provider) return provider

  switch (env.STORAGE_PROVIDER) {
    /**
     * S3 and R2 are the same protocol, and Garage and MinIO implement it too,
     * so one provider covers all of them. Which one you are talking to is four
     * environment variables, not four code paths.
     */
    case 's3':
    case 'r2':
      provider = new S3StorageProvider()
      logger.info(
        { endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, publicUrl: env.STORAGE_PUBLIC_URL },
        'Storage: S3-compatible',
      )
      break

    case 'local':
    default:
      provider = new LocalStorageProvider()
      logger.info({ dir: env.STORAGE_LOCAL_DIR }, 'Storage: local disk')
      break
  }

  return provider
}
