import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Copies of the database, taken while the server is running.
 *
 * The media on disk can always be re-scanned and the artwork re-fetched, so
 * the database is the only part of an ECLIPSE install that cannot be
 * rebuilt: every profile and PIN, what each person has watched and how far
 * in, their ratings, lists, favourites and taste profiles, the library
 * configuration, and every conversation with N.O.V.A.
 *
 * It has to be SQLite's own backup rather than a file copy. The database
 * runs in WAL mode, so at any moment recent writes live in a separate -wal
 * file; copying eclipse.db on its own captures a database missing whatever
 * had not been checkpointed yet, and copying all three by hand can catch
 * them mid-write. The backup API takes a consistent snapshot of a live
 * database, which is the one way to do this safely without stopping the
 * server.
 */

const KEEP = 7;

function backupDir() {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createBackup() {
  const dir = backupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `eclipse-${stamp}.db`);

  await db.backup(file);
  prune();

  const { size } = fs.statSync(file);
  log.info('backup', `Database backed up to ${path.basename(file)}`, `${size} bytes`);
  return { file, name: path.basename(file), size, created: new Date().toISOString() };
}

/** Oldest first out, so a nightly backup can't quietly fill the disk. */
function prune() {
  const dir = backupDir();
  for (const old of listBackups().slice(KEEP)) {
    // Anything that opens a backup leaves -wal and -shm files beside it, and
    // deleting only the .db strands those for good — a 32 KB leak per
    // inspected backup, forever, in the folder meant to be self-limiting.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(path.join(dir, old.name + suffix));
      } catch {
        // Missing sidecars are the normal case; a backup that can't be
        // deleted is not worth failing the backup over.
      }
    }
  }

  // Sidecars whose backup has already gone — left behind by an earlier
  // version of this, or by anything that opened a backup after it was
  // pruned. Nothing else will ever name them, so this is their only sweep.
  const present = new Set(fs.readdirSync(dir));
  for (const name of present) {
    const base = name.replace(/-(wal|shm)$/, '');
    if (base !== name && !present.has(base)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
    }
  }
}

export function listBackups() {
  const dir = backupDir();
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('eclipse-') && n.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

export function backupPath(name) {
  // Only ever a name this module would have written, so a request can't walk
  // out of the backup folder and read something else.
  if (!/^eclipse-[\dTZ:.-]+\.db$/.test(name)) return null;
  const file = path.join(backupDir(), name);
  return fs.existsSync(file) ? file : null;
}

/**
 * A backup a day, on a server that is meant to run unattended.
 *
 * Nobody remembers to take one by hand, and the moment it matters — a
 * container rebuilt with the wrong volume, a disk that went — is the moment
 * it is too late to start.
 */
export function startScheduledBackups() {
  const hours = config.backup.intervalHours;
  if (!hours || hours <= 0) return null;

  const run = () => createBackup().catch((err) => log.warn('backup', 'Scheduled backup failed', err.message));

  // One shortly after boot, so a fresh install has a backup from day one
  // rather than after the first full interval.
  const first = setTimeout(run, 60_000);
  first.unref();

  const timer = setInterval(run, hours * 3600_000);
  timer.unref();
  console.log(`[backup] backing the database up every ${hours} hour${hours === 1 ? '' : 's'}, keeping the last ${KEEP}`);
  return timer;
}
