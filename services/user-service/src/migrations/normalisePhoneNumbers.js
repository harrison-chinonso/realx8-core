const { QueryTypes } = require('sequelize');

/**
 * Cleans the whitespace and punctuation out of stored phone numbers.
 *
 * The column accumulated values like "0814 543 9255 " — spaces and a trailing
 * space — because nothing ever normalised on write. Login now compares
 * significant digits so those rows can sign in regardless, but leaving the text
 * dirty means every future comparison pays for the cleanup, and the number
 * displays badly everywhere it is shown.
 *
 * Conservative on purpose: only whitespace and formatting punctuation are
 * removed, and a leading + is kept. No number is reinterpreted, no country code
 * is added or removed — a row that is genuinely wrong ("234" is in there as
 * somebody's phone) stays wrong rather than being guessed at.
 */
module.exports = async (sequelize) => {
  try {
    const [, affected] = await sequelize.query(
      `UPDATE users
          SET phone = CASE
                WHEN TRIM(phone) LIKE '+%'
                  THEN CONCAT('+', REGEXP_REPLACE(phone, '[^0-9]', ''))
                ELSE REGEXP_REPLACE(phone, '[^0-9]', '')
              END
        WHERE phone IS NOT NULL
          AND phone <> ''
          -- Only rows that would actually change, so a clean database does no
          -- writes and this stays cheap on every boot.
          AND phone <> CASE
                WHEN TRIM(phone) LIKE '+%'
                  THEN CONCAT('+', REGEXP_REPLACE(phone, '[^0-9]', ''))
                ELSE REGEXP_REPLACE(phone, '[^0-9]', '')
              END`,
      { type: QueryTypes.UPDATE },
    );
    if (affected) console.log(`[phone] normalised ${affected} stored number(s)`);
  } catch (error) {
    // A formatting cleanup must never stop the service booting.
    console.error('[phone] normalisation skipped:', error.message);
  }
};
