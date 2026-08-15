import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { LocalStorageProvider } from './local.provider.js'
import type { StorageProvider } from './storage.types.js'

export type { StorageProvider, StoredFile, PutFileInput } from './storage.types.js'

/**
 * S3 and R2 are API-compatible, so one provider covers both — it needs only an
 * endpoint and credentials. Left unimplemented deliberately: shipping an
 * untested S3 path would be worse than a clear error at boot.
 */
class UnimplementedProvider implements StorageProvider {
  constructor(readonly name: string) {}
  private fail(): never {
    throw new Error(
      `STORAGE_PROVIDER=${this.name} is declared but not implemented yet. ` +
        `Implement it against the StorageProvider interface, or set STORAGE_PROVIDER=local.`,
    )
  }
  put(): never {
    this.fail()
  }
  delete(): never {
    this.fail()
  }
  urlFor(): never {
    this.fail()
  }
}

let provider: StorageProvider | null = null

export function getStorage(): StorageProvider {
  if (provider) return provider

  switch (env.STORAGE_PROVIDER) {
    case 'local':
      provider = new LocalStorageProvider()
      break
    case 's3':
    case 'r2':
      provider = new UnimplementedProvider(env.STORAGE_PROVIDER)
      break
    default:
      provider = new LocalStorageProvider()
  }

  logger.debug(`Storage provider: ${provider.name}`)
  return provider
}
