import { db } from './db.js';

/**
 * Server events worth being able to look back at.
 *
 * Everything still goes to the console — that's what `docker compose logs`
 * shows — but the last few thousand entries also land in the database so the
 * admin page can answer "why did that scan fail" without anyone needing shell
 * access to the box it runs on.
 */

const MAX_ROWS = 2000;
let sinceTrim = 0;

const insert = db.prepare('INSERT INTO server_log (level, scope, message, detail) VALUES (?, ?, ?, ?)');

function write(level, scope, message, detail) {
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    insert.run(level, scope, String(message).slice(0, 2000), detail ? String(detail).slice(0, 4000) : null);
    // Trimming on every write would mean a delete on every log line; every
    // hundredth keeps the table bounded without the churn.
    if (++sinceTrim >= 100) {
      sinceTrim = 0;
      db.prepare(
        'DELETE FROM server_log WHERE id NOT IN (SELECT id FROM server_log ORDER BY id DESC LIMIT ?)'
      ).run(MAX_ROWS);
    }
  } catch {
    // Logging must never be the thing that breaks a request.
  }
}

export const log = {
  info: (scope, message, detail) => write('info', scope, message, detail),
  warn: (scope, message, detail) => write('warn', scope, message, detail),
  error: (scope, message, detail) => write('error', scope, message, detail),
};

export function recentLogs({ level = null, limit = 200 } = {}) {
  const rows = level
    ? db.prepare('SELECT * FROM server_log WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit)
    : db.prepare('SELECT * FROM server_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: r.id, level: r.level, scope: r.scope, message: r.message, detail: r.detail, at: r.created_at,
  }));
}

export function logCounts() {
  const rows = db.prepare("SELECT level, COUNT(*) AS n FROM server_log WHERE created_at > datetime('now', '-24 hours') GROUP BY level").all();
  const out = { info: 0, warn: 0, error: 0 };
  for (const r of rows) out[r.level] = r.n;
  return out;
}
