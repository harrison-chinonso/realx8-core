/**
 * The platform's default roles, permissions and role→permission mapping.
 *
 * The single source of truth for both callers:
 *
 *   migrations/seedRolesAndPermissions.js  runs on every boot, so a fresh
 *                                          database comes up with the whole
 *                                          default set and no manual step.
 *   migrations/seed.js                     `npm run seed`, which additionally
 *                                          REASSERTS the mapping — see the note
 *                                          on the two behaviours there.
 *
 * These lived inline in seed.js, which meant they only existed if somebody
 * remembered to run it. Adding a permission here is now all that is needed for
 * it to exist on a new deployment.
 */

const ROLES = [
  { name: 'superior_admin', display_name: 'Platform Admin', description: 'Platform-wide access across all companies' },
  { name: 'super_admin', display_name: 'Super Admin', description: 'Full company access' },
  { name: 'admin', display_name: 'Administrator', description: 'Full access except system config' },
  { name: 'coo', display_name: 'COO', description: 'Chief Operations Officer' },
  { name: 'csmo', display_name: 'CSMO', description: 'Chief Sales & Marketing Officer' },
  { name: 'product_manager', display_name: 'Product Manager', description: 'Property inventory management' },
  { name: 'customer_care', display_name: 'Customer Care', description: 'Client relationship management' },
  { name: 'media_team', display_name: 'Media Team', description: 'Content and social media' },
  { name: 'branch_manager', display_name: 'Branch Manager', description: 'Branch-level management' },
  { name: 'realtor', display_name: 'Realtor', description: 'Sales agent' },
  { name: 'employee', display_name: 'Employee', description: 'General staff' },
  { name: 'client', display_name: 'Client', description: 'Customer / investor' },
  { name: 'front_desk', display_name: 'Front Desk', description: 'Front desk officer' },
];

