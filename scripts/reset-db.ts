/**
 * Deletes the local cluster and rebuilds it from schema + seed.
 * Development only — this destroys every row.
 */
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { DATA_DIR } from '../src/config/embedded-db.js'

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database with NODE_ENV=production')
  process.exit(1)
}

console.log(`Removing cluster at ${DATA_DIR} ...`)
await rm(DATA_DIR, { recursive: true, force: true })

const run = (args: string[]) => {
  const r = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run(['run', 'db:push'])
run(['run', 'db:seed'])
console.log('Database reset complete.')
