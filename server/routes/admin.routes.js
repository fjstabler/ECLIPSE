import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { runScan, scanStatus } from '../scanner/scanner.js';
import { libraryStats, listTitles, getTitle } from '../library.js';
import { hasTmdb, searchMovieCandidates, searchSeriesCandidates } from '../metadata/tmdb.js';
import { novaAvailable } from '../nova/openai.js';
import { sortTitle } from '../util/parse.js';
import { cacheImage } from '../metadata/artwork.js';
import { listLibraries, createLibrary, updateLibrary, deleteLibrary } from '../libraries.js';
import { createBackup, listBackups, backupPath } from '../backup.js';
import { activeSessions, listDevices, endSession, transcodeCount } from '../media/sessions.js';
import { detectHardware } from '../media/transcode.js';
import { recentLogs, logCounts, log } from '../log.js';
import { serverHealth } from '../health.js';
import { RATING_LADDER } from '../parental.js';

export const router = express.Router();
router.use(requireAdmin);

router.get('/status', async (req, res) => {
  const hardware = config.ffmpeg.enabled ? await detectHardware() : null;

  res.json({
    stats: libraryStats(),
    libraries: listLibraries({ includeCounts: true }),
    scan: scanStatus(),
    health: serverHealth(),
    sessions: activeSessions(),
    devices: listDevices(),
    logs: logCounts(),
    integrations: {
      tmdb: hasTmdb(),
      nova: novaAvailable(),
      transcode: config.ffmpeg.enabled,
      watching: config.scanner.watch,
      hardware: hardware?.available ? hardware.label : hardware ? hardware.label : 'Transcoding disabled',
      hardwareAvailable: Boolean(hardware?.available),
      transcodesRunning: transcodeCount(),
      maxTranscodes: config.ffmpeg.maxSessions,
    },
    lastScans: db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 5').all(),
  });
});

// --- libraries --------------------------------------------------------------

router.get('/libraries', (req, res) => {
  res.json({ libraries: listLibraries({ includeCounts: true }) });
});

