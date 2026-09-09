const bcrypt = require('bcryptjs');

const DEFAULT_NAME = process.env.SUPER_ADMIN_NAME || 'Platform Admin';
const DEFAULT_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'superioradmin@realto.com';
const DEFAULT_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Superior@123456';

module.exports = async function bootstrap({ User, Role, Permission, UserRole, RolePermission }) {
  const existing = await User.findOne({ where: { type: 'superior_admin' } });
  if (existing) {
    return;
  }

  const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  const admin = await User.create({
    name: DEFAULT_NAME,
    email: DEFAULT_EMAIL,
    password: hashedPassword,
    type: 'superior_admin',
    company_id: null,
    is_active: true,
  });

  const [superRole] = await Role.findOrCreate({
    where: { name: 'superior_admin' },
    defaults: {
      name: 'superior_admin',
      display_name: 'Platform Admin',
      description: 'Platform-wide super access across all companies',
      guard_name: 'api',
      company_id: null,
    },
  });

  await UserRole.findOrCreate({
    where: { user_id: admin.id, role_id: superRole.id },
  });

  const allPermissions = await Permission.findAll();
  if (allPermissions.length > 0) {
    const pivotRows = allPermissions.map((permission) => ({
      role_id: superRole.id,
      permission_id: permission.id,
    }));
    await RolePermission.bulkCreate(pivotRows, { ignoreDuplicates: true });
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        DEFAULT SUPERIOR ADMIN CREATED           ║');
  console.log('║                                                  ║');
  console.log(`║  Email    : ${DEFAULT_EMAIL.padEnd(37)}║`);
  console.log(`║  Password : ${DEFAULT_PASSWORD.padEnd(37)}║`);
  console.log('║                                                  ║');
  console.log('║  ⚠  Change this password immediately after       ║');
  console.log('║     your first login!                            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
};
