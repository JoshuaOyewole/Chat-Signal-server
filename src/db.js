const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — see README\'s "Account setup" section.');
  }
  // Neon (and most hosted Postgres) require TLS; node-postgres needs this
  // explicitly since the connection string's own sslmode=require query param
  // isn't honored by the driver the way psql honors it.
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
