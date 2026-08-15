import { PrismaClient } from '@prisma/client'
import { env, isProduction } from './env.js'

/**
 * Prisma client, created lazily.
 *
 * Lazily because in development the database URL is not known until
 * `ensureDatabase()` has resolved which port our cluster actually landed on
 * (this machine has other PostgreSQL servers that take ports unpredictably).
 * ES module imports are hoisted, so a client constructed at module scope would
 * capture the configured URL before that resolution happens.
 *
 * Call sites still just `import { prisma }` — the proxy below defers
 * construction to the first property access.
 */
let client: PrismaClient | null = null
let resolvedUrl: string | null = null

/** Called by the bootstrap once the real URL is known. */
export function setDatabaseUrl(url: string): void {
  if (client) throw new Error('setDatabaseUrl must be called before the client is used')
  resolvedUrl = url
}

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({
    datasources: { db: { url: resolvedUrl ?? env.DATABASE_URL } },
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })
  return client
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const instance = getPrisma()
    const value = Reflect.get(instance as object, property, receiver)
    return typeof value === 'function' ? value.bind(instance) : value
  },
  has(_target, property) {
    return Reflect.has(getPrisma() as object, property)
  },
})

if (!isProduction) {
  // tsx watch restarts the process on change, so there is no client to reuse
  // across reloads — nothing to cache on globalThis.
}
