module.exports = (sequelize, DataTypes) => {
      const Property = sequelize.define('Property', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT },
type: { type: DataTypes.STRING },
address: { type: DataTypes.STRING },
city: { type: DataTypes.STRING },
state: { type: DataTypes.STRING },
country: { type: DataTypes.STRING },
latitude: { type: DataTypes.STRING, validate: { isLatitude(value) { if (value == null || value === '') return; const n = Number(value); if (!Number.isFinite(n) || n < -90 || n > 90) throw new Error('Latitude must be a number between -90 and 90'); } } },
longitude: { type: DataTypes.STRING, validate: { isLongitude(value) { if (value == null || value === '') return; const n = Number(value); if (!Number.isFinite(n) || n < -180 || n > 180) throw new Error('Longitude must be a number between -180 and 180'); } } },
price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
status: { type: DataTypes.ENUM('draft', 'available', 'reserved', 'sold', 'rented'), defaultValue: 'draft' },
images: { type: DataTypes.JSON },
commission: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
downline_commission: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
// Smallest sellable unit of the property (references property_unit_catalog)
unit_id: { type: DataTypes.INTEGER.UNSIGNED },
// How many of that unit make up this property (e.g. 4 plots)
unit_quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
// Size of ONE unit (e.g. 500), expressed in unit_measurement_unit (e.g. sqm)
unit_measurement: { type: DataTypes.DECIMAL(12, 2) },
unit_measurement_unit: { type: DataTypes.STRING, defaultValue: 'sqm' },
// Public share link
public_token: { type: DataTypes.STRING, unique: true },
public_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
public_expires_at: { type: DataTypes.DATE },
// Approval workflow
approval_status: {
  type: DataTypes.ENUM('pending_review', 'approved', 'rejected', 'revision_requested'),
  defaultValue: 'pending_review',
},
approval_notes: { type: DataTypes.TEXT },
approved_by: { type: DataTypes.INTEGER.UNSIGNED },
approved_at: { type: DataTypes.DATE },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'properties', paranoid: true });

      return Property;
    };