const PERMISSIONS = [
  { name: 'dashboard.view', display_name: 'View Dashboard', module: 'dashboard' },
  { name: 'dashboard.executive.view', display_name: 'View Executive Dashboard', module: 'dashboard' },
  { name: 'properties.view', display_name: 'View Properties', module: 'properties' },
  { name: 'properties.create', display_name: 'Create Properties', module: 'properties' },
  { name: 'properties.manage', display_name: 'Manage Properties', module: 'properties' },
  { name: 'properties.approve', display_name: 'Approve Properties', module: 'properties' },
  /**
   * Promotions, split three ways on purpose.
   *
   * Seeing what is running, drafting a campaign, and committing the company's
   * money by publishing one are three different decisions. Plenty of companies
   * want a marketing team that can draft and a director who signs off — which
   * a single "manage promotions" permission cannot express.
   */
  { name: 'promotions.view', display_name: 'View Promotions', module: 'properties' },
  { name: 'promotions.manage', display_name: 'Create & Edit Promotions', module: 'properties' },
  { name: 'promotions.publish', display_name: 'Publish & Pause Promotions', module: 'properties' },
  // Editing a property's unit configurations sets prices and available
  // quantities, so it is its own permission rather than part of
  // properties.manage — the routes behind it previously required nothing but a
  // valid token.
  { name: 'properties.units.manage', display_name: 'Edit Property Units', module: 'properties' },
  // Which installment plans a property's units may be sold on. A property
  // inventory decision, which is why it sits in this module even though the
  // plans themselves are finance's.
  { name: 'properties.installment-plans.manage', display_name: 'Set Allowable Installment Plans on a Property', module: 'properties' },
  { name: 'properties.inspections.view', display_name: 'View Inspections', module: 'properties' },
  { name: 'properties.inspections.manage', display_name: 'Manage Inspections', module: 'properties' },
  { name: 'investments.view', display_name: 'View Investments', module: 'investments' },
  { name: 'investments.manage', display_name: 'Manage Investments', module: 'investments' },
  { name: 'investments.own.view', display_name: 'View Own Investments', module: 'investments' },
  { name: 'crm.leads.view', display_name: 'View Leads', module: 'crm' },
  { name: 'crm.leads.create', display_name: 'Create Leads', module: 'crm' },
  { name: 'crm.leads.manage', display_name: 'Manage Leads', module: 'crm' },
  { name: 'crm.deals.view', display_name: 'View Deals', module: 'crm' },
  { name: 'crm.deals.manage', display_name: 'Manage Deals', module: 'crm' },
  { name: 'crm.pipelines.manage', display_name: 'Manage Pipelines', module: 'crm' },
  { name: 'crm.tasks.view', display_name: 'View Tasks', module: 'crm' },
  { name: 'crm.tasks.manage', display_name: 'Manage Tasks', module: 'crm' },
  { name: 'crm.analytics.view', display_name: 'View Sales Analytics', module: 'crm' },
  { name: 'crm.objections.view', display_name: 'View Objections', module: 'crm' },
  { name: 'crm.objections.manage', display_name: 'Manage Objections', module: 'crm' },
  { name: 'finance.invoices.view', display_name: 'View Invoices', module: 'finance' },
  { name: 'finance.invoices.create', display_name: 'Create Invoices', module: 'finance' },
  { name: 'finance.invoices.manage', display_name: 'Manage Invoices', module: 'finance' },
  { name: 'finance.reports.view', display_name: 'View Reports', module: 'finance' },
  { name: 'finance.commissions.view', display_name: 'View Commissions', module: 'finance' },
  { name: 'finance.commissions.manage', display_name: 'Manage Commissions', module: 'finance' },
  { name: 'finance.credit-notes.manage', display_name: 'Manage Credit Notes', module: 'finance' },
  { name: 'finance.debit-notes.manage', display_name: 'Manage Debit Notes', module: 'finance' },
  /**
   * Approving a note is a SEPARATE permission from raising one, on purpose.
   *
   * A credit note writes off money owed to the company and a debit note
   * creates money owed out of it. Whoever raises one should not be the one who
   * signs it off — that is the whole reason the step exists, and merging it
   * into `manage` would make the approval a formality performed by the person
   * who wanted it.
   */
  { name: 'finance.notes.approve', display_name: 'Approve Credit & Debit Notes', module: 'finance' },
  { name: 'finance.payment-reminders.manage', display_name: 'Manage Payment Reminders', module: 'finance' },
  { name: 'finance.bank-accounts.manage', display_name: 'Manage Bank Accounts', module: 'finance' },
  { name: 'finance.taxes.manage', display_name: 'Manage Taxes', module: 'finance' },
  // The purchase journey. Plan templates carry the surcharge and default-fee
  // terms; the schedule permissions cover the ledger, fee waivers, quantity
  // edits and cancellation.
  //
  // The inventory hold policy has no permission of its own: it is written
  // through /settings, which user-service gates by role, and a permission that
  // enforced nothing would invite an administrator to grant it and expect it
  // to take effect.
  { name: 'finance.installment-plans.view', display_name: 'View Installment Plans', module: 'finance' },
  { name: 'finance.installment-plans.manage', display_name: 'Manage Installment Plans', module: 'finance' },
  { name: 'finance.payment-schedules.view', display_name: 'View Payment Schedules & Allocations', module: 'finance' },
  { name: 'finance.payment-schedules.manage', display_name: 'Waive Fees, Edit Invoice Quantity & Cancel Invoices', module: 'finance' },
  { name: 'finance.purchase-notifications.manage', display_name: 'Configure Purchase Notifications', module: 'finance' },
  { name: 'users.view', display_name: 'View Users', module: 'users' },
  { name: 'users.create', display_name: 'Create Users', module: 'users' },
  { name: 'users.manage', display_name: 'Manage Users', module: 'users' },
  { name: 'roles.view', display_name: 'View Roles & Permissions', module: 'roles' },
  { name: 'roles.manage', display_name: 'Manage Roles & Permissions', module: 'roles' },
  { name: 'settings.appearance.manage', display_name: 'Manage Appearance Settings', module: 'settings' },
  { name: 'settings.security.manage', display_name: 'Manage Security Settings', module: 'settings' },
  { name: 'media.view', display_name: 'View Media', module: 'media' },
  { name: 'media.create', display_name: 'Create Media Posts', module: 'media' },
  { name: 'media.approve', display_name: 'Approve Media', module: 'media' },
  { name: 'media.schedule', display_name: 'Schedule Media', module: 'media' },
  { name: 'media.analytics.view', display_name: 'View Media Analytics', module: 'media' },
  { name: 'media.blog.manage', display_name: 'Manage Blog', module: 'media' },
  { name: 'realtors.training.view', display_name: 'View Training', module: 'realtors' },
  { name: 'realtors.training.manage', display_name: 'Manage Training', module: 'realtors' },
  { name: 'realtors.leaderboard.view', display_name: 'View Leaderboard', module: 'realtors' },
  { name: 'realtors.recruitment.view', display_name: 'View Recruitment', module: 'realtors' },
  { name: 'realtors.recruitment.manage', display_name: 'Manage Recruitment', module: 'realtors' },
  { name: 'frontdesk.visitors.manage', display_name: 'Manage Visitors', module: 'frontdesk' },
  { name: 'frontdesk.attendance.manage', display_name: 'Manage Attendance', module: 'frontdesk' },
  { name: 'care.view', display_name: 'View Customer Care', module: 'care' },
  { name: 'care.manage', display_name: 'Manage Customer Care', module: 'care' },
  { name: 'care.vip.view', display_name: 'View VIP Clients', module: 'care' },
  { name: 'notifications.view', display_name: 'View Notifications', module: 'notifications' },
  { name: 'notifications.send', display_name: 'Send Notifications', module: 'notifications' },
  { name: 'support.view', display_name: 'View Support', module: 'support' },
  { name: 'support.manage', display_name: 'Manage Support', module: 'support' },
  { name: 'companies.view', display_name: 'View Companies', module: 'companies' },
  { name: 'companies.create', display_name: 'Create Companies', module: 'companies' },
  { name: 'companies.manage', display_name: 'Manage Companies', module: 'companies' },
  { name: 'companies.delete', display_name: 'Delete Companies', module: 'companies' },
  /**
   * Reading the audit trail.
   *
   * One permission, not two. What a holder SEES depends on who they are — a
   * company administrator gets their own company's activity, a platform
   * administrator gets every company's — and that is decided by the scope the
   * controller applies, not by which permission was granted. Two permissions
   * would invite somebody to grant the platform-wide one to a company
   * administrator and expect it to mean something; it could not, because the
   * scope is derived from their account rather than from their grants.
   *
   * Granted to super_admin and admin, the two roles that ARE the company's
   * administration. Withholding it from them made the Audit Trail a screen that
   * existed and nobody could open: the platform admin could already see
   * everything, and the people whose own company's activity it records could
   * see none of it.
   *
   * Not granted below those two. A branch manager or customer-care agent has no
   * business reading who changed a commission rule, and the permission is on
   * the Roles screen for an owner who decides otherwise.
   */
  { name: 'audit.view', display_name: 'View Audit Trail', module: 'audit' },
  { name: 'platform.dashboard.view', display_name: 'View Platform Dashboard', module: 'platform' },
  { name: 'platform.users.view', display_name: 'View Platform Users', module: 'platform' },
  { name: 'platform.settings.manage', display_name: 'Manage Platform Settings', module: 'platform' },
];

