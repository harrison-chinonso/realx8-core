const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const logger = require('./logger');
const DB_DIALECT = (process.env.DB_DIALECT || 'mysql').toLowerCase();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  dialect: DB_DIALECT,
  logging: false,
  define: {
    underscored: true,
    freezeTableName: false,
  },
  // Managed MySQL (Aiven, PlanetScale, etc.) requires TLS. rejectUnauthorized
  // is false because we are not pinning the provider's CA bundle here — this
  // still encrypts the connection, it just does not verify the server
  // certificate chain. Fine for development/demo; pin the CA for production.
  //
  // Neon specifically also needs the `endpoint` startup option: its proxy
  // routes each connection to the right compute by reading the hostname from
  // TLS SNI, and some network paths (observed on Render) do not carry SNI
  // through, which surfaces as "Endpoint ID is not specified" on connect.
  // Passing it explicitly sidesteps SNI entirely — see https://neon.tech/sni.
  // Harmless to derive for any host: it is only sent as a Postgres startup
  // option, which non-Neon servers simply do not look at.
  dialectOptions: /^true$/i.test(process.env.DB_SSL || '')
    ? {
      ssl: { require: true, rejectUnauthorized: false },
      ...(process.env.DB_DIALECT || '').toLowerCase() === 'postgres' && /\.neon\.tech$/.test(process.env.DB_HOST || '')
        ? { options: `endpoint=${(process.env.DB_HOST || '').split('.')[0]}` }
        : {},
    }
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
  if (dbConfig.dialect === 'mysql') {
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      ssl: dbConfig.dialectOptions.ssl,
    });

    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
    await connection.end();
  }
  await sequelize.authenticate();
  logger.info(`Connected to ${dbConfig.database}`);
};

module.exports = { sequelize, connectDatabase };
