module.exports = (sequelize, DataTypes) => {
  /**
   * One introduction, from the moment it is made to the commission it earns.
   *
   * ── Why this exists when users.realtor_id already did ──────────────────────
   *
   * A referral used to be a foreign key. `users.realtor_id` says who introduced
   * somebody, and that is all it can say: there is nowhere to record that a
   * person followed a link and never registered, that they registered and went
   * quiet, that they reserved a unit and pulled out, or that an introduction
   * was disqualified and why. Every one of those is a thing a realtor asks
   * about and an administrator has to answer, and none of them had an answer.
   *
   * The foreign key stays. It is what the whole application reads to decide who
   * earns — attribution resolved down to a single id — and it is deliberately
   * not replaced by a join through this table. This records the JOURNEY;
   * `realtor_id` records the ANSWER.
   *
   * ── Owned by user-service ─────────────────────────────────────────────────
   *
   * Beside `users` and `referral_links`, which it references. Three services
   * write to it — auth on sign-up, property when a purchase starts, finance
   * when commission is raised — and they do so through
   * shared/src/referralRecord.js with raw SQL, for the same reason
   * realtor_levels is read that way: a second model for one table would let
   * sync({ alter: true }) in one service reshape another service's schema.
   */
  const Referral = sequelize.define('Referral', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },

    /** The realtor who made the introduction. Never null — a referral with no referrer is not one. */
    referrer_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    /**
     * The person introduced, once they have an account.
     *
     * Null while a referral is no more than a link that was opened. That is the
     * whole reason this column is nullable and the reason the table earns its
     * place: the interesting referrals, for a realtor trying to improve, are
     * the ones that never got this far.
     */
    referred_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** The property a link pointed at, when it pointed at one. */
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** The short code from the link, so a referral can be traced back to what was shared. */
    link_code: { type: DataTypes.STRING(12), allowNull: true },

    /**
     * How they arrived: 'link', 'code', 'google', 'manual'.
     *
     * Free text rather than an enum. A company's channels are their own, and an
     * enum here would mean a migration every time somebody shares a link
     * somewhere new — the same reasoning as commission_rules.realtor_category.
     */
    source: { type: DataTypes.STRING(32), allowNull: true },

    /**
     * Where this introduction has got to. See shared/src/referralRecord.js for
     * the ladder and the rule that it only ever moves forward.
     */
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'invited' },

    /**
     * Why it ended, for the statuses that are an ending.
     *
     * A cancelled or disqualified referral with no reason is an argument
     * waiting to happen: the realtor believes they earned it and nothing on
     * the record says otherwise.
     */
    reason: { type: DataTypes.TEXT, allowNull: true },

    first_seen_at: { type: DataTypes.DATE, allowNull: true },
    registered_at: { type: DataTypes.DATE, allowNull: true },
    converted_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * When this introduction stops being claimable.
     *
     * Null means it never expires, which is how every referral behaves today —
     * attribution is permanent. The column is here so an attribution window can
     * be introduced without a migration on a table that by then has history in
     * it; nothing reads it yet.
     */
    expires_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'referrals',
    indexes: [
      /**
       * One referral per (referrer, referred person).
       *
       * The same client following the same realtor's link twice is one
       * introduction, not two, and without this every re-visit would add a row
       * and inflate the funnel the table exists to report. Rows with no
       * referred user yet are not constrained by it — both engines treat NULLs
       * as distinct inside a unique index — which is correct: two anonymous
       * link opens genuinely are two events until one of them becomes a person.
       */
      {
        unique: true,
        fields: ['referrer_id', 'referred_user_id'],
        name: 'ux_referrals_referrer_referred',
      },
      { fields: ['referrer_id', 'status'], name: 'ix_referrals_referrer_status' },
      { fields: ['referred_user_id'], name: 'ix_referrals_referred' },
      { fields: ['company_id'], name: 'ix_referrals_company' },
    ],
  });

  return Referral;
};
