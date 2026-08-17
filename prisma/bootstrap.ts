/**
 * First-run setup for a real store.
 *
 * The seed builds a demo shop and wipes whatever was there first, which is
 * exactly wrong for production. This creates only what an empty store cannot
 * work without:
 *
 *   - the permission catalogue and the six default roles
 *   - store settings, if none exist
 *   - one Super Admin, if there are no users at all
 *
 * It adds no products, no customers and no demo content, it deletes nothing,
 * and it is safe to run twice. Running it against a database that already has
 * users leaves the users alone and only fills in anything missing.
 *
 *   npm run db:bootstrap
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { env } from '../src/config/env.js'
import { PERMISSIONS, ROLES, DEFAULT_SETTINGS, MESSAGE_TEMPLATES } from './seed-data.js'

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })

/**
 * Upserts the permission catalogue.
 *
 * Permissions are the vocabulary the code is written against, so a deploy that
 * adds a new `requirePermission(...)` needs the row to exist before that route
 * is reachable. Running this after every deploy is the intended use.
 */
async function syncPermissions(): Promise<number> {
  let added = 0

  for (const permission of PERMISSIONS) {
    const result = await prisma.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: { group: permission.group, label: permission.label },
    })
    if (result) added++
  }

  return added
}

/**
 * Creates any missing default role and grants it its permissions.
 *
 * An existing role is left alone apart from Super Admin, which is topped up so
 * that a deploy adding a new permission does not quietly leave the escape
 * hatch without it.
 */
async function syncRoles(): Promise<{ created: number; updated: number }> {
  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } })
  const permissionId = new Map(permissions.map((p) => [p.key, p.id]))

  let created = 0
  let updated = 0

  for (const role of ROLES) {
    const existing = await prisma.role.findUnique({
      where: { key: role.key },
      include: { permissions: { include: { permission: true } } },
    })

    if (!existing) {
      await prisma.role.create({
        data: {
          key: role.key,
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: {
            create: role.permissions
              .filter((key) => permissionId.has(key))
              .map((key) => ({ permissionId: permissionId.get(key)! })),
          },
        },
      })
      created++
      continue
    }

    if (role.key !== 'SUPER_ADMIN') continue

    // Super Admin must hold everything, including permissions added by a
    // later deploy — otherwise the one role that can fix things cannot.
    const held = new Set(existing.permissions.map((rp) => rp.permission.key))
    const missing = role.permissions.filter((key) => !held.has(key) && permissionId.has(key))

    if (missing.length > 0) {
      await prisma.rolePermission.createMany({
        data: missing.map((key) => ({ roleId: existing.id, permissionId: permissionId.get(key)! })),
        skipDuplicates: true,
      })
      updated++
    }
  }

  return { created, updated }
}

/**
 * Creates any message template the store does not have yet.
 *
 * Not demo data. `sendMessage` looks the template up by (key, channel) and
 * returns without sending if there is none — so a store with correct SMTP
 * credentials still delivers nothing, and the delivery log stays empty
 * because a message that was never attempted has nothing to log. That is
 * exactly how it failed in production: `SMTP ready` at boot, and every
 * invitation answered with "No active message template".
 *
 * Existing rows are never touched. Once an admin has edited the wording, that
 * is the store's copy and a later deploy must not overwrite it.
 */
async function syncTemplates(): Promise<number> {
  let added = 0

  for (const template of MESSAGE_TEMPLATES) {
    const existing = await prisma.messageTemplate.findUnique({
      where: { key_channel: { key: template.key, channel: template.channel } },
    })
    if (existing) continue

    await prisma.messageTemplate.create({
      data: {
        key: template.key,
        channel: template.channel,
        name: template.name,
        subject: template.subject ?? null,
        body: template.body,
        variables: template.variables,
        isActive: true,
      },
    })
    added++
  }

  return added
}

async function syncSettings(): Promise<number> {
  let added = 0

  for (const setting of DEFAULT_SETTINGS) {
    const existing = await prisma.setting.findUnique({ where: { key: setting.key } })
    if (existing) continue

    // Only the row is created; an existing value is never overwritten, because
    // by the second run it is the store's own configuration.
    await prisma.setting.create({ data: setting as Prisma.SettingCreateInput })
    added++
  }

  return added
}

/**
 * Creates the first admin, and only ever the first.
 *
 * Guarded on there being no users at all rather than no admins: a store with
 * customers but no admin is a situation to investigate, not to silently add a
 * privileged account to from an environment variable.
 */
async function createFirstAdmin(): Promise<'created' | 'skipped'> {
  const users = await prisma.user.count()
  if (users > 0) return 'skipped'

  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } })

  await prisma.user.create({
    data: {
      name: 'Store Admin',
      email: env.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await hash(env.ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
      roles: { create: { roleId: superAdmin.id } },
    },
  })

  return 'created'
}

async function main() {
  console.log('Bootstrapping...\n')

  const permissions = await syncPermissions()
  console.log(`  ${permissions} permissions in the catalogue`)

  const roles = await syncRoles()
  console.log(
    `  ${roles.created} roles created${roles.updated > 0 ? `, Super Admin topped up` : ''}`,
  )

  const templates = await syncTemplates()
  console.log(`  ${templates} message templates added${templates === 0 ? ' (already present)' : ''}`)

  const settings = await syncSettings()
  console.log(`  ${settings} settings added${settings === 0 ? ' (already configured)' : ''}`)

  const admin = await createFirstAdmin()

  if (admin === 'created') {
    console.log(`  admin created: ${env.ADMIN_EMAIL}`)
    console.log('\n  Sign in and change that password now — it came from an environment variable.')
  } else {
    console.log('  admin: skipped, the database already has users')
  }

  console.log('\nDone. No data was deleted.\n')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
