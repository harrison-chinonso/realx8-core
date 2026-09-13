module.exports = (sequelize, DataTypes) => {
  /**
   * One administrative action: what was done, who did it, when, and to which
   * company.
   *
   * ── The row is a snapshot, not a set of joins ────────────────────────────
   *
   * The actor's name, email and type are COPIED onto the row rather than looked
   * up through actor_id. That is deliberate and it is the whole point: an audit
   * entry has to still read correctly after the person has been renamed, moved
   * to another company, or deleted. Joined to a live `users` row, the trail
   * would quietly rewrite itself every time somebody's record changed — and the
   * deletion of a user would erase the name from every action they ever took,
   * which is precisely the moment the trail matters most.
   *
   * `company_id` is likewise the company the action AFFECTED, which is not
   * always the actor's own: a platform administrator has no company and acts on
   * everybody's. Scoping a company administrator's view to this column is what
   * lets them see work done on their company by the platform team without
   * seeing anything belonging to another company.
   *
   * ── Append-only ─────────────────────────────────────────────────────────
   *
   * The hooks below refuse every update and every delete, and the table carries
   * database triggers that refuse them again — see migrations/createAuditLog.js.
   * Two layers because they fail differently: the hooks catch the mistake in
   * this codebase with a legible error, and the triggers catch everything else,
   * including a direct connection to the database.
   *
   * There is no route that updates or deletes one of these, and there should
   * never be. An audit trail the application can rewrite is a log.
   */
  const AuditLog = sequelize.define('AuditLog', {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },

    /** The company the action affected. Null for platform-level work. */
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    actor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    actor_name: { type: DataTypes.STRING(190), allowNull: true },
    actor_email: { type: DataTypes.STRING(190), allowNull: true },
    /** Their profile at the time — `admin`, `super_admin`, `realtor`, … */
    actor_type: { type: DataTypes.STRING(40), allowNull: true },
    /** The actor's OWN company, which differs from company_id above whenever a
     *  platform administrator acts on somebody else's. */
    actor_company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    actor_is_platform: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    /** Machine name, e.g. `properties.approve`. See shared/src/auditCatalog.js. */
    action: { type: DataTypes.STRING(120), allowNull: false },
    /** How it reads on screen. Stored rather than derived so that renaming an
     *  action later cannot change what an old entry appears to say. */
    action_label: { type: DataTypes.STRING(190), allowNull: true },
    module: { type: DataTypes.STRING(60), allowNull: true },

    entity_type: { type: DataTypes.STRING(60), allowNull: true },
    /** A string, because not every entity is keyed by an integer. */
    entity_id: { type: DataTypes.STRING(64), allowNull: true },
    entity_label: { type: DataTypes.STRING(190), allowNull: true },

    method: { type: DataTypes.STRING(10), allowNull: true },
    path: { type: DataTypes.STRING(255), allowNull: true },
    status_code: { type: DataTypes.INTEGER, allowNull: true },

    ip: { type: DataTypes.STRING(64), allowNull: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },

    /**
     * What was asked for, redacted and bounded — see shared/src/audit.js.
     * TEXT rather than JSON so both engines store it identically and a
     * malformed value can never make the row unreadable.
     */
    metadata: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'audit_logs',
    updatedAt: false,
    indexes: [
      // The list is always ordered newest-first and almost always scoped to one
      // company, which is the pair of columns that makes that cheap.
      { fields: ['company_id', 'created_at'], name: 'ix_audit_logs_company_created' },
      { fields: ['actor_id', 'created_at'], name: 'ix_audit_logs_actor_created' },
      { fields: ['action'], name: 'ix_audit_logs_action' },
      { fields: ['entity_type', 'entity_id'], name: 'ix_audit_logs_entity' },
      { fields: ['created_at'], name: 'ix_audit_logs_created' },
    ],
    hooks: {
      beforeUpdate: () => { throw new Error('Audit entries cannot be modified.'); },
      beforeBulkUpdate: () => { throw new Error('Audit entries cannot be modified.'); },
      beforeDestroy: () => { throw new Error('Audit entries cannot be deleted.'); },
      beforeBulkDestroy: () => { throw new Error('Audit entries cannot be deleted.'); },
    },
  });

  return AuditLog;
};
