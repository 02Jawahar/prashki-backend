/**
 * Embedded PostgreSQL for Docker-less local development.
 *
 * The development machine has no PostgreSQL install and no Docker, so in
 * development the API starts a real PostgreSQL server out of node_modules with
 * its cluster in `.pgdata/`. Prisma cannot tell the difference.
 *
 * Port discovery matters here. This machine runs other PostgreSQL servers that
 * claim ports unpredictably (5432, 5433 and 5434 have each been taken by a
 * foreign server at some point). Trusting a fixed port produced the worst
 * failure mode: a port that answers, but not with *our* database. So we:
 *
 *   1. reuse our own cluster if it is already running (read postmaster.pid),
 *   2. otherwise take the first genuinely free port from a candidate list,
 *   3. and expose the resolved URL, rather than assuming the configured one.
 *
 * None of this runs in production, where DATABASE_URL is authoritative.
 */
import net from 'node:net'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env, isProduction } from './env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// src/config -> repository root
const REPO_ROOT = path.resolve(here, '..', '..')

/**
 * Overridable because PostgreSQL derives its shared-memory key from this path
 * on Windows. If a hard-killed server leaves an orphan holding that block,
 * pointing at a fresh directory is the way out (see the error below).
 */
export const DATA_DIR = path.resolve(REPO_ROOT, process.env.PG_DATA_DIR ?? '.pgdata')

const PG = {
  host: '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
  database: process.env.PG_DATABASE ?? 'ecommerce',
}

/** How many ports to try before giving up. */
const PORT_CANDIDATES = 8

export function urlForPort(port: number): string {
  return `postgresql://${PG.user}:${PG.password}@${PG.host}:${port}/${PG.database}?schema=public`
}

function portInUse(port: number, host = PG.host, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/**
 * Is the server on this port *ours*?
 *
 * File-based detection (postmaster.pid) proved unreliable: a hard-killed
 * postmaster can leave the port bound but the pid file gone. The only
 * trustworthy test is whether the thing listening accepts our credentials and
 * has our database — so we ask it.
 */
async function isOurDatabase(url: string): Promise<boolean> {
  const { PrismaClient } = await import('@prisma/client')

  const client = new PrismaClient({
    datasources: { db: { url: `${url}&connect_timeout=3` } },
    log: [],
  })

  try {
    await client.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  } finally {
    await client.$disconnect().catch(() => undefined)
  }
}

export interface DatabaseHandle {
  /** The URL that actually works — may differ from the configured one. */
  url: string
  /** true only if we started the server and are therefore responsible for it */
  started: boolean
  stop: () => Promise<void>
}

async function startEmbedded(port: number): Promise<DatabaseHandle> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: PG.user,
    password: PG.password,
    port,
    persistent: true,
    // initdb on Windows otherwise inherits WIN1252 from the system locale.
    initdbFlags: ['-E', 'UTF8'],
    onLog: process.env.PG_VERBOSE === '1' ? (m: string) => process.stdout.write(m) : () => {},
    onError: () => {},
  } as ConstructorParameters<typeof EmbeddedPostgres>[0])

  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    console.log('  initialising embedded PostgreSQL cluster (first run only)...')
    await pg.initialise()
  }

  try {
    await pg.start()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // A postmaster that was killed rather than shut down can leave its shared
    // memory segment behind. PostgreSQL then refuses to start against the same
    // data directory, and the fix is not obvious from the raw error.
    if (/pre-existing shared memory block/i.test(message)) {
      throw new Error(
        `The embedded PostgreSQL cannot start: an orphaned server still holds the shared memory\n` +
          `  for ${DATA_DIR}.\n\n` +
          `  Fix it with either:\n` +
          `    1. Kill the leftover postgres processes, delete that folder, then run\n` +
          `       npm run db:push && npm run db:seed\n` +
          `    2. Or if they cannot be killed (another Windows account owns them),\n` +
          `       set PG_DATA_DIR to a new folder name in backend/.env and re-run setup.`,
      )
    }
    throw err
  }

  try {
    await pg.createDatabase(PG.database)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(message)) throw err
  }

  console.log(`  embedded postgres ready on ${PG.host}:${port}/${PG.database}`)

  return {
    url: urlForPort(port),
    started: true,
    stop: async () => {
      try {
        await pg.stop()
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * Resolves a working database, starting one if needed.
 * Returns the URL to use — callers must prefer it over env.DATABASE_URL.
 */
export async function ensureDatabase(): Promise<DatabaseHandle> {
  if (isProduction) {
    return { url: env.DATABASE_URL, started: false, stop: async () => {} }
  }

  for (let i = 0; i < PORT_CANDIDATES; i++) {
    const port = PG.port + i
    const url = urlForPort(port)

    if (await portInUse(port)) {
      // Something is here. If it answers as our database — a previous dev
      // server, or a postmaster that outlived a hard kill — reuse it rather
      // than fighting it for the data directory.
      if (await isOurDatabase(url)) {
        console.log(`  reusing existing postgres on ${PG.host}:${port}/${PG.database}`)
        return { url, started: false, stop: async () => {} }
      }
      console.log(`  port ${port} belongs to a different server — trying the next one`)
      continue
    }

    return startEmbedded(port)
  }

  throw new Error(
    `No free port for the embedded database in ${PG.port}–${PG.port + PORT_CANDIDATES - 1}. ` +
      `Set PG_PORT to a free port, or point DATABASE_URL at your own PostgreSQL.`,
  )
}

/**
 * Blocks until the database actually answers a query.
 *
 * An open TCP port is not the same as a working database, so the API refuses to
 * start listening until a real query succeeds — a loud failure beats a stream
 * of 500s from a server that looks healthy.
 */
export async function waitForDatabase(
  ping: () => Promise<unknown>,
  { attempts = 20, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  let lastError: unknown

  for (let i = 1; i <= attempts; i++) {
    try {
      await ping()
      return
    } catch (err) {
      lastError = err
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.message.split('\n').filter(Boolean).slice(0, 2).join(' ')
      : String(lastError)

  throw new Error(`Database unreachable after ${attempts} attempts.\n  ${detail}`)
}
