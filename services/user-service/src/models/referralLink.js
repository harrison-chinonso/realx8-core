module.exports = (sequelize, DataTypes) => {
  /**
   * The short code behind a referral link.
   *
   * ── Why the link stopped being self-contained ────────────────────────────
   *
   * A share link used to carry a sealed AES-GCM token holding the company, the
   * realtor code and a snapshot of the company's branding. That made the URL
   * around two hundred characters — long enough that people were reluctant to
   * paste it into WhatsApp, and long enough to look suspicious when they did.
   *
   * Most of that length was the branding snapshot, which the resolver barely
   * used: it prefers the company's LIVE settings so that a rebrand reaches
   * links already in circulation, and falls back to the snapshot only when a
   * setting is missing. So the payload was being carried in every URL to serve
   * a case that almost never arises.
   *
   * The row below replaces it. The link carries a short code, and the code is
   * looked up here — which is both shorter and strictly more capable, because a
   * row can be revoked and a sealed token cannot.
   *
   * ── Why this is a table and not only a cache entry ───────────────────────
   *
   * Resolution reads through a cache, so the steady state costs no query. The
   * row is what makes the link DURABLE: a referral link lives in someone's chat
   * history for months, and if the mapping existed only in Redis then a restart
   * or an eviction would quietly turn every link ever shared into a dead one.
   * A cache is the right place for the answer and the wrong place for the
   * record.
   */
  const ReferralLink = sequelize.define('ReferralLink', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },

    /**
     * The code as it appears in the URL.
     *
     * Case-insensitive in practice — it is stored and compared upper-cased,
     * because these get read aloud, written down and retyped.
     */
    code: { type: DataTypes.STRING(12), allowNull: false, unique: true },

    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    /**
     * Null for a company sign-up link, set for a realtor's personal one.
     *
     * The code rather than the user id, so the row says what the link means
     * without a join, and so attribution keeps working exactly as it did when
     * the codes travelled in the query string.
     */
    realtor_code: { type: DataTypes.STRING(5), allowNull: true },

    /**
     * Set for a link to ONE property, null for a sign-up link.
     *
     * A shared property used to travel as `/p/<48 hex characters>?ref=<code>` —
     * two identifiers, one of them long enough that people hesitated to paste
     * it. A property link is now a code in this table like any other, so the
     * URL is `/p/<code>` and resolving it yields the property, the company AND
     * the realtor in one lookup.
     *
     * Deliberately NOT a second table. Two independently generated
     * seven-character namespaces would eventually mint the same code twice, and
     * `/p/K7M2QXV` would then mean whichever table happened to be consulted
     * first. One table is one namespace.
     */
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /**
     * Revoking a link without deleting the row.
     *
     * Deleting would free the code to be handed out again, and a code that
     * once pointed at one realtor must never later point at another — the old
     * link is still in somebody's chat history.
     */
    revoked_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'referral_links',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['code'], name: 'ux_referral_links_code' },
      /**
       * One code per (company, realtor, property), so minting is idempotent.
       *
       * A realtor asking for their link twice must get the SAME code — they
       * print it, put it in a bio, and read it out. Without this a second call
       * would quietly issue a second code and the first would look abandoned.
       *
       * ── On the null columns in this key ──────────────────────────────────
       *
       * Both engines treat NULLs as distinct inside a unique index, so this
       * index does not by itself stop a second company-level row. It never did:
       * what makes minting idempotent is the read-first path in
       * shared/src/shareLinkGateway.js, which uses null-SAFE equality so the
       * existing row is actually found. The index is the backstop for the
       * concurrent case where both columns are set.
       */
      {
        unique: true,
        fields: ['company_id', 'realtor_code', 'property_id'],
        name: 'ux_referral_links_company_realtor_property',
      },
    ],
  });

  return ReferralLink;
};
