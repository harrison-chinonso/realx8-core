const { Branch, Property } = require('../models');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Branches — a company's offices, and the properties run out of them.
 *
 * ── The rule that needs guarding ────────────────────────────────────────────
 *
 * "A property can only be assigned to one branch" is enforced by the schema:
 * `properties.branch_id` is one column, so there is no way to write two. That
 * part needs no code.
 *
 * What DOES need code is the part the schema cannot express — that the branch
 * must belong to the property's OWN company. A foreign key can say branch 7
 * exists; it cannot say whose it is. Without the check, one tenant could file
 * their property under another tenant's office by passing its id, and the only
 * symptom would be a property quietly appearing in a stranger's branch report.
 *
 * So the branch is resolved through the company scope before it is accepted:
 * if it is not visible to the caller, it does not exist as far as they are
 * concerned, and the assignment is refused rather than silently dropped.
 */

const companyScope = (req) => buildCompanyScope(req);

/**
 * Validate a branch assignment, returning the id to store.
 *
 * @throws {Error} with `status` 400 when the branch is not the caller's
 * @returns {number|null} the branch id, or null for "no branch"
 */
const resolveBranchId = async (req, rawValue) => {
  // Absent means "not mentioned" — leave whatever is there alone. Only an
  // explicit empty value clears an assignment, and the two must not be
  // confused: a form that omits the field would otherwise unassign silently.
  if (rawValue === undefined) return undefined;
  if (rawValue === null || rawValue === '') return null;

  const branch = await Branch.findOne({
    where: { id: rawValue, ...companyScope(req) },
  });

  if (!branch) {
    const error = new Error('That branch does not belong to this company.');
    error.status = 400;
    throw error;
  }
  return branch.id;
};

const branchCrud = buildCrudController(Branch, {
  searchFields: ['name', 'address'],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),

  /**
   * Closing a branch releases its properties rather than taking them with it.
   *
   * The branch is soft-deleted, so the row survives and the foreign key never
   * fires — which would leave every property pointing at a branch that no
   * longer appears in any list, showing a blank where the office name goes.
   * Properties are unassigned first, which is the honest state: they exist, and
   * no office runs them any more.
   */
  beforeDelete: async (branch) => {
    await Property.update({ branch_id: null }, { where: { branch_id: branch.id } });
  },
});

/**
 * The properties a branch runs.
 *
 * Scoped twice on purpose — once to find the branch, once to find its
 * properties. The second is not redundant: it is what stops a branch id from
 * another company, if one ever got through, from returning that company's
 * properties.
 */
const listBranchProperties = asyncHandler(async (req, res) => {
  const branch = await Branch.findOne({
    where: { id: req.params.id, ...companyScope(req) },
  });
  if (!branch) return res.status(404).json({ message: 'Branch not found' });

  const properties = await Property.findAll({
    where: { branch_id: branch.id, ...companyScope(req) },
    attributes: ['id', 'name', 'city', 'state', 'status'],
    order: [['name', 'ASC']],
  });

  res.json({ data: properties, branch: { id: branch.id, name: branch.name } });
});

module.exports = { branchCrud, listBranchProperties, resolveBranchId };
