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
  // ── TLS to the database ──────────────────────────────────────────────────
  //
  // rejectUnauthorized used to be false here, with the note that this "still
  // encrypts the connection, it just does not verify the server certificate
  // chain". Both halves are true and together they are the problem: encryption
  // without authentication stops a passive listener and does nothing about an
  // active one. Anything on the path can present any certificate, and it gets
  // the whole database — every tenant's rows, in both directions, invisibly.
  //
  // Production is Neon over the public internet (render.yaml sets DB_SSL=true),
  // which is exactly the network where that matters, and Neon's certificate is
  // issued by a publicly trusted CA — so verification needs no configuration,
  // only for it to be switched on.
  //
  // DB_SSL_CA names a PEM bundle for a provider with a private CA.
  // DB_SSL_INSECURE=true restores the old behaviour for a local server with a
  // self-signed certificate; it is named for what it does so that nobody sets
  // it in production without reading the word.
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
      ssl: {
        require: true,
        rejectUnauthorized: !/^true$/i.test(process.env.DB_SSL_INSECURE || ''),
        ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}),
      },
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
