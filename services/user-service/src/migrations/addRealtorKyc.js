/**
 * Realtor KYC submissions — means of identification and proof of address.
 * user-service syncs with { force: false }, so the table is created here.
 * Idempotent.
 */
module.exports = async function addRealtorKyc(sequelize) {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS realtor_kyc (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      id_type ENUM('national_id','drivers_license','passport','voters_card') NOT NULL,
      id_number VARCHAR(255) NOT NULL,
      id_document_url VARCHAR(1024) NOT NULL,
      address_document_type ENUM('utility_bill','bank_statement','tenancy_agreement','other') NOT NULL,
      address_line VARCHAR(255) NULL,
      address_document_url VARCHAR(1024) NOT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      review_notes TEXT NULL,
      reviewed_by INT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      submitted_at DATETIME NULL,
      company_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY realtor_kyc_user (user_id),
      KEY realtor_kyc_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};
