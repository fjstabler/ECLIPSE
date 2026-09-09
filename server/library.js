import { db } from './db.js';
import {
  getAudioTracks, getSubtitleTracks, getChapters, getMarkers, technicalInfo, qualityLabel, versionLabel,
} from './media/streams.js';
import { getPreferences, pickTracks } from './preferences.js';
import { ratingSqlFilter } from './parental.js';

export { getAudioTracks, getSubtitleTracks, technicalInfo };

/**
 * Shared read model for the library. Both the HTTP API and N.O.V.A.'s tools go
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
    .prepare('SELECT tag_type, tag_value, weight, image FROM title_tags WHERE title_id = ? ORDER BY ordering')
    .all(row.id);

  const grouped = {};
  const castPhotos = [];
  for (const t of tags) {
    (grouped[t.tag_type] ||= []).push(t.tag_value);
    if (t.tag_type === 'cast') castPhotos.push({ name: t.tag_value, photo: t.image || null });
  }

  return {
    ...row,
    genres: grouped.genre || [],
    keywords: grouped.keyword || [],
    cast: grouped.cast || [],
    castPhotos,
    directors: grouped.director || [],
    creators: grouped.creator || [],
    writers: grouped.writer || [],
    studios: grouped.studio || [],
    countries: grouped.country || [],
    collection: grouped.collection?.[0] || null,
  };
}

export function listTitles({
  kind = null, genre = null, search = null, sort = 'added', limit = 200, offset = 0,
  libraryId = null, maxRating = null,
} = {}) {
  const where = [];
  const params = {};

  if (kind) {
    where.push('t.kind = @kind');
    params.kind = kind;
  }
  if (libraryId) {
    where.push('t.id IN (SELECT title_id FROM media_files WHERE library_id = @libraryId)');
    params.libraryId = libraryId;
  }
  // A restricted profile never loads the rows at all, rather than loading
  // them and hiding them somewhere in the client.
  const ratingFilter = ratingSqlFilter(maxRating);
  if (ratingFilter) where.push(ratingFilter.replace(/^AND /, ''));
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
    const fav = db.prepare('SELECT 1 FROM favourites WHERE user_id = ? AND title_id = ?').get(userId, id);
    title.isFavourite = Boolean(fav);
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
    container: f.container,
    bitrate: f.bitrate,
    frameRate: f.frame_rate,
    bitDepth: f.bit_depth,
    hdrFormat: f.hdr_format,
    aspectRatio: f.aspect_ratio,
    directPlay: f.direct_play === 1,
    position: f.position || 0,
    completed: f.completed === 1,
    quality: qualityLabel(f.height),
    versionLabel: versionLabel(f),
  };
}

/**
 * Where playback should actually start, given what was saved.
 *
 * A finished title resumes at the beginning, and so does one stopped in its
 * last few seconds — otherwise pressing Play on something you watched to the
 * end drops you at the end, where it immediately finishes and closes itself.
 * From the sofa that looks exactly like the app crashing.
 */
function resumePosition(state, duration) {
  if (!state) return 0;
  if (state.completed) return 0;
  const position = state.position || 0;
  if (position < 5) return 0;
  if (duration > 0 && (position >= duration - 10 || position / duration >= 0.97)) return 0;
  return position;
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
    const position = resumePosition(row, row.duration);
    return {
      fileId: row.file_id,
      position,
      duration: row.duration,
      label: position > 30 ? 'Resume' : 'Play',
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
  const position = resumePosition(next, next.duration);
  return {
    fileId: next.file_id,
    position,
    duration: next.duration,
    season: next.season,
    episode: next.number,
    episodeName: next.name,
    label: position > 30 ? 'Resume' : 'Play',
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

export function getFavourites(userId, limit = 50) {
  const rows = db
    .prepare(`
      SELECT ${TITLE_COLUMNS} FROM favourites f
      JOIN titles t ON t.id = f.title_id
      WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ?
    `)
    .all(userId, limit);
  return rows.map(decorate);
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

/**
 * Every file that is the same thing as this one — the 4K next to the 1080p,
 * the director's cut next to the theatrical. A title with one file has one
 * version; the player only offers a choice when there's genuinely one to make.
 */
export function getVersions(fileOrId, userId = null) {
  const file = typeof fileOrId === 'object' ? fileOrId : getMediaFile(fileOrId);
  if (!file) return [];

  const rows = file.episode_id
    ? db.prepare(`
        SELECT f.*, ps.position, ps.completed FROM media_files f
        LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
        WHERE f.episode_id = ? ORDER BY f.height DESC, f.size DESC
      `).all(userId ?? -1, file.episode_id)
    : db.prepare(`
        SELECT f.*, ps.position, ps.completed FROM media_files f
        LEFT JOIN playback_state ps ON ps.media_file_id = f.id AND ps.user_id = ?
        WHERE f.title_id = ? AND f.episode_id IS NULL ORDER BY f.height DESC, f.size DESC
      `).all(userId ?? -1, file.title_id);

  return rows.map(publicFile);
}

/**
 * Playback context: what this file is, what a viewer can switch between while
 * it plays, and what follows it.
 */
export function playbackContext(fileId, userId) {
  const file = getMediaFile(fileId);
  if (!file) return null;
  const title = getTitle(file.title_id);
  const episode = file.episode_id
    ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(file.episode_id)
    : null;

  let next = null;
  let previous = null;
  if (episode) {
    const n = db
      .prepare(`
        SELECT e.id, e.season, e.number, e.name, e.still, f.id AS file_id
        FROM episodes e JOIN media_files f ON f.episode_id = e.id
        WHERE e.title_id = ? AND (e.season > ? OR (e.season = ? AND e.number > ?))
        ORDER BY e.season, e.number LIMIT 1
      `)
      .get(file.title_id, episode.season, episode.season, episode.number);
    if (n) next = { fileId: n.file_id, season: n.season, episode: n.number, name: n.name, still: n.still };

    const p = db
      .prepare(`
        SELECT e.id, e.season, e.number, e.name, f.id AS file_id
        FROM episodes e JOIN media_files f ON f.episode_id = e.id
        WHERE e.title_id = ? AND (e.season < ? OR (e.season = ? AND e.number < ?))
        ORDER BY e.season DESC, e.number DESC LIMIT 1
      `)
      .get(file.title_id, episode.season, episode.season, episode.number);
    if (p) previous = { fileId: p.file_id, season: p.season, episode: p.number, name: p.name };
  }

  const state = userId
    ? db.prepare('SELECT position, completed FROM playback_state WHERE user_id = ? AND media_file_id = ?').get(userId, fileId)
    : null;

  const audioTracks = getAudioTracks(fileId);
  const subtitles = getSubtitleTracks(fileId);
  const preferences = userId ? getPreferences(userId) : null;

  return {
    file: publicFile(file),
    title,
    episode: episode
      ? { id: episode.id, season: episode.season, number: episode.number, name: episode.name, overview: episode.overview }
      : null,
    next,
    previous,
    position: resumePosition(state, file.duration),
    audioTracks,
    subtitles,
    chapters: getChapters(fileId),
    markers: getMarkers(fileId),
    versions: getVersions(file, userId),
    technical: technicalInfo(file),
    preferences,
    // Worked out server-side so every client lands on the same track for the
    // same file, rather than each one reimplementing the forced-subtitle rule.
    defaults: preferences ? pickTracks(preferences, { audioTracks, subtitles }) : null,
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
