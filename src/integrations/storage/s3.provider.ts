import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { buildKey } from './keys.js'
import type { PutFileInput, StorageProvider, StoredFile } from './storage.types.js'

/**
 * Object storage over the S3 API.
 *
 * Covers Garage, MinIO, Cloudflare R2 and AWS S3 itself — they speak the same
 * protocol, so the provider is one implementation and the difference is four
 * environment variables.
 *
 * Uploads go through the S3 API on the private network; reads do not come back
 * through here at all. A customer's browser fetches the image straight from
 * `STORAGE_PUBLIC_URL`, so product images never occupy a Node process, which
 * is the main reason to move off local disk in the first place.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3'

  private client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY!,
      secretAccessKey: env.S3_SECRET_KEY!,
    },
    /**
     * Path-style addressing: `endpoint/bucket/key` rather than
     * `bucket.endpoint/key`.
     *
     * Virtual-host addressing needs a wildcard DNS record for the bucket
     * subdomain, which a self-hosted Garage or MinIO behind a single hostname
     * does not have. Without this, every upload fails to resolve a host that
     * was never created — and the error names DNS rather than configuration,
     * which sends you looking in the wrong place.
     */
    forcePathStyle: true,
  })

  /**
   * The public URL for a key.
   *
   * Built from `STORAGE_PUBLIC_URL`, not from the S3 endpoint: reads and
   * writes go to different places. Writes use the internal API; reads come
   * from whatever host actually serves the bucket to the public — for Garage
   * that is its web endpoint on a separate port and domain.
   */
  urlFor(key: string): string {
    return `${env.STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${key}`
  }

  async put({ folder, filename, contentType, body }: PutFileInput): Promise<StoredFile> {
    const key = buildKey(folder, filename)

    await this.client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        /**
         * Without this the object is served as application/octet-stream and
         * browsers download it instead of rendering it — a product page full
         * of broken images and a download prompt per photo.
         */
        ContentType: contentType,
        /**
         * A year, because the filename carries six random bytes: the content
         * at a given key never changes, so there is nothing to revalidate.
         * Replacing an image produces a new key and therefore a new URL.
         */
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )

    return { key, url: this.urlFor(key), size: body.byteLength, contentType }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      )
    } catch (err) {
      /**
       * Swallowed like the local provider's. A delete is housekeeping — an
       * object that cannot be removed leaves a few kilobytes behind, which is
       * not worth failing the request that triggered it. It is logged so the
       * orphan is at least visible.
       */
      logger.warn({ err, key, bucket: env.S3_BUCKET }, 'S3 delete failed')
    }
  }
}
