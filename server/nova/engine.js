import { db } from '../db.js';
import { decorate } from '../library.js';

/**
 * NOVA's local recommendation engine.
 *
 * Content-based, and deliberately so: a home server has one household on it,
 * not a million users, so collaborative filtering has nothing to collaborate
 * with. Instead we build a weighted taste vector out of three signals —
 * the profile the user filled in, what they actually watched, and how they
 * rated it — and score every unwatched title in the library against it.
 *
 * This runs with no API key. The Claude layer in claude.js sits on top and
 * explains the results conversationally; it does not replace them.
 */

// How much each tag type contributes. Directors and genres are strong signals;
// a studio credit barely means anything.
const TYPE_WEIGHTS = {
  genre: 1.0,
  director: 0.9,
  creator: 0.9,
  cast: 0.5,
  keyword: 0.45,
  writer: 0.4,
  studio: 0.15,
};

// How much each source of evidence counts toward the taste vector.
const SOURCE_WEIGHTS = {
  loved: 3.0,      // rated "love"
  liked: 2.0,      // thumbs up
  completed: 1.4,  // watched to the end
  started: 0.5,    // started but didn't finish
  profile: 2.5,    // explicitly stated in the taste profile
  disliked: -2.5,  // thumbs down
};

export function getTasteProfile(userId) {
  let row = db.prepare('SELECT * FROM taste_profiles WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO taste_profiles (user_id) VALUES (?)').run(userId);
    row = db.prepare('SELECT * FROM taste_profiles WHERE user_id = ?').get(userId);
  }
  return {
    about: row.about || '',
    likedGenres: safeJson(row.liked_genres),
    dislikedGenres: safeJson(row.disliked_genres),
    favouritePeople: safeJson(row.favourite_people),
    moods: safeJson(row.moods),
    avoid: safeJson(row.avoid),
    updatedAt: row.updated_at,
  };
}

