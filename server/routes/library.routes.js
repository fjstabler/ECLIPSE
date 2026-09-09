import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import * as library from '../library.js';
import { homeRows, recommend, similarTo } from '../nova/engine.js';
import { getFavourites } from '../library.js';
import { listLibraries } from '../libraries.js';
import { isAllowed } from '../parental.js';

export const router = express.Router();

router.use(requireAuth);

/**
 * Every list of titles leaves through here.
 *
 * The rating filter is applied in SQL wherever a query is ours to write, but
 * the home screen is assembled from half a dozen different queries in the
 * recommendation engine, and a child's home screen is the most visible place
 * for a limit to leak. One choke point on the way out is worth more than
 * remembering to add a clause to every future query.
 */
function permitted(items, user) {
  if (!user?.max_rating || !Array.isArray(items)) return items;
  return items.filter((t) => isAllowed(t.certification, user.max_rating));
}

/** The home screen: hero + every shelf, in one round trip. */
router.get('/home', (req, res) => {
  const userId = req.user.id;
  const rows = [];

  const resume = library.continueWatching(userId);
  if (resume.length) rows.push({ id: 'continue', title: 'Continue watching', items: resume });

  // Next up sits directly under Continue watching: together they are "what
  // was I in the middle of" and "what comes after that", which is most of
  // what anyone opens a media server to find out.
  const next = library.nextUp(userId, 18);
  if (next.length) rows.push({ id: 'next-up', title: 'Next up', items: next });

  const watchlist = library.getWatchlist(userId, 18);
  if (watchlist.length) rows.push({ id: 'watchlist', title: 'Your list', items: watchlist });

  const favourites = library.getFavourites(userId, 18);
  if (favourites.length) rows.push({ id: 'favourites', title: 'Your favourites', items: favourites });

  rows.push(...homeRows(userId));

  const beforeFilter = rows.reduce((n, r) => n + r.items.length, 0);
  for (const row of rows) row.items = permitted(row.items, req.user);
  const afterFilter = rows.reduce((n, r) => n + r.items.length, 0);

  // The hero is the strongest N.O.V.A. pick with a backdrop to show behind it.
  const novaRow = rows.find((r) => r.id === 'for-you');
  const heroPool = (novaRow?.items || rows.find((r) => r.items.length)?.items || []).filter((t) => t.backdrop);
  const hero = heroPool[0] ? library.getTitleDetail(heroPool[0].id, userId) : null;

  res.json({
    hero,
    rows: rows.filter((r) => r.items.length),
    // A profile with an age limit on a server whose titles are unrated sees
    // nothing at all, which is the right call and a terrible thing to
    // present as "your library is empty" — that sends someone off to check
    // their folders when the answer is a setting on this profile.
    filteredByRating: afterFilter === 0 && beforeFilter > 0,
  });
});

router.get('/titles', (req, res) => {
  const { kind, genre, q, sort, limit, offset, library: libraryId } = req.query;
  const items = library.listTitles({
    kind: kind || null,
    genre: genre || null,
    search: q || null,
    sort: sort || 'added',
    limit: Math.min(Number(limit) || 60, 200),
    offset: Number(offset) || 0,
    libraryId: Number(libraryId) || null,
    maxRating: req.user.max_rating || null,
  });
  res.json({ items, total: library.countTitles(kind || null) });
});

router.get('/titles/:id', (req, res) => {
  const detail = library.getTitleDetail(Number(req.params.id), req.user.id);
  if (!detail) return res.status(404).json({ error: 'Title not found' });
  // A restricted profile shouldn't be able to reach a blocked title by
  // typing its address either.
  if (!isAllowed(detail.certification, req.user.max_rating)) {
    return res.status(403).json({ error: 'This title is not available on this profile' });
  }
  detail.similar = permitted(similarTo(detail.id, { limit: 12 }), req.user);
  res.json(detail);
});

router.get('/genres', (req, res) => {
  res.json({ genres: library.allGenres() });
});

