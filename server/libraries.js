import fs from 'node:fs';
import { db } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Libraries — the named groups of folders a scan walks.
 *
 * Two kinds live side by side. The ones described by ECLIPSE_MOVIES_DIR and
 * ECLIPSE_SERIES_DIR are re-synced from the environment on every boot, so a
 * Docker user editing their .env still sees the change take effect. Anything
 * added through the admin page belongs to the household and is never
 * overwritten by configuration.
 */

export function syncConfigLibraries() {
  upsertConfigLibrary('Films', 'movies', config.libraries.movies);
  upsertConfigLibrary('Series', 'series', config.libraries.series);
}

function upsertConfigLibrary(name, kind, paths) {
  const existing = db.prepare("SELECT * FROM libraries WHERE name = ? AND source = 'config'").get(name);

  if (!paths.length) {
    // The environment no longer names any folder for this library. Removing
    // the row would orphan whatever it scanned, so it's disabled instead —
    // the titles stay, and re-adding the path brings it back.
    if (existing) db.prepare('UPDATE libraries SET enabled = 0, paths = ? WHERE id = ?').run('[]', existing.id);
    return;
  }

  if (existing) {
    db.prepare('UPDATE libraries SET kind = ?, paths = ?, enabled = 1 WHERE id = ?')
      .run(kind, JSON.stringify(paths), existing.id);
  } else {
    db.prepare("INSERT INTO libraries (name, kind, paths, source) VALUES (?, ?, ?, 'config')")
      .run(name, kind, JSON.stringify(paths));
  }
}

export function listLibraries({ includeCounts = false } = {}) {
  const rows = db.prepare('SELECT * FROM libraries ORDER BY source DESC, id').all();
  return rows.map((row) => {
    const paths = parsePaths(row.paths);
    const library = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      paths,
      enabled: row.enabled === 1,
      source: row.source,
      scannedAt: row.scanned_at,
      // A path that stopped existing is the single most common reason a
      // library "went empty", so it's surfaced rather than left to guesswork.
      missingPaths: paths.filter((p) => !fs.existsSync(p)),
    };
    if (includeCounts) {
      library.titles = db
        .prepare('SELECT COUNT(DISTINCT title_id) AS n FROM media_files WHERE library_id = ?')
        .get(row.id).n;
      library.files = db.prepare('SELECT COUNT(*) AS n FROM media_files WHERE library_id = ?').get(row.id).n;
      library.bytes = db
        .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM media_files WHERE library_id = ?')
        .get(row.id).n;
    }
    return library;
  });
}

export function getLibrary(id) {
  const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, paths: parsePaths(row.paths), enabled: row.enabled === 1 };
}

export function createLibrary({ name, kind, paths }) {
  const clean = cleanInput({ name, kind, paths });
  const info = db
    .prepare("INSERT INTO libraries (name, kind, paths, source) VALUES (?, ?, ?, 'user')")
    .run(clean.name, clean.kind, JSON.stringify(clean.paths));
  log.info('library', `Added library "${clean.name}" (${clean.kind}, ${clean.paths.length} folder(s))`);
  return getLibrary(info.lastInsertRowid);
}

export function updateLibrary(id, patch) {
  const existing = getLibrary(id);
  if (!existing) throw new Error('That library does not exist');
  if (existing.source === 'config' && (patch.paths || patch.name || patch.kind)) {
    throw new Error('This library is defined by the server configuration — change ECLIPSE_MOVIES_DIR or ECLIPSE_SERIES_DIR instead');
  }

  const clean = cleanInput({
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    paths: patch.paths ?? existing.paths,
  });
  const enabled = patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0;

  db.prepare('UPDATE libraries SET name = ?, kind = ?, paths = ?, enabled = ? WHERE id = ?')
    .run(clean.name, clean.kind, JSON.stringify(clean.paths), enabled, id);
  return getLibrary(id);
}

/**
 * Removing a library drops what it scanned, because those titles only existed
 * as a description of files it was pointed at. The files on disk are never
 * touched — ECLIPSE reads media, it does not own it.
 */
export function deleteLibrary(id) {
  const existing = getLibrary(id);
  if (!existing) throw new Error('That library does not exist');
  if (existing.source === 'config') {
    throw new Error('This library is defined by the server configuration and cannot be removed here');
  }

  db.prepare('DELETE FROM media_files WHERE library_id = ?').run(id);
  db.exec(`
    DELETE FROM episodes WHERE id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL);
    DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM media_files WHERE title_id IS NOT NULL);
    DELETE FROM seasons WHERE id NOT IN (SELECT season_id FROM episodes WHERE season_id IS NOT NULL);
  `);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  log.info('library', `Removed library "${existing.name}" and the titles it had scanned`);
  return true;
}

/** Every folder a scan should walk, with the library each one belongs to. */
export function scanTargets() {
  const targets = [];
  for (const library of listLibraries()) {
    if (!library.enabled) continue;
    for (const root of library.paths) {
      targets.push({ root, kind: library.kind === 'movies' ? 'movie' : 'series', libraryId: library.id });
    }
  }
  return targets;
}

export function markScanned(libraryIds) {
  const stmt = db.prepare("UPDATE libraries SET scanned_at = datetime('now') WHERE id = ?");
  for (const id of libraryIds) stmt.run(id);
}

function parsePaths(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : [];
  } catch {
    return [];
  }
}

function cleanInput({ name, kind, paths }) {
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw new Error('A library needs a name');
  if (!['movies', 'series'].includes(kind)) throw new Error('A library is either movies or series');

  const list = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('A library needs at least one folder');

  return { name: cleanName, kind, paths: list };
}
