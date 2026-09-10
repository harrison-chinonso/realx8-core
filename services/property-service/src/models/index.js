const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Property = require('./property')(sequelize, DataTypes);
const PropertyType = require('./propertyType')(sequelize, DataTypes);
const PropertyUnit = require('./propertyUnit')(sequelize, DataTypes);
const PropertyUnits = require('./propertyUnits')(sequelize, DataTypes);
const PropertyPlots = require('./propertyPlots')(sequelize, DataTypes);
const PropertyUnitsPlots = require('./propertyUnitsPlots')(sequelize, DataTypes);
const PropertyAmenity = require('./propertyAmenity')(sequelize, DataTypes);
const PropertyDocument = require('./propertyDocument')(sequelize, DataTypes);
const Inspection = require('./inspection')(sequelize, DataTypes);
const PurchaseRequest = require('./purchaseRequest')(sequelize, DataTypes);
// Inventory actually secured by an approved payment (FRD 10). Availability is
// no longer derived from purchase requests — see the model for why.
const PropertyUnitHold = require('./propertyUnitHold')(sequelize, DataTypes);

Property.belongsTo(PropertyUnit, { foreignKey: 'unit_id', as: 'lowestUnit' });
Property.hasMany(PropertyUnits, { foreignKey: 'property_id', as: 'units' });
Property.hasMany(PropertyPlots, { foreignKey: 'property_id', as: 'plots' });
Property.hasMany(PropertyAmenity, { foreignKey: 'property_id', as: 'amenities' });
Property.hasMany(PropertyUnitsPlots, { foreignKey: 'property_id', as: 'unitPlots' });
Property.hasMany(PropertyDocument, { foreignKey: 'property_id', as: 'documents' });
Property.hasMany(Inspection, { foreignKey: 'property_id', as: 'inspections' });
Property.hasMany(PurchaseRequest, { foreignKey: 'property_id', as: 'purchaseRequests' });
PurchaseRequest.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });
PropertyUnits.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });
PropertyUnits.hasMany(PropertyUnitHold, { foreignKey: 'property_unit_id', as: 'holds' });
PropertyUnitHold.belongsTo(PropertyUnits, { foreignKey: 'property_unit_id', as: 'unit' });
Property.hasMany(PropertyUnitHold, { foreignKey: 'property_id', as: 'unitHolds' });
PropertyPlots.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });
PropertyAmenity.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });
PropertyDocument.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });
Inspection.belongsTo(Property, { foreignKey: 'property_id', as: 'property' });

module.exports = {
  sequelize,
  Property,
  PropertyType,
  PropertyUnit,
  PropertyUnits,
  PropertyPlots,
  PropertyUnitsPlots,
  PropertyAmenity,
  PropertyDocument,
  Inspection,
  PurchaseRequest,
  PropertyUnitHold,
};
