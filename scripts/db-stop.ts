/**
 * Shuts the embedded PostgreSQL down cleanly.
 *
 * The API deliberately leaves the database running between restarts, so this is
 * the supported way to stop it. Always prefer this over killing the process —
 * a postmaster that is killed rather than shut down leaves its socket bound and
 * its shared-memory block held, which blocks the next start.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DATA_DIR } from '../src/config/embedded-db.js'

if (!existsSync(DATA_DIR)) {
  console.log(`No cluster at ${DATA_DIR} — nothing to stop.`)
  process.exit(0)
}

const require = createRequire(import.meta.url)

/** pg_ctl ships inside the embedded-postgres platform package. */
function pgCtlPath(): string | null {
  for (const pkg of [
    '@embedded-postgres/windows-x64',
    '@embedded-postgres/linux-x64',
    '@embedded-postgres/darwin-arm64',
    '@embedded-postgres/darwin-x64',
  ]) {
    try {
      const dir = path.dirname(require.resolve(`${pkg}/package.json`))
      const bin = path.join(dir, 'native', 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')
      if (existsSync(bin)) return bin
    } catch {
      /* not this platform */
    }
  }
  return null
}

const pgCtl = pgCtlPath()
if (!pgCtl) {
  console.error('Could not locate pg_ctl. Is embedded-postgres installed?')
  process.exit(1)
}

// "fast" closes client connections and shuts down without waiting them out.
const result = spawnSync(pgCtl, ['-D', DATA_DIR, '-m', 'fast', 'stop'], { stdio: 'inherit' })

if (result.status === 0) {
  console.log('Database stopped.')
} else {
  console.log('Database was not running (or was already stopped).')
}
