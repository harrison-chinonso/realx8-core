require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../cred.env') });

const { connectDatabase } = require('../config/database');
const { sequelize, User, Role, Permission } = require('../models');
/**
 * The catalogue is shared with seedRolesAndPermissions.js, which runs on every
 * boot. The difference is deliberate: that one only fills in roles which have
 * NO permissions, so it cannot undo an administrator's customisations, whereas
 * this script REASSERTS the mapping in full.
 *
 * So `npm run seed` is the escape hatch — the way to put customised roles back
 * to the platform defaults. It is not needed to bring a new deployment up.
 */
const { ROLES, PERMISSIONS, ROLE_PERMISSIONS } = require('./permissionCatalog');

const syncRecord = async (Model, uniqueField, payload) => {
  const [row, created] = await Model.findOrCreate({
    where: { [uniqueField]: payload[uniqueField] },
    defaults: payload,
  });

  if (!created) {
    await row.update(payload);
  }

  return row;
};

const run = async () => {
  try {
    await connectDatabase();
    await sequelize.sync({ force: false });

    const roleMap = new Map();
    for (const role of ROLES) {
      const row = await syncRecord(Role, 'name', { ...role, guard_name: 'api', company_id: null });
      roleMap.set(row.name, row);
    }

    const permissionMap = new Map();
    for (const permission of PERMISSIONS) {
      const row = await syncRecord(Permission, 'name', { ...permission, guard_name: 'api', description: permission.description || null });
      permissionMap.set(row.name, row);
    }

    for (const [roleName, mappedPermissions] of Object.entries(ROLE_PERMISSIONS)) {
      const role = roleMap.get(roleName);
      if (!role) continue;
      const permissions = mappedPermissions === '*'
        ? Array.from(permissionMap.values())
        : mappedPermissions.map((name) => permissionMap.get(name)).filter(Boolean);
      // setPermissions replaces only this role's links — no global DELETE needed
      await role.setPermissions(permissions);
    }

    const superiorAdminRole = roleMap.get('superior_admin');
    if (superiorAdminRole) {
      const superiorAdmins = await User.findAll({ where: { type: 'superior_admin' } });
      for (const user of superiorAdmins) {
        // setRoles replaces existing assignments, preventing duplicate junction rows
        await user.setRoles([superiorAdminRole]);
      }
    }

    const superAdminRole = roleMap.get('super_admin');
    if (superAdminRole) {
      const superAdmins = await User.findAll({ where: { type: 'super_admin' } });
      for (const user of superAdmins) {
        await user.setRoles([superAdminRole]);
      }
    }

    console.log(`Seed complete: ${roleMap.size} roles, ${permissionMap.size} permissions.`);
    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
};

run();
