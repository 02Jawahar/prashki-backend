/**
 * Storage abstraction (spec §12).
 *
 * Product logic only ever sees this interface, so moving from local disk to S3
 * or R2 is a provider swap and an env change — no changes to product code.
 */
export interface StoredFile {
  /** Provider-relative key, e.g. "products/abc123.jpg". Persist this. */
  key: string
  /** Absolute URL a browser can fetch. Derived from the key. */
  url: string
  size: number
  contentType: string
}

export interface PutFileInput {
  /** Directory-ish prefix within the bucket, e.g. "products". */
  folder: string
  filename: string
  contentType: string
  body: Buffer
}

export interface StorageProvider {
  readonly name: string
  put(input: PutFileInput): Promise<StoredFile>
  delete(key: string): Promise<void>
  /** Turns a stored key back into a public URL. */
  urlFor(key: string): string
}
