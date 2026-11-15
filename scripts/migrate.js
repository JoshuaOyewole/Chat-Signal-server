#!/usr/bin/env node
// Runs every migrations/*.sql file, in filename order, against DATABASE_URL.
// Safe to re-run — each file uses CREATE ... IF NOT EXISTS.
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');

async function main() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pool = getPool();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log('Running migration:', file);
    await pool.query(sql);
  }
  console.log(`Done — ${files.length} migration(s) applied.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
