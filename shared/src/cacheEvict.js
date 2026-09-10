const { cache, KEYS } = require('./cache');

/**
 * Every eviction rule in the backend, named.
 *
 * Call sites say `evictUserAuthorisation(userId)` rather than assembling key
 * strings, for one reason: a cache is only as correct as its least careful
 * writer, and a raw `cache.del('perm:user:' + id)` in a controller is how a
 * key gets missed when the shape changes. Adding a cached read means adding its
 * eviction HERE, next to the others, where the omission is visible.
 *
 * ── What eviction can and cannot do ──────────────────────────────────────────
 *
 * With Redis, an eviction is seen by every instance immediately. Without it —
 * the in-process fallback — each instance evicts only its OWN copy, so another
 * instance can serve a stale value until the TTL lapses. That is why nothing
 * here is treated as a security boundary on its own: the TTLs in cache.js are
 * the backstop, and the authorisation ones are minutes, not hours.
 *
 * These are all fire-and-forget with respect to failure: an eviction that
 * cannot reach Redis logs and moves on rather than failing the write that
 * triggered it. A user whose role was updated must not see "role update failed"
 * because a cache was unreachable — the write already succeeded, and the TTL
 * will catch up.
 */

/**
 * A user's roles and permissions.
 *
 * Note what this does NOT fix: permissions ride in the JWT, so a revoked
 * permission stays live in an already-issued token until it expires, whatever
 * this cache says. Eviction makes the NEXT login or refresh correct. Revoking
 * access from an active session needs the token invalidated, which is a
 * separate concern from caching.
 */
const evictUserAuthorisation = async (userId) => {
  if (!userId) return;
  await cache.del(KEYS.userPermissions(userId), KEYS.userRoles(userId));
};

/**
 * A role's permission grants changed.
 *
 * Drops EVERY user's cached permissions, not just the role's holders — this
 * module cannot know who holds the role without running the very query it is
 * trying to avoid. A role edit is rare and a permission read is cheap to
 * rebuild, so the blunt eviction is the right trade; the alternative is users
 * silently keeping permissions an admin just removed.
 *
 * Takes no role id for that reason: accepting one would suggest the eviction
 * is scoped to it, and it is not.
 */
const evictRole = async () => {
  await cache.delByPrefix('perm:user:');
  await cache.delByPrefix('roles:user:');
  // Recipient lists are permission-derived, so a changed grant changes who is
  // notified.
  await cache.delByPrefix('recipients:');
};

/**
 * The whole permission catalogue changed — a migration or a fresh seed.
 */
const evictAllAuthorisation = async () => {
  await cache.delByPrefix('perm:');
  await cache.delByPrefix('roles:');
  await cache.delByPrefix('recipients:');
};

/** A company's notification settings were saved. */
const evictNotificationConfig = async (companyId) => {
  await cache.del(KEYS.notificationConfig(companyId));
  /**
   * A PLATFORM-level save (companyId null) also drops every company's entry.
   *
   * Companies with no rows of their own resolve against the platform set and
   * cached the RESULT, so leaving their keys in place would serve the old
   * platform defaults to exactly the companies that never customised anything.
   */
  if (!companyId) await cache.delByPrefix('notify-config:');
};

/** A user was activated, deactivated, deleted, or moved company. */
const evictUserMembership = async (userId) => {
  await evictUserAuthorisation(userId);
  // is_active and company_id are both in the recipient query's WHERE clause.
  await cache.delByPrefix('recipients:');
};

/**
 * A settings group was saved.
 *
 * A GLOBAL save (companyId null) drops the group for EVERY company, not just
 * the global key. Company settings are the platform defaults with the
 * company's own values layered on top, so changing a default changes the
 * effective answer for every company that has not overridden that key — and
 * evicting only the global entry would leave all of them serving the old
 * default until their TTLs lapsed.
 */
const evictSettings = async (group, companyId) => {
  if (!group) {
    await cache.delByPrefix('settings:');
    return;
  }
  if (companyId === null || companyId === undefined) {
    await cache.delByPrefix(`settings:${group}:`);
    return;
  }
  await cache.del(KEYS.settings(group, companyId));
};

/** Installment plan assignments for a unit changed. */
const evictUnitPlans = async (unitId) => {
  if (unitId) await cache.del(KEYS.installmentPlansForUnit(unitId));
  else await cache.delByPrefix('plans:unit:');
};

module.exports = {
  evictUserAuthorisation,
  evictRole,
  evictAllAuthorisation,
  evictNotificationConfig,
  evictUserMembership,
  evictSettings,
  evictUnitPlans,
};
