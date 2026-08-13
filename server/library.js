import { db } from './db.js';

/**
 * Shared read model for the library. Both the HTTP API and NOVA's tools go
 * through here so they can never disagree about what's in the library.
 */

const TITLE_COLUMNS = `
  t.id, t.kind, t.title, t.year, t.overview, t.tagline, t.runtime, t.rating,
  t.certification, t.status, t.poster, t.backdrop, t.logo, t.trailer_url,
  t.tmdb_id, t.metadata_state, t.added_at
`;

export function getTitle(id) {
  const row = db.prepare(`SELECT ${TITLE_COLUMNS} FROM titles t WHERE t.id = ?`).get(id);
  if (!row) return null;
  return decorate(row);
}

export function decorate(row) {
  if (!row) return null;
  const tags = db
    .prepare('SELECT tag_type, tag_value, weight FROM title_tags WHERE title_id = ? ORDER BY ordering')
    .all(row.id);

  const grouped = {};
  for (const t of tags) {
    (grouped[t.tag_type] ||= []).push(t.tag_value);
  }

  return {
    ...row,
    genres: grouped.genre || [],
    keywords: grouped.keyword || [],
    cast: grouped.cast || [],
    directors: grouped.director || [],
    creators: grouped.creator || [],
    writers: grouped.writer || [],
    studios: grouped.studio || [],
  };
}