const SUPER_ADMIN_PERMISSIONS = [
  'dashboard.view', 'dashboard.executive.view',
  'properties.view', 'properties.create', 'properties.manage', 'properties.approve', 'promotions.view', 'promotions.manage', 'promotions.publish', 'properties.inspections.view', 'properties.inspections.manage',
  'properties.units.manage', 'properties.installment-plans.manage',
  'investments.view', 'investments.manage', 'investments.own.view',
  'crm.leads.view', 'crm.leads.create', 'crm.leads.manage', 'crm.deals.view', 'crm.deals.manage', 'crm.pipelines.manage', 'crm.tasks.view', 'crm.tasks.manage', 'crm.analytics.view', 'crm.objections.view', 'crm.objections.manage',
  'finance.invoices.view', 'finance.invoices.create', 'finance.invoices.manage', 'finance.reports.view', 'finance.commissions.view', 'finance.commissions.manage', 'finance.credit-notes.manage', 'finance.debit-notes.manage', 'finance.notes.approve', 'finance.payment-reminders.manage', 'finance.bank-accounts.manage', 'finance.taxes.manage',
  'finance.installment-plans.view', 'finance.installment-plans.manage',
  'finance.payment-schedules.view', 'finance.payment-schedules.manage',
  'finance.purchase-notifications.manage',
  'users.view', 'users.create', 'users.manage',
  'roles.view', 'roles.manage',
  'audit.view',
  'settings.appearance.manage',
  'media.view', 'media.create', 'media.approve', 'media.schedule', 'media.analytics.view', 'media.blog.manage',
  'realtors.training.view', 'realtors.training.manage', 'realtors.leaderboard.view', 'realtors.recruitment.view', 'realtors.recruitment.manage',
  'frontdesk.visitors.manage', 'frontdesk.attendance.manage',
  'care.view', 'care.manage', 'care.vip.view',
  'notifications.view', 'notifications.send',
  'support.view', 'support.manage',
];