export function saveTasteProfile(userId, profile) {
  const current = getTasteProfile(userId);
  const merged = {
    about: profile.about ?? current.about,
    likedGenres: profile.likedGenres ?? current.likedGenres,
    dislikedGenres: profile.dislikedGenres ?? current.dislikedGenres,
    favouritePeople: profile.favouritePeople ?? current.favouritePeople,
    moods: profile.moods ?? current.moods,
    avoid: profile.avoid ?? current.avoid,
  };
  db.prepare(`
    INSERT INTO taste_profiles (user_id, about, liked_genres, disliked_genres, favourite_people, moods, avoid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      about = excluded.about, liked_genres = excluded.liked_genres,
      disliked_genres = excluded.disliked_genres, favourite_people = excluded.favourite_people,
      moods = excluded.moods, avoid = excluded.avoid, updated_at = datetime('now')
  `).run(
    userId,
    merged.about,
    JSON.stringify(merged.likedGenres),
    JSON.stringify(merged.dislikedGenres),
    JSON.stringify(merged.favouritePeople),
    JSON.stringify(merged.moods),
    JSON.stringify(merged.avoid)
  );
  return getTasteProfile(userId);
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tagKey(type, value) {
  return `${type}:${value.toLowerCase()}`;
}

/**
 * Build the weighted tag vector describing what this user likes.
 * Returns { vector: Map<tagKey, weight>, seen: Set<titleId>, evidence: [...] }
 */
export function buildTasteVector(userId) {
  const vector = new Map();
  const seen = new Set();
  const evidence = [];

  const add = (type, value, weight) => {
    const key = tagKey(type, value);
    vector.set(key, (vector.get(key) || 0) + weight);
  };

  // 1. The explicit profile.
  const profile = getTasteProfile(userId);
  for (const g of profile.likedGenres) add('genre', g, SOURCE_WEIGHTS.profile * TYPE_WEIGHTS.genre);
  for (const g of profile.dislikedGenres) add('genre', g, SOURCE_WEIGHTS.disliked * TYPE_WEIGHTS.genre);
  for (const p of profile.favouritePeople) {
    add('cast', p, SOURCE_WEIGHTS.profile * TYPE_WEIGHTS.cast);
    add('director', p, SOURCE_WEIGHTS.profile * TYPE_WEIGHTS.director);
  }
  for (const k of profile.moods) add('keyword', k, SOURCE_WEIGHTS.profile * TYPE_WEIGHTS.keyword);
  for (const a of profile.avoid) {
    add('genre', a, SOURCE_WEIGHTS.disliked * TYPE_WEIGHTS.genre);
    add('keyword', a, SOURCE_WEIGHTS.disliked * TYPE_WEIGHTS.keyword);
  }

  // 2. Ratings — the clearest signal we have.
  const ratings = db
    .prepare('SELECT r.title_id, r.score, t.title FROM ratings r JOIN titles t ON t.id = r.title_id WHERE r.user_id = ?')
    .all(userId);

  for (const r of ratings) {
    seen.add(r.title_id);
    const source = r.score === 2 ? SOURCE_WEIGHTS.loved : r.score === 1 ? SOURCE_WEIGHTS.liked : SOURCE_WEIGHTS.disliked;
    applyTitleTags(r.title_id, source, add);
    evidence.push({ titleId: r.title_id, title: r.title, reason: r.score > 0 ? 'rated up' : 'rated down', weight: source });
  }

  // 3. Watch history.
  const watched = db
    .prepare(`
      SELECT ps.title_id, MAX(ps.completed) AS completed, t.title,
             MAX(ps.position) AS position, MAX(ps.duration) AS duration
      FROM playback_state ps JOIN titles t ON t.id = ps.title_id
      WHERE ps.user_id = ?
      GROUP BY ps.title_id
    `)
    .all(userId);

  for (const w of watched) {
    seen.add(w.title_id);
    if (ratings.some((r) => r.title_id === w.title_id)) continue; // rating already counted
    const finished = w.completed === 1 || (w.duration > 0 && w.position / w.duration > 0.9);
    const source = finished ? SOURCE_WEIGHTS.completed : SOURCE_WEIGHTS.started;
    applyTitleTags(w.title_id, source, add);
    evidence.push({ titleId: w.title_id, title: w.title, reason: finished ? 'watched' : 'started', weight: source });
  }

  return { vector, seen, evidence, profile };
}

const tagsForTitle = db.prepare('SELECT tag_type, tag_value, weight FROM title_tags WHERE title_id = ?');

function applyTitleTags(titleId, sourceWeight, add) {
  for (const t of tagsForTitle.all(titleId)) {
    const typeWeight = TYPE_WEIGHTS[t.tag_type];
    if (!typeWeight) continue;
    add(t.tag_type, t.tag_value, sourceWeight * typeWeight * t.weight);
  }
}

/**
 * Score every candidate title against the taste vector.
 * Returns rows sorted best-first with a human-readable explanation attached.
 */
export function recommend(userId, { limit = 20, kind = null, excludeSeen = true, includeReasons = true, pool = null } = {}) {
  const { vector, seen, profile } = buildTasteVector(userId);

  const params = [];
  let sql = `SELECT id, kind, title, year, overview, tagline, runtime, rating, certification, status,
                    poster, backdrop, logo, trailer_url, tmdb_id, metadata_state, added_at
             FROM titles`;
  const where = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (pool?.length) {
    where.push(`id IN (${pool.map(() => '?').join(',')})`);
    params.push(...pool);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;

  const candidates = db.prepare(sql).all(...params);
  if (!candidates.length) return [];

  // A cold-start user has no vector at all; fall back to what's good and new.
  const coldStart = vector.size === 0;

  const scored = [];
  for (const row of candidates) {
    if (excludeSeen && seen.has(row.id)) continue;

    const tags = tagsForTitle.all(row.id);
    let score = 0;
    const hits = [];

    for (const t of tags) {
      const typeWeight = TYPE_WEIGHTS[t.tag_type];
      if (!typeWeight) continue;
      const v = vector.get(tagKey(t.tag_type, t.tag_value));
      if (!v) continue;
      const contribution = v * typeWeight * t.weight;
      score += contribution;
      if (contribution > 0) hits.push({ type: t.tag_type, value: t.tag_value, contribution });
    }

    // Normalise so a title with 25 keywords doesn't automatically beat a
    // tightly-tagged one; then fold in quality and freshness as gentle nudges.
    const tagCount = Math.max(tags.length, 1);
    score = score / Math.sqrt(tagCount);

    if (row.rating) score += (row.rating - 6.5) * 0.35;

    const ageDays = (Date.now() - new Date(row.added_at + 'Z').getTime()) / 86400_000;
    if (Number.isFinite(ageDays) && ageDays < 30) score += 0.4 * (1 - ageDays / 30);

    if (coldStart) score += (row.rating || 5) * 0.5;

    hits.sort((a, b) => b.contribution - a.contribution);

    scored.push({
      row,
      score,
      hits: hits.slice(0, 4),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => ({
    ...decorate(s.row),
    score: Number(s.score.toFixed(3)),
    reason: includeReasons ? explain(s.hits, profile, coldStart) : undefined,
    matchedOn: s.hits.map((h) => h.value),
  }));
}

function explain(hits, profile, coldStart) {
  if (coldStart) return 'Highly rated and recently added — tell NOVA what you like to sharpen this.';
  if (!hits.length) return 'A change of pace from your usual picks.';

  const byType = {};
  for (const h of hits) (byType[h.type] ||= []).push(h.value);

  const parts = [];
  if (byType.genre) parts.push(byType.genre.slice(0, 2).join(' and '));
  if (byType.director) parts.push(`directed by ${byType.director[0]}`);
  if (byType.creator) parts.push(`from ${byType.creator[0]}`);
  if (byType.cast) parts.push(`starring ${byType.cast.slice(0, 2).join(' and ')}`);
  if (!parts.length && byType.keyword) parts.push(byType.keyword.slice(0, 2).join(', '));

  const lead = parts.join(', ');
  return lead ? `Because you like ${lead}.` : 'Close to what you have been watching.';
}

/**
 * "More like this" — similarity between one title and the rest of the library.
 * Used both by the title page and by NOVA when the user names a film.
 */
export function similarTo(titleId, { limit = 12, excludeIds = [] } = {}) {
  const seedTags = tagsForTitle.all(titleId);
  if (!seedTags.length) return [];

  const seedVector = new Map();
  for (const t of seedTags) {
    const typeWeight = TYPE_WEIGHTS[t.tag_type];
    if (!typeWeight) continue;
    seedVector.set(tagKey(t.tag_type, t.tag_value), typeWeight * t.weight);
  }

  const seed = db.prepare('SELECT kind, year FROM titles WHERE id = ?').get(titleId);
  const exclude = new Set([titleId, ...excludeIds]);

  const candidates = db
    .prepare(`
      SELECT id, kind, title, year, overview, tagline, runtime, rating, certification, status,
             poster, backdrop, logo, trailer_url, tmdb_id, metadata_state, added_at
      FROM titles
    `)
    .all();

  const scored = [];
  for (const row of candidates) {
    if (exclude.has(row.id)) continue;
    const tags = tagsForTitle.all(row.id);
    let dot = 0;
    let norm = 0;
    const hits = [];

    for (const t of tags) {
      const typeWeight = TYPE_WEIGHTS[t.tag_type];
      if (!typeWeight) continue;
      const w = typeWeight * t.weight;
      norm += w * w;
      const seedWeight = seedVector.get(tagKey(t.tag_type, t.tag_value));
      if (seedWeight) {
        dot += seedWeight * w;
        hits.push({ type: t.tag_type, value: t.tag_value, contribution: seedWeight * w });
      }
    }

    if (dot <= 0) continue;
    let similarity = dot / Math.sqrt(norm || 1);

    // Same medium and a similar era feel more "like this" than a raw tag match.
    if (row.kind === seed.kind) similarity *= 1.15;
    if (seed.year && row.year && Math.abs(seed.year - row.year) <= 8) similarity *= 1.08;

    hits.sort((a, b) => b.contribution - a.contribution);
    scored.push({ row, similarity, hits: hits.slice(0, 3) });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit).map((s) => ({
    ...decorate(s.row),
    score: Number(s.similarity.toFixed(3)),
    matchedOn: s.hits.map((h) => h.value),
    reason: `Shares ${s.hits.map((h) => h.value).slice(0, 2).join(' and ')} with this.`,
  }));
}

/**
 * The rows on the home screen. Everything is derived from the same engine so
 * the shelves stay consistent with what NOVA would say.
 */
export function homeRows(userId, { rowSize = 18 } = {}) {
  const rows = [];
  const { seen } = buildTasteVector(userId);

  const picks = recommend(userId, { limit: rowSize });
  if (picks.length) rows.push({ id: 'for-you', title: 'Picked for you by NOVA', kind: 'nova', items: picks });

  const recent = db
    .prepare(`
      SELECT id, kind, title, year, overview, tagline, runtime, rating, certification, status,
             poster, backdrop, logo, trailer_url, tmdb_id, metadata_state, added_at
      FROM titles ORDER BY added_at DESC, id DESC LIMIT ?
    `)
    .all(rowSize);
  if (recent.length) rows.push({ id: 'recent', title: 'Recently added', items: recent.map(decorate) });

  // "Because you watched X" — seeded from the most recent thing they finished.
  const lastFinished = db
    .prepare(`
      SELECT ps.title_id, t.title FROM playback_state ps JOIN titles t ON t.id = ps.title_id
      WHERE ps.user_id = ? ORDER BY ps.updated_at DESC LIMIT 1
    `)
    .get(userId);
  if (lastFinished) {
    const similar = similarTo(lastFinished.title_id, { limit: rowSize });
    if (similar.length) {
      rows.push({ id: `because-${lastFinished.title_id}`, title: `Because you watched ${lastFinished.title}`, items: similar });
    }
  }

  // Genre shelves, biggest genres first, excluding what they've already seen.
  const genres = db
    .prepare(`
      SELECT tag_value AS name, COUNT(*) AS n FROM title_tags
      WHERE tag_type = 'genre' GROUP BY tag_value HAVING n >= 2 ORDER BY n DESC LIMIT 6
    `)
    .all();

  for (const g of genres) {
    const items = db
      .prepare(`
        SELECT t.id, t.kind, t.title, t.year, t.overview, t.tagline, t.runtime, t.rating, t.certification,
               t.status, t.poster, t.backdrop, t.logo, t.trailer_url, t.tmdb_id, t.metadata_state, t.added_at
        FROM titles t JOIN title_tags tt ON tt.title_id = t.id
        WHERE tt.tag_type = 'genre' AND tt.tag_value = ?
        ORDER BY t.rating DESC NULLS LAST, t.added_at DESC LIMIT ?
      `)
      .all(g.name, rowSize);
    if (items.length >= 2) rows.push({ id: `genre-${g.name}`, title: g.name, genre: g.name, items: items.map(decorate) });
  }

  // Something completely different: good titles that scored *low* against the
  // taste vector. Only worth a shelf when the library is big enough that these
  // are genuinely different from the picks above, rather than the same list
  // in reverse.
  const totalTitles = db.prepare('SELECT COUNT(*) AS n FROM titles').get().n;
  if (totalTitles >= rowSize * 2.5) {
    const ranked = recommend(userId, { limit: totalTitles });
    const topIds = new Set(picks.map((p) => p.id));
    const wildcards = ranked
      .filter((t) => !topIds.has(t.id) && !seen.has(t.id))
      .slice(-rowSize)
      .reverse();
    if (wildcards.length >= 4) {
      rows.push({ id: 'wildcard', title: 'Something different', items: wildcards });
    }
  }

  return rows;
}

/** A one-paragraph summary of taste NOVA can read as context. */
export function tasteSummary(userId) {
  const { vector, profile, evidence } = buildTasteVector(userId);

  const top = [...vector.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, weight]) => {
      const [type, ...rest] = key.split(':');
      return { type, value: rest.join(':'), weight: Number(weight.toFixed(2)) };
    });

  const avoided = [...vector.entries()]
    .filter(([, w]) => w < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 6)
    .map(([key]) => key.split(':').slice(1).join(':'));

  return {
    profile,
    topSignals: top,
    avoiding: avoided,
    recentEvidence: evidence.slice(0, 12),
    watchedCount: evidence.length,
  };
}
