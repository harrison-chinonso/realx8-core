/**
 * Single source of truth for the property Excel columns, shared by the export,
 * the bulk-upload template, and the importer — so a column can never drift
 * between the sheet a user downloads and the sheet the importer expects.
 *
 * The Company Code column exists only for superior admins: everyone else is
 * pinned to their own company, so letting them name a company would be a
 * tenancy hole rather than a convenience.
 */

const STATUSES = ['draft', 'available', 'reserved', 'sold', 'rented'];
const MEASUREMENT_UNITS = ['sqm', 'sqft', 'hectares', 'acres', 'plots'];

// `key` is the Property attribute; `header` is what the user sees in Excel.
const IMPORT_COLUMNS = [
  { key: 'name', header: 'Name', width: 28, required: true, example: 'Lekki Gardens Phase 2' },
  { key: 'type', header: 'Type', width: 16, example: 'Land' },
  { key: 'description', header: 'Description', width: 40, example: 'Serviced plots with C of O.' },
  { key: 'address', header: 'Address', width: 28, example: '12 Admiralty Way' },
  { key: 'city', header: 'City', width: 16, example: 'Lekki' },
  { key: 'state', header: 'State', width: 16, example: 'Lagos' },
  { key: 'country', header: 'Country', width: 16, example: 'Nigeria' },
  { key: 'latitude', header: 'Latitude', width: 14, example: 6.524379 },
  { key: 'longitude', header: 'Longitude', width: 14, example: 3.379206 },
  { key: 'price', header: 'Price', width: 16, example: 25000000 },
  { key: 'status', header: 'Status', width: 14, example: 'available' },
  { key: 'unit_name', header: 'Unit Name', width: 20, example: 'Standard Plot' },
  { key: 'unit_measurement', header: 'Property Size', width: 14, example: 500 },
  { key: 'unit_measurement_unit', header: 'Measured In', width: 14, example: 'sqm' },
  { key: 'unit_quantity', header: 'Quantity', width: 12, example: 4 },
];

// The sheet carries the company's 5-character code (referral_code), not the
// internal table id — codes are stable, human-checkable, and already shared.
const COMPANY_COLUMN = {
  key: 'company_code', header: 'Company Code', width: 16, required: true, example: 'AB12C',
};

// Read-only context, useful in an export but meaningless as import input.
const EXPORT_ONLY_COLUMNS = [
  { key: 'id', header: 'ID', width: 8 },
  { key: 'approval_status', header: 'Approval Status', width: 18 },
  { key: 'created_at', header: 'Created At', width: 22 },
];

const importColumns = (isSuperiorAdmin) =>
  isSuperiorAdmin ? [...IMPORT_COLUMNS, COMPANY_COLUMN] : [...IMPORT_COLUMNS];

const exportColumns = (isSuperiorAdmin) => [
  EXPORT_ONLY_COLUMNS[0],
  ...importColumns(isSuperiorAdmin),
  ...EXPORT_ONLY_COLUMNS.slice(1),
];

/** Excel gives us strings, numbers, or rich-text/formula objects. Flatten to a scalar. */
const cellValue = (cell) => {
  const value = cell?.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    if (value.text !== undefined) return value.text;
    if (value.result !== undefined) return value.result;
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value instanceof Date) return value;
    return null;
  }
  return value;
};

const asString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

const asNumber = (value, label, errors) => {
  const text = asString(value);
  if (text === null) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) {
    errors.push(`${label} must be a number (got "${text}")`);
    return null;
  }
  return number;
};

/**
 * Turns one spreadsheet row into a validated Property payload.
 * Returns { payload, errors } — errors is empty when the row is usable.
 */
const rowToProperty = (values, { isSuperiorAdmin, companyId }) => {
  const errors = [];
  const payload = {};

  payload.name = asString(values.name);
  if (!payload.name) errors.push('Name is required');

  for (const field of ['type', 'description', 'address', 'city', 'state', 'country']) {
    payload[field] = asString(values[field]);
  }

  const latitude = asNumber(values.latitude, 'Latitude', errors);
  if (latitude !== null && (latitude < -90 || latitude > 90)) errors.push('Latitude must be between -90 and 90');
  payload.latitude = latitude === null ? null : String(latitude);

  const longitude = asNumber(values.longitude, 'Longitude', errors);
  if (longitude !== null && (longitude < -180 || longitude > 180)) errors.push('Longitude must be between -180 and 180');
  payload.longitude = longitude === null ? null : String(longitude);

  const price = asNumber(values.price, 'Price', errors);
  if (price !== null && price < 0) errors.push('Price cannot be negative');
  payload.price = price ?? 0;

  const status = asString(values.status)?.toLowerCase() ?? null;
  if (status && !STATUSES.includes(status)) {
    errors.push(`Status must be one of: ${STATUSES.join(', ')}`);
  }
  payload.status = status || 'draft';

  const size = asNumber(values.unit_measurement, 'Property Size', errors);
  if (size !== null && size < 0) errors.push('Property Size cannot be negative');
  payload.unit_measurement = size;
  // Optional label for the unit configuration this row creates.
  payload.unit_name = asString(values.unit_name);

  const measuredIn = asString(values.unit_measurement_unit)?.toLowerCase() ?? null;
  if (measuredIn && !MEASUREMENT_UNITS.includes(measuredIn)) {
    errors.push(`Measured In must be one of: ${MEASUREMENT_UNITS.join(', ')}`);
  }
  payload.unit_measurement_unit = measuredIn || 'sqm';

  const quantity = asNumber(values.unit_quantity, 'Quantity', errors);
  if (quantity !== null && (quantity < 0 || !Number.isInteger(quantity))) {
    errors.push('Quantity must be a whole number');
  }
  payload.unit_quantity = quantity ?? 0;

  if (isSuperiorAdmin) {
    // Held as a code here; the controller resolves codes to ids in one query so
    // it can report unknown codes per row.
    const code = asString(values.company_code);
    if (code === null) errors.push('Company Code is required');
    else payload.company_code = code.toUpperCase();
  } else {
    // Non-superior admins are pinned to their own company, whatever the sheet says.
    payload.company_id = companyId;
  }

  return { payload, errors };
};

module.exports = {
  STATUSES,
  MEASUREMENT_UNITS,
  importColumns,
  exportColumns,
  cellValue,
  rowToProperty,
};
