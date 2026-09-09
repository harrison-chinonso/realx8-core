/**
 * Idempotent seed for the property unit catalog (`property_unit_catalog`).
 * These are the "lowest unit" options a property can be measured in.
 *
 * Matching is alias-aware and case-insensitive so we don't create near-duplicates
 * ("Square Metre" vs an existing "Square Meter"). Existing rows are never
 * modified, so admin-added and admin-renamed units survive restarts.
 */
const CATALOG = [
  { name: 'Plot', symbol: 'plot', default: true, aliases: ['plot', 'plots'] },
  { name: 'Acre', symbol: 'ac', default: false, aliases: ['acre', 'acres'] },
  { name: 'Hectare', symbol: 'ha', default: false, aliases: ['hectare', 'hectares'] },
  { name: 'Square Metre', symbol: 'sqm', default: false, aliases: ['square metre', 'square meter', 'sqm', 'sq m', 'square metres', 'square meters'] },
  { name: 'Square Foot', symbol: 'sqft', default: false, aliases: ['square foot', 'square feet', 'sqft', 'sq ft'] },
];

module.exports = async function seedUnitCatalog(PropertyUnit) {
  const existing = await PropertyUnit.findAll({ attributes: ['name'] });
  const existingNames = new Set(existing.map((row) => String(row.name).trim().toLowerCase()));

  for (const { aliases, ...unit } of CATALOG) {
    if (aliases.some((alias) => existingNames.has(alias))) continue;
    try {
      await PropertyUnit.create(unit);
      existingNames.add(unit.name.toLowerCase());
    } catch (error) {
      // A concurrent boot of another replica may win the race — that is fine.
      if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
    }
  }
};