export function listTitles({ kind = null, genre = null, search = null, sort = 'added', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = {};

  if (kind) {
    where.push('t.kind = @kind');
    params.kind = kind;
  }
  if (search) {
    where.push('(t.title LIKE @search OR t.original_title LIKE @search OR t.overview LIKE @search)');
    params.search = `%${search}%`;
  }
  if (genre) {
    where.push(
      "t.id IN (SELECT title_id FROM title_tags WHERE tag_type = 'genre' AND tag_value = @genre COLLATE NOCASE)"
    );
    params.genre = genre;
  }

  const orderBy = {
    added: 't.added_at DESC, t.id DESC',
    title: 't.sort_title ASC',
    year: 't.year DESC NULLS LAST, t.sort_title ASC',
    rating: 't.rating DESC NULLS LAST, t.sort_title ASC',
  }[sort] || 't.added_at DESC';

  params.limit = limit;
  params.offset = offset;

  const rows = db
    .prepare(`
      SELECT ${TITLE_COLUMNS} FROM titles t
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `)
    .all(params);

  return rows.map(decorate);
}

export function countTitles(kind = null) {
  if (kind) return db.prepare('SELECT COUNT(*) AS n FROM titles WHERE kind = ?').get(kind).n;
  return db.prepare('SELECT COUNT(*) AS n FROM titles').get().n;
}

export function allGenres() {
  return db
    .prepare(`
      SELECT tag_value AS name, COUNT(*) AS count
      FROM title_tags WHERE tag_type = 'genre'
      GROUP BY tag_value ORDER BY count DESC, name ASC
    `)
    .all();
}

/** Full detail for a title page: files, seasons, episodes, per-user progress. */
export function getTitleDetail(id, userId) {
  const title = getTitle(id);
  if (!title) return null;

  if (title.kind === 'movie') {
    const files = db
      .prepare(`
        SELECT f.*, ps.position, ps.completed
        FROM media_files f
        LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
        WHERE f.title_id = ? AND f.episode_id IS NULL
        ORDER BY f.size DESC
      `)
      .all(userId ?? -1, id);
    title.files = files.map(publicFile);
    title.primaryFile = title.files[0] || null;
  } else {
    const seasons = db.prepare('SELECT * FROM seasons WHERE title_id = ? ORDER BY number').all(id);
    const episodes = db
      .prepare(`
        SELECT e.*, f.id AS file_id, f.duration AS file_duration, f.direct_play, f.extension,
               ps.position, ps.completed
        FROM episodes e
        LEFT JOIN media_files f ON f.episode_id = e.id
        LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
        WHERE e.title_id = ?
        ORDER BY e.season, e.number
      `)
      .all(userId ?? -1, id);

    title.seasons = seasons.map((s) => ({
      ...s,
      episodes: episodes
        .filter((e) => e.season === s.number)
        .map((e) => ({
          id: e.id,
          season: e.season,
          number: e.number,
          name: e.name,
          overview: e.overview,
          still: e.still,
          airDate: e.air_date,
          runtime: e.runtime || (e.file_duration ? Math.round(e.file_duration / 60) : null),
          fileId: e.file_id,
          directPlay: e.direct_play === 1,
          position: e.position || 0,
          completed: e.completed === 1,
        })),
    }));
    title.episodeCount = episodes.length;
  }

  if (userId) {
    const rating = db.prepare('SELECT score FROM ratings WHERE user_id = ? AND title_id = ?').get(userId, id);
    title.userRating = rating?.score ?? 0;
    const wl = db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND title_id = ?').get(userId, id);
    title.inWatchlist = Boolean(wl);
    title.resume = getResumeFor(userId, id);
  }

  return title;
}

function publicFile(f) {
  return {
    id: f.id,
    filename: f.filename,
    extension: f.extension,
    size: f.size,
    duration: f.duration,
    width: f.width,
    height: f.height,
    videoCodec: f.video_codec,
    audioCodec: f.audio_codec,
    directPlay: f.direct_play === 1,
    position: f.position || 0,
    completed: f.completed === 1,
    quality: qualityLabel(f.height),
  };
}

function qualityLabel(height) {
  if (!height) return null;
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return 'SD';
}

/** Where should this user pick up? Next unwatched episode, or the film itself. */
export function getResumeFor(userId, titleId) {
  const title = db.prepare('SELECT kind FROM titles WHERE id = ?').get(titleId);
  if (!title) return null;

  if (title.kind === 'movie') {
    const row = db
      .prepare(`
        SELECT f.id AS file_id, ps.position, ps.completed, f.duration
        FROM media_files f
        LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
        WHERE f.title_id = ? AND f.episode_id IS NULL
        ORDER BY f.size DESC LIMIT 1
      `)
      .get(userId, titleId);
    if (!row) return null;
    return {
      fileId: row.file_id,
      position: row.completed ? 0 : row.position || 0,
      duration: row.duration,
      label: row.position > 30 && !row.completed ? 'Resume' : 'Play',
    };
  }

  // Series: first episode that isn't finished, otherwise the very first episode.
  const next = db
    .prepare(`
      SELECT e.season, e.number, e.name, f.id AS file_id, f.duration,
             COALESCE(ps.position, 0) AS position, COALESCE(ps.completed, 0) AS completed
      FROM episodes e
      JOIN media_files f ON f.episode_id = e.id
      LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
      WHERE e.title_id = ?
      ORDER BY (COALESCE(ps.completed, 0) = 1) ASC, e.season ASC, e.number ASC
      LIMIT 1
    `)
    .get(userId, titleId);

  if (!next) return null;
  return {
    fileId: next.file_id,
    position: next.completed ? 0 : next.position,
    duration: next.duration,
    season: next.season,
    episode: next.number,
    episodeName: next.name,
    label: next.position > 30 && !next.completed ? 'Resume' : next.completed ? 'Play' : 'Play',
  };
}

/** The "Continue watching" row. */
export function continueWatching(userId, limit = 20) {
  const rows = db
    .prepare(`
      SELECT ps.title_id, ps.media_file_id, ps.position, ps.duration, ps.updated_at,
             e.season, e.number, e.name AS episode_name,
             ${TITLE_COLUMNS}
      FROM playback_state ps
      JOIN titles t ON t.id = ps.title_id
      LEFT JOIN media_files f ON f.id = ps.media_file_id
      LEFT JOIN episodes e ON e.id = f.episode_id
      WHERE ps.user_id = ? AND ps.completed = 0 AND ps.position > 60
        AND (ps.duration = 0 OR ps.position < ps.duration * 0.95)
      ORDER BY ps.updated_at DESC
      LIMIT ?
    `)
    .all(userId, limit);

  return rows.map((r) => ({
    ...decorate(r),
    id: r.title_id,
    resume: {
      fileId: r.media_file_id,
      position: r.position,
      duration: r.duration,
      season: r.season,
      episode: r.number,
      episodeName: r.episode_name,
      progress: r.duration > 0 ? Math.min(1, r.position / r.duration) : 0,
    },
  }));
}

export function getWatchlist(userId, limit = 50) {
  const rows = db
    .prepare(`
      SELECT ${TITLE_COLUMNS} FROM watchlist w
      JOIN titles t ON t.id = w.title_id
      WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT ?
    `)
    .all(userId, limit);
  return rows.map(decorate);
}

/** Everything the user has actually watched, most recent first. */
export function watchHistory(userId, limit = 50) {
  const rows = db
    .prepare(`
      SELECT ${TITLE_COLUMNS},
             MAX(ps.updated_at) AS last_watched,
             MAX(ps.completed) AS completed,
             COALESCE(r.score, 0) AS user_rating
      FROM playback_state ps
      JOIN titles t ON t.id = ps.title_id
      LEFT JOIN ratings r ON r.title_id = t.id AND r.user_id = ps.user_id
      WHERE ps.user_id = ?
      GROUP BY t.id
      ORDER BY last_watched DESC
      LIMIT ?
    `)
    .all(userId, limit);
  return rows.map((r) => ({ ...decorate(r), lastWatched: r.last_watched, completed: r.completed === 1, userRating: r.user_rating }));
}

export function getMediaFile(id) {
  return db.prepare('SELECT * FROM media_files WHERE id = ?').get(id);
}

export function getSubtitles(mediaFileId) {
  return db.prepare('SELECT * FROM subtitles WHERE media_file_id = ?').all(mediaFileId);
}

/** Playback context: what is this file, and what plays after it? */
export function playbackContext(fileId, userId) {
  const file = getMediaFile(fileId);
  if (!file) return null;
  const title = getTitle(file.title_id);
  const episode = file.episode_id
    ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(file.episode_id)
    : null;

  let next = null;
  if (episode) {
    const n = db
      .prepare(`
        SELECT e.id, e.season, e.number, e.name, f.id AS file_id
        FROM episodes e JOIN media_files f ON f.episode_id = e.id
        WHERE e.title_id = ? AND (e.season > ? OR (e.season = ? AND e.number > ?))
        ORDER BY e.season, e.number LIMIT 1
      `)
      .get(file.title_id, episode.season, episode.season, episode.number);
    if (n) next = { fileId: n.file_id, season: n.season, episode: n.number, name: n.name };
  }

  const state = userId
    ? db.prepare('SELECT position, completed FROM playback_state WHERE user_id = ? AND media_file_id = ?').get(userId, fileId)
    : null;

  return {
    file: publicFile(file),
    title,
    episode: episode
      ? { id: episode.id, season: episode.season, number: episode.number, name: episode.name, overview: episode.overview }
      : null,
    next,
    position: state?.position || 0,
    subtitles: getSubtitles(fileId).map((s) => ({ id: s.id, label: s.label, language: s.language, forced: s.forced === 1 })),
  };
}

export function libraryStats() {
  return {
    movies: countTitles('movie'),
    series: countTitles('series'),
    episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
    files: db.prepare('SELECT COUNT(*) AS n FROM media_files').get().n,
    totalBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM media_files').get().n,
    unmatched: db.prepare("SELECT COUNT(*) AS n FROM titles WHERE metadata_state = 'unmatched'").get().n,
  };
}
