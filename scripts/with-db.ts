/**
 * Runs a one-shot database command with the dev database guaranteed to be up.
 *
 *   tsx scripts/with-db.ts prisma db push
 *   tsx scripts/with-db.ts tsx prisma/seed.ts
 *
 * Resolves which port our cluster is actually on (starting it if needed) and
 * passes that URL down as DATABASE_URL, so every CLI command talks to the same
 * database the API does.
 *
 * The database is deliberately left running afterwards — see the note in
 * src/server.ts. `npm run db:stop` shuts it down.
 */
import { spawn } from 'node:child_process'
import { ensureDatabase } from '../src/config/embedded-db.js'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: tsx scripts/with-db.ts <bin> [...args]')
  process.exit(1)
}

const db = await ensureDatabase()

const [command, ...args] = argv
const child = spawn(command!, args, {
  stdio: 'inherit',
  // npm puts node_modules/.bin on PATH for scripts, so bare tool names resolve.
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: db.url },
})

let done = false
const shutdown = (code: number) => {
  if (done) return
  done = true
  process.exit(code)
}

child.on('exit', (code) => shutdown(code ?? 0))
child.on('error', (err) => {
  console.error(err)
  shutdown(1)
})
process.on('SIGINT', () => shutdown(130))
