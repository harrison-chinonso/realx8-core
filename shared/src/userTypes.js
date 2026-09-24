/**
 * The account types `users.type` may hold.
 *
 * ── Why this is shared rather than declared beside the column ────────────────
 *
 * Two services define a model over `users`, each with its own copy of this
 * list, and the copies had to agree: the enum is widened from the models on
 * boot (see enumSync.js), so a value present in one and missing from the other
 * is a column that accepts a write in development and refuses it wherever the
 * other service migrated last. One list, required by both.
 *
 * ── type is not the same thing as a role ────────────────────────────────────
 *
 * `type` is the fixed vocabulary every guard reads — requireRoles and
 * buildCompanyScope branch on it, and createAccessToken derives platform
 * standing from it. ROLES are configuration: an administrator can add
 * "Accountant" on the Roles screen, and what an accountant may do is the
 * permissions on that role, not a new value here.
 *
 * So a custom role has no `type` of its own; its holder is an `employee` who
 * carries it. Writing the role name into this column instead is what produced
 *
 *     Data truncated for column 'type' at row 1
 *
 * on every attempt to create staff under a role somebody had added — a
 * database message, surfaced from a form that had asked for nothing unusual.
 */
const USER_TYPES = [
  'superior_admin',
  'super_admin',
  'admin',
  'employee',
  'realtor',
  'client',
  'coo',
  'csmo',
  'product_manager',
  'customer_care',
  'media_team',
  'branch_manager',
  'front_desk',
];

const isUserType = (value) => USER_TYPES.includes(String(value || ''));

module.exports = { USER_TYPES, isUserType };
