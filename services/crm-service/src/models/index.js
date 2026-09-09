const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Pipeline = require('./pipeline')(sequelize, DataTypes);
const Stage = require('./stage')(sequelize, DataTypes);
const Source = require('./source')(sequelize, DataTypes);
const Label = require('./label')(sequelize, DataTypes);
const LeadStage = require('./leadStage')(sequelize, DataTypes);
const Lead = require('./lead')(sequelize, DataTypes);
const Deal = require('./deal')(sequelize, DataTypes);
const Task = require('./task')(sequelize, DataTypes);
const TaskStage = require('./taskStage')(sequelize, DataTypes);
const Objection = require('./objection')(sequelize, DataTypes);
const Activity = require('./activity')(sequelize, DataTypes);

Pipeline.hasMany(Stage, { foreignKey: 'pipeline_id', as: 'stages' });
Stage.belongsTo(Pipeline, { foreignKey: 'pipeline_id', as: 'pipeline' });
Lead.belongsTo(Pipeline, { foreignKey: 'pipeline_id', as: 'pipeline' });
Lead.belongsTo(Stage, { foreignKey: 'stage_id', as: 'stage' });
Lead.belongsTo(Source, { foreignKey: 'source_id', as: 'source' });
Lead.belongsTo(Label, { foreignKey: 'label_id', as: 'label' });
Lead.hasMany(Objection, { foreignKey: 'lead_id', as: 'objections', onDelete: 'CASCADE' });
Objection.belongsTo(Lead, { foreignKey: 'lead_id', as: 'lead' });
Lead.hasMany(Activity, { foreignKey: 'lead_id', as: 'activities', onDelete: 'CASCADE' });
Activity.belongsTo(Lead, { foreignKey: 'lead_id', as: 'lead' });
Deal.belongsTo(Pipeline, { foreignKey: 'pipeline_id', as: 'pipeline' });
Deal.belongsTo(Stage, { foreignKey: 'stage_id', as: 'stage' });
Deal.belongsTo(Lead, { foreignKey: 'lead_id', as: 'lead' });
Lead.hasMany(Deal, { foreignKey: 'lead_id', as: 'deals' });
Deal.hasMany(Task, { foreignKey: 'deal_id', as: 'tasks' });
Deal.hasMany(Activity, { foreignKey: 'deal_id', as: 'activities', onDelete: 'CASCADE' });
Lead.hasMany(Task, { foreignKey: 'lead_id', as: 'tasks' });
Task.belongsTo(Deal, { foreignKey: 'deal_id', as: 'deal' });
Activity.belongsTo(Deal, { foreignKey: 'deal_id', as: 'deal' });
Task.belongsTo(Lead, { foreignKey: 'lead_id', as: 'lead' });

module.exports = { sequelize, Pipeline, Stage, Source, Label, LeadStage, Lead, Deal, Task, TaskStage, Objection, Activity };
