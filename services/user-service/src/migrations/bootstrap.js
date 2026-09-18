const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { BCRYPT_ROUNDS } = require('../../../../shared/src/passwordPolicy');

const DEFAULT_NAME = process.env.SUPER_ADMIN_NAME || 'Platform Admin';
const DEFAULT_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'superioradmin@realto.com';

/**
 * The first platform administrator's password. There is no default.
 *
 * ── Why a literal here was the worst one in the codebase ────────────────────
 *
 * It used to read `process.env.SUPER_ADMIN_PASSWORD || 'Superior@123456'`, and
 * that string is the password on the one account that spans every company and
 * holds every permission. A default password in a source tree is not a default
 * at all: it is a credential held by everyone who can read the repository, on
 * every installation whose operator did not know to override it. And nothing
 * ever asked them to — the account was created silently on first boot and the
 * banner below only suggested changing it.
 *
 * Outside development the boot now FAILS without an explicit value. A service
 * that will not start is a deployment that gets fixed in five minutes; a
 * service that starts with a known platform-admin login is a breach nobody
 * notices. In development a random one is generated per bootstrap, so a
 * developer who never sets the variable still cannot end up with a password
 * anybody else can guess.
 */
const DEFAULT_PASSWORD = process.env.SUPER_ADMIN_PASSWORD
  || (process.env.NODE_ENV === 'production' ? null : crypto.randomBytes(18).toString('base64url'));

module.exports = async function bootstrap({ User, Role, Permission, UserRole, RolePermission }) {
  const existing = await User.findOne({ where: { type: 'superior_admin' } });
  if (existing) {
    return;
  }

  if (!DEFAULT_PASSWORD) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD is not set, and there is no default. Set it to a value you have '
      + 'generated, or create the first platform administrator by hand. Refusing to bootstrap.',
    );
  }

  const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);
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

  /**
   * The password is NOT printed.
   *
   * stdout is the log aggregator on every platform this runs on: indexed,
   * retained, and readable by anyone with log access long after the person who
   * needed the credential has used it. Where the value came from the
   * environment, whoever set it already has it. Where it was generated for
   * development, it is shown once here and nowhere else — a local developer
   * needs to be able to sign in, and that console line is not going anywhere
   * but their own terminal.
   */
  const generated = !process.env.SUPER_ADMIN_PASSWORD;
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        PLATFORM ADMINISTRATOR CREATED            ║');
  console.log('║                                                  ║');
  console.log(`║  Email    : ${DEFAULT_EMAIL.padEnd(37)}║`);
  console.log(`║  Password : ${(generated ? DEFAULT_PASSWORD : 'as set in SUPER_ADMIN_PASSWORD').padEnd(37)}║`);
  console.log('║                                                  ║');
  console.log('║  Sign in and change it now.                      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
};
