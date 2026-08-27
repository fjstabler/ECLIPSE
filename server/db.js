import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths, ensureDataDirs } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureDataDirs();

export const db = new Database(paths.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight column migrations for databases created before a column
// existed — `CREATE TABLE IF NOT EXISTS` above only helps fresh installs.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('title_tags', 'image', 'image TEXT');

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// The session secret is generated once and kept in the database so restarts
// don't sign everyone out. An explicit env var always wins.
export function sessionSecret() {
  if (config.session.secret) return config.session.secret;
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    setSetting('session_secret', secret);
  }
  return secret;
}

export function isFirstRun() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row.n === 0;
}

export function transaction(fn) {
  return db.transaction(fn);
}
