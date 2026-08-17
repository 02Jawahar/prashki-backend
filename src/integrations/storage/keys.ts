import crypto from 'node:crypto'
import path from 'node:path'

/**
 * How a stored object is named, shared by every provider.
 *
 * Shared deliberately: if local disk and S3 named files differently, moving
 * between them would change the shape of every URL, and the two would be
 * impossible to compare when diagnosing a problem. The name is decided here
 * once and the providers only decide where to put it.
 */

/** Folder names are an allow-list at the route; this is the second line. */
export function sanitiseSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'misc'
}

/**
 * A stable, safe, unique name derived from what the customer uploaded.
 *
 * The original stem is kept so a file is still recognisable in a bucket
 * listing, but six random bytes are appended: two people uploading `image.jpg`
 * must not collide, and a guessable name would let anyone enumerate the
 * bucket by trying likely filenames.
 */
export function uniqueName(original: string): string {
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)
  const stem = path
    .basename(original, path.extname(original))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  return `${stem || 'file'}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`
}

/** `products/amaira-dress-a3f9c2e81b04.jpg` */
export function buildKey(folder: string, filename: string): string {
  return `${sanitiseSegment(folder)}/${uniqueName(filename)}`
}
