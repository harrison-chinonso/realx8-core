module.exports = (sequelize, DataTypes) => {
  /**
   * A file an admin attaches to an invoice for the buyer to read.
   *
   * Hung off the INVOICE rather than the property or the payment, because the
   * invoice is the only row that already links all three — it knows the client,
   * the property and the purchase behind it — so one attachment reaches every
   * screen without being copied anywhere.
   *
   * Deliberately separate from `property_documents`. Those are the property's
   * own deeds and surveys, staff-only, and shared by everyone who can see the
   * property. These are private to one buyer, and a document becomes visible to
   * them only because somebody chose to attach it. Merging the two would have
   * meant every existing survey becoming client-visible the moment a unit sold.
   */
  const InvoiceDocument = sequelize.define('InvoiceDocument', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    // 1000, matching property_documents: a signed Cloudinary URL is long.
    url: { type: DataTypes.STRING(1000), allowNull: false },
    /**
     * What the buyer is looking at, so a list of eight files is readable.
     * Free-form rather than an ENUM: the vocabulary will grow, and a new value
     * on an enum is the change Postgres refuses to make in place.
     */
    type: { type: DataTypes.STRING, defaultValue: 'other' },
    size: { type: DataTypes.INTEGER.UNSIGNED },
    // Cloudinary public_id, kept so the asset can be deleted with the row and
    // so a download can be served as the original file.
    public_id: { type: DataTypes.STRING },
    uploaded_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'invoice_documents', updatedAt: false });

  return InvoiceDocument;
};