const ROLE_PERMISSIONS = {
  superior_admin: '*',
  super_admin: SUPER_ADMIN_PERMISSIONS,
  admin: [
    'dashboard.view', 'dashboard.executive.view',
    'properties.view', 'properties.create', 'properties.manage', 'properties.approve', 'promotions.view', 'promotions.manage', 'promotions.publish', 'properties.inspections.view', 'properties.inspections.manage',
    'properties.units.manage', 'properties.installment-plans.manage',
    'investments.view', 'investments.manage', 'investments.own.view',
    'crm.leads.view', 'crm.leads.create', 'crm.leads.manage', 'crm.deals.view', 'crm.deals.manage', 'crm.pipelines.manage', 'crm.tasks.view', 'crm.tasks.manage', 'crm.analytics.view', 'crm.objections.view', 'crm.objections.manage',
    'finance.invoices.view', 'finance.invoices.create', 'finance.invoices.manage', 'finance.reports.view', 'finance.commissions.view', 'finance.commissions.manage', 'finance.credit-notes.manage', 'finance.debit-notes.manage', 'finance.notes.approve', 'finance.payment-reminders.manage', 'finance.bank-accounts.manage', 'finance.taxes.manage',
    'finance.installment-plans.view', 'finance.installment-plans.manage',
    'finance.payment-schedules.view', 'finance.payment-schedules.manage',
    'finance.purchase-notifications.manage',
    'users.view', 'users.create', 'users.manage',
    'roles.view', 'roles.manage',
    'audit.view',
    'settings.appearance.manage',
    'media.view', 'media.create', 'media.approve', 'media.schedule', 'media.analytics.view', 'media.blog.manage',
    'realtors.training.view', 'realtors.training.manage', 'realtors.leaderboard.view', 'realtors.recruitment.view', 'realtors.recruitment.manage',
    'frontdesk.visitors.manage', 'frontdesk.attendance.manage',
    'care.view', 'care.manage', 'care.vip.view',
    'notifications.view', 'notifications.send',
    'support.view', 'support.manage',
  ],
  coo: [
    'dashboard.view', 'dashboard.executive.view',
    'finance.invoices.view', 'finance.invoices.create', 'finance.invoices.manage', 'finance.reports.view', 'finance.commissions.view', 'finance.commissions.manage', 'finance.credit-notes.manage', 'finance.debit-notes.manage', 'finance.notes.approve', 'finance.payment-reminders.manage', 'finance.bank-accounts.manage', 'finance.taxes.manage',
    'finance.installment-plans.view', 'finance.payment-schedules.view', 'finance.payment-schedules.manage',
    'crm.leads.view', 'crm.analytics.view', 'crm.objections.view',
    'realtors.leaderboard.view', 'realtors.training.view',
    'properties.view', 'properties.inspections.view',
    'investments.view', 'investments.manage', 'investments.own.view',
    'care.view', 'care.manage', 'care.vip.view',
    'users.view',
    'notifications.view', 'notifications.send',
    'support.view',
  ],
  csmo: [
    'dashboard.view', 'dashboard.executive.view',
    'media.view', 'media.analytics.view',
    'finance.commissions.view',
    'crm.leads.view', 'crm.leads.create', 'crm.leads.manage', 'crm.deals.view', 'crm.deals.manage', 'crm.pipelines.manage', 'crm.tasks.view', 'crm.tasks.manage', 'crm.analytics.view', 'crm.objections.view', 'crm.objections.manage',
    'realtors.leaderboard.view', 'realtors.training.view',
    'properties.view', 'properties.inspections.view',
    'users.view',
    'notifications.view', 'notifications.send',
    'support.view',
  ],
  product_manager: [
    'dashboard.view',
    'properties.view', 'properties.create', 'properties.manage', 'properties.approve', 'promotions.view', 'promotions.manage', 'promotions.publish', 'properties.inspections.view', 'properties.inspections.manage',
    'properties.units.manage', 'properties.installment-plans.manage',
    'finance.installment-plans.view',
    'media.approve',
    'notifications.view',
  ],
  customer_care: [
    'dashboard.view',
    'care.view', 'care.manage', 'care.vip.view',
    'investments.own.view',
    'crm.leads.view',
    'properties.view',
    'notifications.view',
    'support.view', 'support.manage',
  ],
  media_team: [
    'dashboard.view',
    'media.view', 'media.create', 'media.schedule', 'media.analytics.view', 'media.blog.manage',
    'properties.view',
    'notifications.view',
  ],
  branch_manager: [
    'dashboard.view',
    'finance.reports.view',
    'crm.leads.view', 'crm.deals.view', 'crm.analytics.view',
    'realtors.leaderboard.view', 'realtors.training.view',
    'properties.view', 'properties.inspections.view',
    'frontdesk.visitors.manage', 'frontdesk.attendance.manage',
    'users.view',
    'notifications.view',
    'support.view',
  ],
  realtor: [
    'dashboard.view',
    /**
     * No finance.installment-plans.view.
     *
     * It was granted read-only, on the reasoning that a realtor advises on
     * plans without configuring them — but it only ever put a Finance screen in
     * their sidebar that they had no reason to open. Configuring a purchase
     * does not need it: the unit's options come from an endpoint that carries
     * no permission requirement.
     *
     * Existing installations are handled by revokeRealtorInstallmentPlanView,
     * because the seeder leaves an already-configured role alone.
     */
    'crm.leads.view', 'crm.leads.create', 'crm.deals.view', 'crm.tasks.view', 'crm.tasks.manage', 'crm.objections.view', 'crm.objections.manage',
    'properties.view', 'properties.inspections.view', 'properties.inspections.manage',
    'realtors.training.view', 'realtors.leaderboard.view', 'realtors.recruitment.view',
    'investments.own.view',
    'notifications.view',
    'support.view',
  ],
  employee: [
    'dashboard.view',
    'crm.leads.view', 'crm.deals.view', 'crm.tasks.view', 'crm.tasks.manage',
    'properties.view',
    'notifications.view',
    'support.view',
  ],
  client: [
    'dashboard.view',
    'investments.own.view',
    'properties.view',
    'notifications.view',
    'support.view',
  ],
  front_desk: [
    'dashboard.view',
    'frontdesk.visitors.manage', 'frontdesk.attendance.manage',
    'notifications.view',
  ],
};

module.exports = { ROLES, PERMISSIONS, SUPER_ADMIN_PERMISSIONS, ROLE_PERMISSIONS };