router.post('/libraries', (req, res) => {
  try {
    res.json(createLibrary(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/libraries/:id', (req, res) => {
  try {
    res.json(updateLibrary(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/libraries/:id', (req, res) => {
  try {
    deleteLibrary(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- what's happening right now ---------------------------------------------

router.get('/sessions', (req, res) => {
  res.json({ sessions: activeSessions(), devices: listDevices() });
});

/** Stop a stream from the admin page — the "who is pinning the CPU" button. */
router.delete('/sessions/:id', (req, res) => {
  endSession(req.params.id);
  log.info('admin', `${req.user.display_name} stopped a playback session`);
  res.json({ ok: true });
});

router.get('/logs', (req, res) => {
  const level = ['info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
  res.json({ logs: recentLogs({ level, limit: Math.min(500, Number(req.query.limit) || 200) }) });
});

router.patch('/devices/:id', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A device needs a name' });
  // renamed = 1 stops the next connection overwriting it with a sniffed name.
  db.prepare('UPDATE devices SET name = ?, renamed = 1 WHERE id = ?').run(name, Number(req.params.id));
  res.json({ ok: true, name });
});

router.delete('/devices/:id', (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/** Kick off a scan. Returns immediately — poll /status for progress. */
router.post('/scan', (req, res) => {
  const full = Boolean(req.body?.full);
  const status = scanStatus();
  if (status.scanning) return res.status(409).json({ error: 'A scan is already running', scan: status });

  runScan({ full })
    .then((r) => console.log('[scan] finished', r))
    .catch((err) => console.error('[scan] failed', err));

  res.json({ started: true });
});

/** Titles the metadata provider couldn't match — the ones worth fixing by hand. */
router.get('/unmatched', (req, res) => {
  const rows = db
    .prepare("SELECT id, kind, title, year FROM titles WHERE metadata_state = 'unmatched' ORDER BY title LIMIT 200")
    .all();
  const withFiles = rows.map((r) => ({
    ...r,
    files: db.prepare('SELECT filename FROM media_files WHERE title_id = ? LIMIT 3').all(r.id).map((f) => f.filename),
  }));
  res.json({ items: withFiles });
});

/** Search TMDB by name, for the "pick the right one" list in the edit modal. */
router.get('/tmdb-search', async (req, res) => {
  const kind = req.query.kind === 'series' ? 'series' : 'movie';
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  if (!hasTmdb()) return res.status(503).json({ error: 'No TMDB API key is configured' });

  try {
    const items = kind === 'movie' ? await searchMovieCandidates(q) : await searchSeriesCandidates(q);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Point a title at a specific TMDB id when the automatic match got it wrong. */
router.post('/titles/:id/match', async (req, res) => {
  const id = Number(req.params.id);
  const tmdbId = Number(req.body?.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId is required' });

  const title = db.prepare('SELECT * FROM titles WHERE id = ?').get(id);
  if (!title) return res.status(404).json({ error: 'Title not found' });
  if (!hasTmdb()) return res.status(503).json({ error: 'No TMDB API key is configured' });

  try {
    const tmdb = await import('../metadata/tmdb.js');
    const { cacheImage } = await import('../metadata/artwork.js');
    const meta = title.kind === 'movie' ? await tmdb.movieDetails(tmdbId) : await tmdb.seriesDetails(tmdbId);

    meta.poster = await cacheImage(meta.poster);
    meta.backdrop = await cacheImage(meta.backdrop);
    meta.logo = await cacheImage(meta.logo);

    db.prepare(`
      UPDATE titles SET title=?, original_title=?, year=?, overview=?, tagline=?, runtime=?, rating=?,
        certification=?, status=?, poster=?, backdrop=?, logo=?, trailer_url=?, tmdb_id=?, imdb_id=?,
        metadata_state='manual', updated_at=datetime('now')
      WHERE id = ?
    `).run(
      meta.title, meta.originalTitle, meta.year, meta.overview, meta.tagline, meta.runtime, meta.rating,
      meta.certification, meta.status, meta.poster, meta.backdrop, meta.logo, meta.trailerUrl,
      meta.tmdbId, meta.imdbId, id
    );

    db.prepare('DELETE FROM title_tags WHERE title_id = ?').run(id);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO title_tags (title_id, tag_type, tag_value, weight, ordering) VALUES (?, ?, ?, ?, ?)'
    );
    for (const t of meta.tags || []) insert.run(id, t.type, t.value, t.weight, t.ordering);

    res.json({ ok: true, title: db.prepare('SELECT * FROM titles WHERE id = ?').get(id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Edit a title's metadata by hand — title, year, overview, artwork, genres.
 * Marks the title 'manual' so a future scan won't overwrite what was typed
 * in, the same protection re-matching against TMDB already gets.
 */
router.patch('/titles/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM titles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Title not found' });

  const b = req.body || {};
  const next = { ...existing };

  if (typeof b.title === 'string') {
    const trimmed = b.title.trim();
    if (!trimmed) return res.status(400).json({ error: 'Title cannot be empty' });
    next.title = trimmed;
  }
  if ('year' in b) next.year = b.year === '' || b.year == null ? null : Number(b.year) || null;
  if (typeof b.overview === 'string') next.overview = b.overview.trim() || null;
  if (typeof b.tagline === 'string') next.tagline = b.tagline.trim() || null;
  if (typeof b.certification === 'string') next.certification = b.certification.trim() || null;
  if (typeof b.status === 'string') next.status = b.status.trim() || null;

  // Only re-cache artwork when the URL actually changed — cacheImage() is a
  // network fetch, and a save shouldn't re-download an image that's already
  // sitting in the cache under the same address.
  if (typeof b.poster === 'string' && b.poster.trim() !== (existing.poster || '')) {
    next.poster = b.poster.trim() ? await cacheImage(b.poster.trim()) : null;
  }
  if (typeof b.backdrop === 'string' && b.backdrop.trim() !== (existing.backdrop || '')) {
    next.backdrop = b.backdrop.trim() ? await cacheImage(b.backdrop.trim()) : null;
  }

  db.prepare(`
    UPDATE titles SET
      title=@title, sort_title=@sort_title, year=@year, overview=@overview, tagline=@tagline,
      certification=@certification, status=@status, poster=@poster, backdrop=@backdrop,
      metadata_state='manual', updated_at=datetime('now')
    WHERE id=@id
  `).run({ ...next, sort_title: sortTitle(next.title), id });

  if (Array.isArray(b.genres)) {
    db.prepare("DELETE FROM title_tags WHERE title_id = ? AND tag_type = 'genre'").run(id);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO title_tags (title_id, tag_type, tag_value, weight, ordering) VALUES (?, ?, ?, ?, ?)'
    );
    b.genres.forEach((g, i) => {
      const value = String(g).trim();
      if (value) insert.run(id, 'genre', value, 1, i);
    });
  }

  res.json({ ok: true, title: getTitle(id) });
});

router.get('/users', (req, res) => {
  const users = db
    .prepare('SELECT id, username, display_name, avatar_color, is_admin, is_kids, max_rating, pin_hash IS NOT NULL AS has_pin, created_at FROM users ORDER BY id')
    .all();
  res.json({ users });
});

/** Age limit and kids flag for a profile. */
router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const patch = req.body || {};
  const allowed = [null, ...RATING_LADDER];
  if (patch.maxRating !== undefined) {
    const value = patch.maxRating || null;
    if (!allowed.includes(value)) return res.status(400).json({ error: 'That is not a rating ECLIPSE knows' });
    db.prepare('UPDATE users SET max_rating = ? WHERE id = ?').run(value, id);
  }
  if (patch.isKids !== undefined) {
    db.prepare('UPDATE users SET is_kids = ? WHERE id = ?').run(patch.isKids ? 1 : 0, id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete the profile you are signed in as' });
  const remainingAdmins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?').get(id).n;
  if (remainingAdmins === 0) return res.status(400).json({ error: 'That is the last administrator' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- backups ----------------------------------------------------------------

router.get('/backups', (req, res) => {
  res.json({ backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    res.json(await createBackup());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Hand a backup over so it can be kept somewhere other than this machine —
 * a backup that only exists on the disk that fails is not a backup.
 */
router.get('/backups/:name', (req, res) => {
  const file = backupPath(req.params.name);
  if (!file) return res.status(404).json({ error: 'No backup by that name' });
  res.download(file);
});
