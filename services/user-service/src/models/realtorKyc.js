module.exports = (sequelize, DataTypes) => {
  const RealtorKyc = sequelize.define('RealtorKyc', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    // Means of identification
    id_type: {
      type: DataTypes.ENUM('national_id', 'drivers_license', 'passport', 'voters_card'),
      allowNull: false,
    },
    id_number: { type: DataTypes.STRING, allowNull: false },
    id_document_url: { type: DataTypes.STRING, allowNull: false },

    // Proof of address
    address_document_type: {
      type: DataTypes.ENUM('utility_bill', 'bank_statement', 'tenancy_agreement', 'other'),
      allowNull: false,
    },
    address_line: { type: DataTypes.STRING },
    address_document_url: { type: DataTypes.STRING, allowNull: false },

    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    review_notes: { type: DataTypes.TEXT },
    reviewed_by: { type: DataTypes.INTEGER.UNSIGNED },
    reviewed_at: { type: DataTypes.DATE },
    submitted_at: { type: DataTypes.DATE },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'realtor_kyc' });

  return RealtorKyc;
};
