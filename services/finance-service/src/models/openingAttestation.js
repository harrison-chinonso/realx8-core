module.exports = (sequelize, DataTypes) => {
  /**
   * Who at the company confirmed the balances it arrived with (ACC-9.3b).
   *
   * ── Why this is a table and not a setting ───────────────────────────────────
   *
   * The first version wrote it into `settings` as JSON, best-effort, with the
   * failure logged and swallowed. On a schema whose settings table had no
   * `updated_at` the insert failed and the opening balance journal posted
   * anyway — which is precisely the outcome the requirement exists to prevent.
   * The sign-off cannot be the part that is allowed to fail.
   *
   * So it is a row of its own, written in the SAME TRANSACTION as the journal:
   * either both exist or neither does, and there is no state in which a
   * company's opening figures are posted with nobody standing behind them.
   *
   * ── The two sides, and why one is not enough ────────────────────────────────
   *
   * A Realx8 admin has the permission and posts it — that is `posted_by`. The
   * tenant's own finance lead or outgoing accountant attests IN WRITING that
   * these are the balances they closed with — that is `attested_by` and the
   * document beside it. An admin attesting alone would place the liability on
   * us for figures we have no way to verify, and every later dispute rewinds
   * to this moment.
   */
  const OpeningAttestation = sequelize.define('OpeningAttestation', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** The journal this stands behind. */
    entry_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    /** The date the balances were true, which is the journal's own date. */
    as_at: { type: DataTypes.DATEONLY, allowNull: false },

    /** Their finance lead or outgoing accountant, by name. */
    attested_by: { type: DataTypes.STRING(160), allowNull: false },
    /** Their written confirmation, through the ordinary upload guard. */
    attestation_url: { type: DataTypes.STRING(500), allowNull: false },

    /** The Realx8 admin who posted it. Deliberately a different person. */
    posted_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    notes: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'opening_attestations',
    indexes: [
      { unique: true, fields: ['entry_id'], name: 'ux_opening_attestations_entry' },
      { fields: ['company_id'], name: 'ix_opening_attestations_company' },
    ],
  });

  return OpeningAttestation;
};
