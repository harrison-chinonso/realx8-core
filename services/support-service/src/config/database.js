const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const logger = require('./logger');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  dialect: 'mysql',
  logging: false,
  define: {
    underscored: true,
    freezeTableName: false,
  },
  // Managed MySQL (Aiven, PlanetScale, etc.) requires TLS. rejectUnauthorized
  // is false because we are not pinning the provider's CA bundle here — this
  // still encrypts the connection, it just does not verify the server
  // certificate chain. Fine for development/demo; pin the CA for production.
  dialectOptions: /^true$/i.test(process.env.DB_SSL || '')
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
};

const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  logging: dbConfig.logging,
  define: dbConfig.define,
  dialectOptions: dbConfig.dialectOptions,
});

const connectDatabase = async () => {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.dialectOptions.ssl,
  });

  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
  await connection.end();
  await sequelize.authenticate();
  logger.info(`Connected to ${dbConfig.database}`);
};

module.exports = { sequelize, connectDatabase };
