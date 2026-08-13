import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import * as library from '../library.js';
import { homeRows, recommend, similarTo } from '../nova/engine.js';

export const router = express.Router();

router.use(requireAuth);

/** The home screen: hero + every shelf, in one round trip. */
router.get('/home', (req, res) => {
  const userId = req.user.id;
  const rows = [];

  const resume = library.continueWatching(userId);
  if (resume.length) rows.push({ id: 'continue', title: 'Continue watching', items: resume });

  const watchlist = library.getWatchlist(userId, 18);
  if (watchlist.length) rows.push({ id: 'watchlist', title: 'Your list', items: watchlist });

  rows.push(...homeRows(userId));

  // The hero is the strongest N.O.V.A. pick with a backdrop to show behind it.
  const novaRow = rows.find((r) => r.id === 'for-you');
  const heroPool = (novaRow?.items || rows[0]?.items || []).filter((t) => t.backdrop);
  const hero = heroPool[0] ? library.getTitleDetail(heroPool[0].id, userId) : null;

  res.json({ hero, rows: rows.filter((r) => r.items.length) });
});

router.get('/titles', (req, res) => {
  const { kind, genre, q, sort, limit, offset } = req.query;
  const items = library.listTitles({
    kind: kind || null,
    genre: genre || null,
    search: q || null,
    sort: sort || 'added',
    limit: Math.min(Number(limit) || 60, 200),
    offset: Number(offset) || 0,
  });
  res.json({ items, total: library.countTitles(kind || null) });
});

router.get('/titles/:id', (req, res) => {
  const detail = library.getTitleDetail(Number(req.params.id), req.user.id);
  if (!detail) return res.status(404).json({ error: 'Title not found' });
  detail.similar = similarTo(detail.id, { limit: 12 });
  res.json(detail);
});

router.get('/genres', (req, res) => {
  res.json({ genres: library.allGenres() });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const items = library.listTitles({ search: q, limit: 40 });

  // Also match on people, so "Villeneuve" or "Cillian Murphy" finds things.
  const byPerson = db
    .prepare(`
      SELECT DISTINCT t.id FROM titles t JOIN title_tags tt ON tt.title_id = t.id
      WHERE tt.tag_type IN ('cast','director','creator','writer') AND tt.tag_value LIKE ?
      LIMIT 24
    `)
    .all(`%${q}%`);

  const have = new Set(items.map((i) => i.id));
  for (const row of byPerson) {
    if (have.has(row.id)) continue;
    const t = library.getTitle(row.id);
    if (t) items.push(t);
  }

  res.json({ items: items.slice(0, 48) });
});

router.get('/recommendations', (req, res) => {
  res.json({
    items: recommend(req.user.id, {
      limit: Math.min(Number(req.query.limit) || 20, 40),
      kind: req.query.kind || null,
    }),
  });
});

router.get('/titles/:id/similar', (req, res) => {
  res.json({ items: similarTo(Number(req.params.id), { limit: 12 }) });
});

// --- viewer actions ---------------------------------------------------------

router.post('/titles/:id/rate', (req, res) => {
  const titleId = Number(req.params.id);
  const score = Number(req.body.score);
  if (![-1, 0, 1, 2].includes(score)) return res.status(400).json({ error: 'score must be -1, 0, 1 or 2' });

  if (score === 0) {
    db.prepare('DELETE FROM ratings WHERE user_id = ? AND title_id = ?').run(req.user.id, titleId);
  } else {
    db.prepare(`
      INSERT INTO ratings (user_id, title_id, score) VALUES (?, ?, ?)
      ON CONFLICT(user_id, title_id) DO UPDATE SET score = excluded.score, created_at = datetime('now')
    `).run(req.user.id, titleId, score);
  }
  res.json({ ok: true, score });
});

router.post('/titles/:id/watchlist', (req, res) => {
  const titleId = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND title_id = ?').get(req.user.id, titleId);
  if (exists) {
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND title_id = ?').run(req.user.id, titleId);
    return res.json({ inWatchlist: false });
  }
  db.prepare('INSERT INTO watchlist (user_id, title_id) VALUES (?, ?)').run(req.user.id, titleId);
  res.json({ inWatchlist: true });
});

router.get('/watchlist', (req, res) => {
  res.json({ items: library.getWatchlist(req.user.id, 100) });
});

router.get('/history', (req, res) => {
  res.json({ items: library.watchHistory(req.user.id, 100) });
});
