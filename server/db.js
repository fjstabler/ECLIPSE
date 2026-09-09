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

// Everything the deeper file inspection added. Existing rows keep whatever
// they had; probe_version defaulting to 0 is what makes the next scan re-read
// them with the current prober rather than leaving them half-described.
for (const [column, ddl] of [
  ['container', 'container TEXT'],
  ['bitrate', 'bitrate INTEGER'],
  ['video_bitrate', 'video_bitrate INTEGER'],
  ['frame_rate', 'frame_rate REAL'],
  ['bit_depth', 'bit_depth INTEGER'],
  ['pixel_format', 'pixel_format TEXT'],
  ['color_space', 'color_space TEXT'],
  ['color_transfer', 'color_transfer TEXT'],
  ['color_primaries', 'color_primaries TEXT'],
  ['hdr_format', 'hdr_format TEXT'],
  ['aspect_ratio', 'aspect_ratio TEXT'],
  ['video_profile', 'video_profile TEXT'],
  ['stream_count', 'stream_count INTEGER'],
  ['probe_version', 'probe_version INTEGER NOT NULL DEFAULT 0'],
]) {
  ensureColumn('media_files', column, ddl);
}

// Which library a file came from. Nullable: a file scanned before libraries
// existed still belongs to the library whose folder it sits under, and the
// next scan fills that in.
ensureColumn('media_files', 'library_id', 'library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE');

// Profiles grew: a picture, a PIN, and a rating ceiling for the children's one.
for (const [column, ddl] of [
  ['avatar_image', 'avatar_image TEXT'],
  ['pin_hash', 'pin_hash TEXT'],
  ['pin_salt', 'pin_salt TEXT'],
  ['max_rating', 'max_rating TEXT'],
]) {
  ensureColumn('users', column, ddl);
}

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