/**
 * Search across everything the library knows: titles, episodes, the people in
 * them, and the tags they carry.
 *
 * Results come back grouped rather than as one flat list, because "Villeneuve"
 * and "Arrival" are different kinds of answer and flattening them loses the
 * only thing that made the match make sense.
 */
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [], episodes: [], people: [], tags: [] });

  const maxRating = req.user.max_rating || null;
  const like = `%${q}%`;
  const items = library.listTitles({ search: q, limit: 40, maxRating });
  const have = new Set(items.map((i) => i.id));

  // People: matched as people, so the search can say "12 titles with Cillian
  // Murphy" rather than silently mixing them into the title results.
  const people = db
    .prepare(`
      SELECT tt.tag_value AS name, tt.tag_type AS role, COUNT(DISTINCT tt.title_id) AS count,
             MAX(tt.image) AS image
      FROM title_tags tt
      WHERE tt.tag_type IN ('cast','director','creator','writer') AND tt.tag_value LIKE ?
      GROUP BY tt.tag_value, tt.tag_type
      ORDER BY count DESC LIMIT 12
    `)
    .all(like);

  for (const row of db
    .prepare(`
      SELECT DISTINCT t.id FROM titles t JOIN title_tags tt ON tt.title_id = t.id
      WHERE tt.tag_type IN ('cast','director','creator','writer') AND tt.tag_value LIKE ?
      LIMIT 24
    `)
    .all(like)) {
    if (have.has(row.id)) continue;
    const t = library.getTitle(row.id);
    if (t && isAllowed(t.certification, maxRating)) {
      items.push(t);
      have.add(t.id);
    }
  }

  // Episodes by their own name — "Ozymandias" should find the episode, not
  // just leave you to guess which season it was in.
  const episodes = db
    .prepare(`
      SELECT e.id, e.season, e.number, e.name, e.still, e.overview,
             t.id AS title_id, t.title AS series, t.certification
      FROM episodes e JOIN titles t ON t.id = e.title_id
      WHERE e.name LIKE ? ORDER BY t.sort_title, e.season, e.number LIMIT 16
    `)
    .all(like)
    .filter((e) => isAllowed(e.certification, maxRating))
    .map((e) => ({
      id: e.id, titleId: e.title_id, series: e.series, season: e.season,
      number: e.number, name: e.name, still: e.still, overview: e.overview,
    }));

  // Genres, studios, collections and keywords, so a search doubles as a way
  // of browsing sideways.
  const tags = db
    .prepare(`
      SELECT tag_type AS type, tag_value AS value, COUNT(*) AS count
      FROM title_tags
      WHERE tag_type IN ('genre','studio','collection','keyword') AND tag_value LIKE ?
      GROUP BY tag_type, tag_value ORDER BY count DESC LIMIT 12
    `)
    .all(like)
    .map((t) => ({ type: t.type, value: t.value, count: t.count }));

  res.json({
    items: items.slice(0, 48),
    episodes,
    people: people.map((p) => ({ name: p.name, role: p.role, count: p.count, image: p.image })),
    tags,
  });
});

/** Everything featuring one person, for the page behind a cast photo. */
router.get('/people/:name', (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Who?' });

  const rows = db
    .prepare(`
      SELECT DISTINCT tt.title_id AS id, tt.tag_type AS role, tt.image
      FROM title_tags tt
      WHERE tt.tag_type IN ('cast','director','creator','writer') AND tt.tag_value = ? COLLATE NOCASE
    `)
    .all(name);

  if (!rows.length) return res.status(404).json({ error: 'Nobody by that name is in this library' });

  const maxRating = req.user.max_rating || null;
  const titles = rows
    .map((r) => ({ ...library.getTitle(r.id), role: r.role }))
    .filter((t) => t.id && isAllowed(t.certification, maxRating))
    .sort((a, b) => (b.year || 0) - (a.year || 0));

  res.json({
    name,
    image: rows.find((r) => r.image)?.image || null,
    roles: [...new Set(rows.map((r) => r.role))],
    titles,
  });
});

router.get('/recommendations', (req, res) => {
  res.json({
    items: permitted(recommend(req.user.id, {
      limit: Math.min(Number(req.query.limit) || 20, 40),
      kind: req.query.kind || null,
    }), req.user),
  });
});

router.get('/titles/:id/similar', (req, res) => {
  res.json({ items: permitted(similarTo(Number(req.params.id), { limit: 12 }), req.user) });
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

/** Favourites — separate from My List, and used by N.O.V.A. as a strong signal. */
router.post('/titles/:id/favourite', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT 1 FROM favourites WHERE user_id = ? AND title_id = ?').get(req.user.id, id);
  if (existing) {
    db.prepare('DELETE FROM favourites WHERE user_id = ? AND title_id = ?').run(req.user.id, id);
    return res.json({ favourite: false });
  }
  db.prepare('INSERT INTO favourites (user_id, title_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ favourite: true });
});

router.get('/favourites', (req, res) => {
  res.json({ items: permitted(getFavourites(req.user.id), req.user) });
});

router.get('/libraries', (req, res) => {
  // The viewer-facing list: what to browse, not what to administer.
  res.json({
    libraries: listLibraries({ includeCounts: true })
      .filter((l) => l.enabled)
      .map((l) => ({ id: l.id, name: l.name, kind: l.kind, titles: l.titles })),
  });
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
  res.json({ items: permitted(library.getWatchlist(req.user.id, 100), req.user) });
});

router.get('/history', (req, res) => {
  res.json({ items: permitted(library.watchHistory(req.user.id, 100), req.user) });
});
