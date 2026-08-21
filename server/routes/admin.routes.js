import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { runScan, scanStatus } from '../scanner/scanner.js';
import { libraryStats, listTitles, getTitle } from '../library.js';
import { hasTmdb } from '../metadata/tmdb.js';
import { novaAvailable } from '../nova/openai.js';
import { sortTitle } from '../util/parse.js';
import { cacheImage } from '../metadata/artwork.js';

export const router = express.Router();
router.use(requireAdmin);

router.get('/status', (req, res) => {
  const libs = [
    ...config.libraries.movies.map((p) => ({ kind: 'movies', path: p, exists: fs.existsSync(p) })),
    ...config.libraries.series.map((p) => ({ kind: 'series', path: p, exists: fs.existsSync(p) })),
  ];

  res.json({
    stats: libraryStats(),
    libraries: libs,
    scan: scanStatus(),
    integrations: {
      tmdb: hasTmdb(),
      nova: novaAvailable(),
      transcode: config.ffmpeg.enabled,
      watching: config.scanner.watch,
    },
    lastScans: db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 5').all(),
  });
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
    .prepare('SELECT id, username, display_name, avatar_color, is_admin, is_kids, created_at FROM users ORDER BY id')
    .all();
  res.json({ users });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete the profile you are signed in as' });
  const remainingAdmins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?').get(id).n;
  if (remainingAdmins === 0) return res.status(400).json({ error: 'That is the last administrator' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});
