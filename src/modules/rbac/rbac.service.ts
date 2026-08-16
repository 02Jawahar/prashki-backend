import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/db.js'
import { AuthorizationError, ConflictError, ValidationError } from '../../utils/errors.js'

/**
 * Role and staff administration (FR-24.1, M10).
 *
 * Roles are data, not code: an admin holding `role.manage` can create roles
 * and re-grant any permission at runtime. `isSystem` only stops a seeded role
 * being deleted — its grants remain editable, with one exception noted below.
 *
 * Three invariants protect this from being the thing that breaks the store.
 * They are enforced here rather than in the routes so no future endpoint can
 * skip them.
 */

/**
 * The permissions that can rebuild access after a mistake. A store that loses
 * every holder of these is locked out of its own admin panel with no recovery
 * short of a database console.
 */
export const RECOVERY_PERMISSIONS = ['role.manage', 'user.manage'] as const

/**
 * SUPER_ADMIN is the escape hatch, so it always holds everything. Editing its
 * grants is the one operation that could strand a store, and no legitimate
 * workflow needs it — make a narrower role instead.
 */
export const LOCKED_ROLE_KEY = 'SUPER_ADMIN'

export async function permissionCatalogue() {
  const permissions = await prisma.permission.findMany({
    orderBy: [{ group: 'asc' }, { key: 'asc' }],
  })

  // Grouped for the matrix editor; the flat list is what the API validates against.
  const groups = new Map<string, typeof permissions>()
  for (const permission of permissions) {
    groups.set(permission.group, [...(groups.get(permission.group) ?? []), permission])
  }

  return {
    permissions,
    groups: [...groups].map(([group, items]) => ({ group, permissions: items })),
  }
}

export const roleInclude = {
  permissions: { include: { permission: true } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleInclude

type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>

export function serializeRole(role: RoleRow) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    isLocked: role.key === LOCKED_ROLE_KEY,
    userCount: role._count.users,
    permissions: role.permissions.map((rp) => rp.permission.key).sort(),
  }
}

/**
 * Invariant 1 — no privilege escalation.
 *
 * You cannot grant a capability you do not hold yourself. Without this, one
 * narrow permission (`role.manage`) is enough to award yourself every other
 * one, which makes least-privilege decorative.
 */
export function assertCanGrant(granting: string[], actorPermissions: Set<string>): void {
  const beyond = granting.filter((key) => !actorPermissions.has(key))
  if (beyond.length > 0) {
    throw new AuthorizationError(
      'You cannot grant a permission you do not hold yourself',
      { permissions: beyond.sort() },
    )
  }
}

/**
 * Invariant 2 — no lockout.
 *
 * Run inside the same transaction as the change, after it has been applied,
 * so the check sees the world the change actually creates. If nobody is left
 * who can manage roles and staff, the transaction is rolled back.
 */
export async function assertRecoveryPathSurvives(tx: Prisma.TransactionClient): Promise<void> {
  for (const permission of RECOVERY_PERMISSIONS) {
    const holders = await tx.user.count({
      where: {
        role: 'ADMIN',
        status: 'ACTIVE',
        roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
      },
    })

    if (holders === 0) {
      throw new ConflictError(
        `That would leave nobody able to ${permission === 'role.manage' ? 'manage roles' : 'manage staff'}. Grant it to someone else first.`,
        'RBAC_LOCKOUT',
      )
    }
  }
}

/**
 * Invariant 3 — you cannot strand yourself.
 *
 * Distinct from the lockout check: another admin might still hold the keys,
 * but silently removing your own access mid-session is never what was meant.
 */
export function assertNotSelf(actorId: string, targetId: string, action: string): void {
  if (actorId === targetId) {
    throw new ValidationError(`You cannot ${action} your own account`)
  }
}

/** Resolves role ids to keys, refusing any that does not exist. */
export async function resolveRoles(roleIds: string[]) {
  if (roleIds.length === 0) return []

  const roles = await prisma.role.findMany({
    where: { id: { in: roleIds } },
    include: { permissions: { include: { permission: true } } },
  })

  if (roles.length !== roleIds.length) {
    throw new ValidationError('One or more of those roles no longer exists')
  }

  return roles
}

/** Every permission the given roles would confer, flattened. */
export function permissionsOfRoles(
  roles: Array<{ permissions: Array<{ permission: { key: string } }> }>,
): string[] {
  const keys = new Set<string>()
  for (const role of roles) for (const rp of role.permissions) keys.add(rp.permission.key)
  return [...keys]
}
