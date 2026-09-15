const { ROLES, PERMISSIONS, ROLE_PERMISSIONS } = require('./permissionCatalog');

/**
 * Seeds the default roles, permissions and role→permission mapping on boot.
 *
 * These used to exist only if somebody remembered to run `npm run seed`, so a
 * fresh deployment came up with an empty `permissions` table — and because
 * bootstrap.js grants the platform admin "all existing permissions", that meant
 * granting nothing. Every permission check was therefore either failing or, as
 * in the routes this was added alongside, avoided in favour of a role check.
 *
 * SAFETY ON AN EXISTING DATABASE is the whole design constraint here, because
 * this now runs on every single boot:
 *
 *   permission rows   upserted. Additive and safe — a new permission appears,
 *                     an existing one has its label refreshed.
 *   role rows         created if missing, never modified. A company may have
 *                     renamed a role's display_name and that is theirs to keep.
 *   the MAPPING       only filled in for a role that currently has NO
 *                     permissions at all.
 *
 * That last rule is the important one. `role.setPermissions()` REPLACES a
 * role's set, so reasserting the defaults on every boot would silently undo
 * every customisation an administrator had made through the Roles screen — on a
 * restart, with no warning. A role with nothing is unconfigured and gets the
 * defaults; a role with anything has been decided already and is left alone.
 *
 * `npm run seed` still reasserts the mapping in full, which is the escape hatch
 * for putting a customised role back to the platform default.
 *
 * The exception is superior_admin, which is mapped '*' and is re-granted every
 * boot. It is the platform-wide role and a new permission that did not reach it
 * would be a permission nobody can exercise — including the permission needed
 * to grant it.
 */
module.exports = async function seedRolesAndPermissions(models) {
  const { Role, Permission } = models;

  const permissionsByName = new Map();
  /**
   * Permissions that did not exist in this database until a moment ago.
   *
   * Tracked because a BRAND NEW permission is the one case where leaving a
   * configured role alone is wrong — see the grant loop below.
   */
  const newlyCreated = new Set();
  for (const permission of PERMISSIONS) {
    // eslint-disable-next-line no-await-in-loop
    const [row, created] = await Permission.findOrCreate({
      where: { name: permission.name },
      defaults: { ...permission, guard_name: 'api', description: permission.description || null },
    });
    if (!created) {
      // Label and module only. Never the name — that is the key everything
      // else joins on.
      // eslint-disable-next-line no-await-in-loop
      await row.update({
        display_name: permission.display_name,
        module: permission.module,
        ...(permission.description ? { description: permission.description } : {}),
      });
    }
    if (created) newlyCreated.add(row.name);
    permissionsByName.set(row.name, row);
  }

  const rolesByName = new Map();
  for (const role of ROLES) {
    // eslint-disable-next-line no-await-in-loop
    const [row] = await Role.findOrCreate({
      where: { name: role.name, company_id: null },
      defaults: { ...role, guard_name: 'api', company_id: null },
    });
    rolesByName.set(row.name, row);
  }

  let rolesSeeded = 0;
  for (const [roleName, granted] of Object.entries(ROLE_PERMISSIONS)) {
    const role = rolesByName.get(roleName);
    if (!role) continue;

    const resolved = granted === '*'
      ? Array.from(permissionsByName.values())
      : granted.map((name) => permissionsByName.get(name)).filter(Boolean);

    if (granted === '*') {
      // Additive, not a replacement: adds anything missing and removes nothing,
      // so a platform admin always holds every permission in the catalogue.
      // eslint-disable-next-line no-await-in-loop
      await role.addPermissions(resolved);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const existing = await role.countPermissions();
    if (existing > 0) {
      /**
       * The role has been configured, so its set is not replaced — but a
       * permission that did not exist until this boot is a different case.
       *
       * Skipping those meant a new permission could never reach a role that
       * had ever been touched: the feature behind it shipped, its screens
       * appeared, and the button stayed hidden for everybody except the
       * platform admin. That is not an administrator's decision being
       * respected, because no administrator could have made one — the
       * permission did not exist when they last looked.
       *
       * So: additive, and only for the genuinely new. `addPermissions` removes
       * nothing, so every customisation survives. An administrator who does
       * not want it can take it away on the Roles screen, and this will not put
       * it back — the permission is no longer new on the next boot.
       */
      const fresh = resolved.filter((permission) => newlyCreated.has(permission.name));
      if (fresh.length) {
        // eslint-disable-next-line no-await-in-loop
        await role.addPermissions(fresh);
        console.log(`[seed] ${roleName}: granted ${fresh.map((p) => p.name).join(', ')}`);
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await role.setPermissions(resolved);
    rolesSeeded += 1;
  }

  if (rolesSeeded > 0) {
    console.log(`[permissions] ${permissionsByName.size} permissions available; `
      + `seeded defaults for ${rolesSeeded} unconfigured role(s)`);
  }
};
