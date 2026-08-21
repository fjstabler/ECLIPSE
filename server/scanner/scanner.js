import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { config, VIDEO_EXTENSIONS, DIRECT_PLAY_EXTENSIONS, SUBTITLE_EXTENSIONS } from '../config.js';
import { parseMovie, parseEpisode, sortTitle, parseSubtitleLanguage, LANGUAGE_NAMES } from '../util/parse.js';
import * as tmdb from '../metadata/tmdb.js';
import { cacheImage, placeholderPoster, placeholderBackdrop } from '../metadata/artwork.js';

const execFileAsync = promisify(execFile);

let scanning = false;
let lastProgress = { state: 'idle', found: 0, processed: 0, added: 0, updated: 0, removed: 0, current: null };

export function scanStatus() {
  return { ...lastProgress, scanning };
}

/** Recursively list every media file under a root. */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '@eaDir' || entry.name === 'lost+found') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) out.push(full);
    }
  }
  return out;
}

/** Ask ffprobe for duration and codecs. Optional — absence just means less detail. */
async function probe(filePath) {
  if (!config.ffmpeg.enabled) return null;
  try {
    const { stdout } = await execFileAsync(
      config.ffmpeg.probeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    const audioStreams = (data.streams || []).filter((s) => s.codec_type === 'audio');
    const audio = audioStreams[0];
    return {
      duration: data.format?.duration ? Number(data.format.duration) : null,
      width: video?.width || null,
      height: video?.height || null,
      videoCodec: video?.codec_name || null,
      audioCodec: audio?.codec_name || null,
      // track_index is the position among audio streams only (0, 1, 2…) —
      // deliberately not ffprobe's absolute stream index, because that's
      // what ffmpeg's own "-map 0:a:N" wants when a track gets selected.
      audioTracks: audioStreams.map((s, i) => {
        const lang = (s.tags?.language || '').toLowerCase() || null;
        return {
          trackIndex: i,
          codec: s.codec_name || null,
          language: lang && lang !== 'und' ? lang : null,
          label: s.tags?.title || (lang ? LANGUAGE_NAMES[lang] : null) || (lang ? lang.toUpperCase() : `Track ${i + 1}`),
          channels: s.channels || null,
          isDefault: s.disposition?.default === 1,
        };
      }),
    };
  } catch {
    return null;
  }
}

/**
 * A file is "direct play" when the browser can open it without help. mp4/webm
 * with h264/aac almost always work; mkv and h265 generally need a remux.
 */
function isDirectPlay(ext, probed) {
  if (!DIRECT_PLAY_EXTENSIONS.has(ext)) return false;
  if (!probed) return true;
  const okVideo = !probed.videoCodec || ['h264', 'vp8', 'vp9', 'av1'].includes(probed.videoCodec);
  const okAudio = !probed.audioCodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(probed.audioCodec);
  return okVideo && okAudio;
}

function findSubtitlesFor(videoPath) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.has(ext)) return false;
      return name.startsWith(stem);
    })
    .map((name) => {
      const full = path.join(dir, name);
      return { path: full, ...parseSubtitleLanguage(full) };
    });
}

// --- title upsert helpers ---------------------------------------------------

const findTitleByTmdb = db.prepare('SELECT * FROM titles WHERE kind = ? AND tmdb_id = ?');
const findTitleByName = db.prepare(
  'SELECT * FROM titles WHERE kind = ? AND sort_title = ? AND (year IS ? OR ? IS NULL)'
);
const findTitleById = db.prepare('SELECT * FROM titles WHERE id = ?');

/**
 * `existingTitleId` is the title this exact file was already attached to,
 * from before this scan touched it — checked first and, when present, wins
 * outright. Name/year matching is only a fallback for a file scanned for
 * the first time; for a file scanned before, trusting it over the freshly
 * re-parsed filename is what stops an edited title (manual or a TMDB match
 * whose display name doesn't match the file) from drifting away from its
 * own file on the next scan and leaving both an orphaned title and a fresh
 * duplicate behind.
 */
function upsertTitle({ kind, title, year, meta, existingTitleId }) {
  const sort = sortTitle(title);

  let existing = existingTitleId ? findTitleById.get(existingTitleId) : null;
  if (!existing && meta?.tmdbId) existing = findTitleByTmdb.get(kind, meta.tmdbId);
  if (!existing) existing = findTitleByName.get(kind, sort, year ?? null, year ?? null);

  const fields = {
    kind,
    title: meta?.title || title,
    sort_title: sortTitle(meta?.title || title),
    original_title: meta?.originalTitle || null,
    year: meta?.year ?? year ?? null,
    overview: meta?.overview || null,
    tagline: meta?.tagline || null,
    runtime: meta?.runtime || null,
    rating: meta?.rating || null,
    certification: meta?.certification || null,
    status: meta?.status || null,
    poster: meta?.poster || null,
    backdrop: meta?.backdrop || null,
    logo: meta?.logo || null,
    trailer_url: meta?.trailerUrl || null,
    tmdb_id: meta?.tmdbId || null,
    imdb_id: meta?.imdbId || null,
    metadata_state: meta ? 'matched' : 'unmatched',
  };

  if (!fields.poster) fields.poster = placeholderPoster(fields.title, fields.year, kind);
  if (!fields.backdrop) fields.backdrop = placeholderBackdrop(fields.title);

  if (existing) {
    // Never downgrade a matched title back to unmatched on a rescan. A
    // manual title also keeps whatever tags it has — genres included —
    // which is why the caller checks `manual` before ever calling
    // replaceTags(), not just whether it got a fresh title/overview/etc.
    if (existing.metadata_state === 'manual') return { id: existing.id, manual: true };
    if (!meta && existing.metadata_state === 'matched') return { id: existing.id, manual: false };

    db.prepare(`
      UPDATE titles SET title=@title, sort_title=@sort_title, original_title=@original_title, year=@year,
        overview=@overview, tagline=@tagline, runtime=@runtime, rating=@rating, certification=@certification,
        status=@status, poster=@poster, backdrop=@backdrop, logo=@logo, trailer_url=@trailer_url,
        tmdb_id=@tmdb_id, imdb_id=@imdb_id, metadata_state=@metadata_state, updated_at=datetime('now')
      WHERE id=@id
    `).run({ ...fields, id: existing.id });
    return { id: existing.id, manual: false };
  }

  const info = db.prepare(`
    INSERT INTO titles (kind, title, sort_title, original_title, year, overview, tagline, runtime, rating,
      certification, status, poster, backdrop, logo, trailer_url, tmdb_id, imdb_id, metadata_state)
    VALUES (@kind, @title, @sort_title, @original_title, @year, @overview, @tagline, @runtime, @rating,
      @certification, @status, @poster, @backdrop, @logo, @trailer_url, @tmdb_id, @imdb_id, @metadata_state)
  `).run(fields);
  return { id: info.lastInsertRowid, manual: false };
}

function replaceTags(titleId, tags) {
  if (!tags?.length) return;
  db.prepare('DELETE FROM title_tags WHERE title_id = ?').run(titleId);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO title_tags (title_id, tag_type, tag_value, weight, ordering) VALUES (?, ?, ?, ?, ?)'
  );
  const run = db.transaction((rows) => {
    for (const t of rows) insert.run(titleId, t.type, t.value, t.weight, t.ordering);
  });
  run(tags);
}

async function cacheTitleArtwork(meta) {
  if (!meta) return;
  meta.poster = await cacheImage(meta.poster);
  meta.backdrop = await cacheImage(meta.backdrop);
  meta.logo = await cacheImage(meta.logo);
}

// --- metadata lookup with an in-run cache ----------------------------------

const movieMetaCache = new Map();
const seriesMetaCache = new Map();

async function lookupMovie(title, year) {
  if (!tmdb.hasTmdb()) return null;
  const key = `${title}|${year || ''}`;
  if (movieMetaCache.has(key)) return movieMetaCache.get(key);
  try {
    const hit = await tmdb.searchMovie(title, year);
    if (!hit) {
      movieMetaCache.set(key, null);
      return null;
    }
    const meta = await tmdb.movieDetails(hit.id);
    await cacheTitleArtwork(meta);
    movieMetaCache.set(key, meta);
    return meta;
  } catch (err) {
    console.warn(`[scan] metadata lookup failed for "${title}": ${err.message}`);
    movieMetaCache.set(key, null);
    return null;
  }
}

async function lookupSeries(title, year) {
  if (!tmdb.hasTmdb()) return null;
  const key = `${title}|${year || ''}`;
  if (seriesMetaCache.has(key)) return seriesMetaCache.get(key);
  try {
    const hit = await tmdb.searchSeries(title, year);
    if (!hit) {
      seriesMetaCache.set(key, null);
      return null;
    }
    const meta = await tmdb.seriesDetails(hit.id);
    await cacheTitleArtwork(meta);
    seriesMetaCache.set(key, meta);
    return meta;
  } catch (err) {
    console.warn(`[scan] metadata lookup failed for series "${title}": ${err.message}`);
    seriesMetaCache.set(key, null);
    return null;
  }
}

// Episode metadata is fetched per season, not per episode.
const seasonCache = new Map();
async function lookupSeason(tmdbId, seasonNumber) {
  if (!tmdb.hasTmdb() || !tmdbId) return null;
  const key = `${tmdbId}|${seasonNumber}`;
  if (seasonCache.has(key)) return seasonCache.get(key);
  try {
    const data = await tmdb.seasonDetails(tmdbId, seasonNumber);
    seasonCache.set(key, data);
    return data;
  } catch {
    seasonCache.set(key, null);
    return null;
  }
}

// --- per-file ingestion -----------------------------------------------------

const getFileByPath = db.prepare('SELECT * FROM media_files WHERE path = ?');

async function ingestMovie(filePath, stat) {
  const parsed = parseMovie(filePath);
  const meta = await lookupMovie(parsed.title, parsed.year);
  const existingTitleId = getFileByPath.get(filePath)?.title_id || null;
  const { id: titleId, manual } = upsertTitle({ kind: 'movie', title: parsed.title, year: parsed.year, meta, existingTitleId });
  if (meta?.tags && !manual) replaceTags(titleId, meta.tags);
  await attachFile({ filePath, stat, titleId, episodeId: null });
  return titleId;
}

async function ingestEpisode(filePath, stat, libraryRoot) {
  const parsed = parseEpisode(filePath, libraryRoot);
  if (!parsed) return null;

  const meta = await lookupSeries(parsed.series, parsed.seriesYear);
  const existingTitleId = getFileByPath.get(filePath)?.title_id || null;
  const { id: titleId, manual } = upsertTitle({ kind: 'series', title: parsed.series, year: parsed.seriesYear, meta, existingTitleId });
  if (meta?.tags && !manual) replaceTags(titleId, meta.tags);

  // Season row
  let seasonMeta = null;
  if (meta?.seasons) seasonMeta = meta.seasons.find((s) => s.number === parsed.season) || null;
  db.prepare(`
    INSERT INTO seasons (title_id, number, name, overview, poster) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(title_id, number) DO UPDATE SET
      name = COALESCE(excluded.name, seasons.name),
      overview = COALESCE(excluded.overview, seasons.overview),
      poster = COALESCE(excluded.poster, seasons.poster)
  `).run(
    titleId,
    parsed.season,
    seasonMeta?.name || (parsed.season === 0 ? 'Specials' : `Season ${parsed.season}`),
    seasonMeta?.overview || null,
    seasonMeta?.poster || null
  );
  const seasonRow = db.prepare('SELECT id FROM seasons WHERE title_id = ? AND number = ?').get(titleId, parsed.season);

  // Episode row, enriched from the season payload when we have one.
  const seasonData = await lookupSeason(meta?.tmdbId, parsed.season);
  const epMeta = seasonData?.episodes?.find((e) => e.episode_number === parsed.episode) || null;
  const still = epMeta?.still_path ? await cacheImage(`https://image.tmdb.org/t/p/w500${epMeta.still_path}`) : null;

  db.prepare(`
    INSERT INTO episodes (title_id, season_id, season, number, name, overview, still, air_date, runtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_id, season, number) DO UPDATE SET
      season_id = excluded.season_id,
      name = COALESCE(excluded.name, episodes.name),
      overview = COALESCE(excluded.overview, episodes.overview),
      still = COALESCE(excluded.still, episodes.still),
      air_date = COALESCE(excluded.air_date, episodes.air_date),
      runtime = COALESCE(excluded.runtime, episodes.runtime)
  `).run(
    titleId,
    seasonRow.id,
    parsed.season,
    parsed.episode,
    epMeta?.name || parsed.episodeTitle || `Episode ${parsed.episode}`,
    epMeta?.overview || null,
    still,
    epMeta?.air_date || null,
    epMeta?.runtime || null
  );

  const episodeRow = db
    .prepare('SELECT id FROM episodes WHERE title_id = ? AND season = ? AND number = ?')
    .get(titleId, parsed.season, parsed.episode);

  await attachFile({ filePath, stat, titleId, episodeId: episodeRow.id });
  return titleId;
}

async function attachFile({ filePath, stat, titleId, episodeId }) {
  const ext = path.extname(filePath).toLowerCase();
  const existing = getFileByPath.get(filePath);

  // Only re-probe when the file actually changed — probing is the slow part.
  const unchanged = existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs);
  const probed = unchanged ? null : await probe(filePath);

  const row = {
    title_id: titleId,
    episode_id: episodeId,
    path: filePath,
    filename: path.basename(filePath),
    extension: ext,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    duration: probed?.duration ?? existing?.duration ?? null,
    width: probed?.width ?? existing?.width ?? null,
    height: probed?.height ?? existing?.height ?? null,
    video_codec: probed?.videoCodec ?? existing?.video_codec ?? null,
    audio_codec: probed?.audioCodec ?? existing?.audio_codec ?? null,
    direct_play: isDirectPlay(ext, probed || existing) ? 1 : 0,
  };

  db.prepare(`
    INSERT INTO media_files (title_id, episode_id, path, filename, extension, size, mtime, duration,
      width, height, video_codec, audio_codec, direct_play, scanned_at)
    VALUES (@title_id, @episode_id, @path, @filename, @extension, @size, @mtime, @duration,
      @width, @height, @video_codec, @audio_codec, @direct_play, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      title_id=@title_id, episode_id=@episode_id, size=@size, mtime=@mtime, duration=@duration,
      width=@width, height=@height, video_codec=@video_codec, audio_codec=@audio_codec,
      direct_play=@direct_play, scanned_at=datetime('now')
  `).run(row);

  const fileRow = getFileByPath.get(filePath);

  // Sidecar subtitles
  const subs = findSubtitlesFor(filePath);
  for (const s of subs) {
    db.prepare(
      'INSERT OR IGNORE INTO subtitles (media_file_id, path, language, label, forced) VALUES (?, ?, ?, ?, ?)'
    ).run(fileRow.id, s.path, s.language, s.label, s.forced ? 1 : 0);
  }

  // Embedded audio tracks — only known when this pass actually re-probed the
  // file (a fresh probe reflects reality; an unchanged file keeps whatever
  // was found last time, so there's nothing to replace it with here).
  if (probed?.audioTracks) {
    db.prepare('DELETE FROM audio_tracks WHERE media_file_id = ?').run(fileRow.id);
    const insertTrack = db.prepare(`
      INSERT INTO audio_tracks (media_file_id, track_index, codec, language, label, channels, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of probed.audioTracks) {
      insertTrack.run(fileRow.id, t.trackIndex, t.codec, t.language, t.label, t.channels, t.isDefault ? 1 : 0);
    }
  }

  return { fileRow, isNew: !existing };
}

// --- the scan itself --------------------------------------------------------

/**
 * Walk every configured library, ingest what's there, and drop rows for files
 * that have disappeared. Safe to run repeatedly.
 */
export async function runScan({ full = false } = {}) {
  if (scanning) return { skipped: true, reason: 'A scan is already running' };
  scanning = true;

  const logId = db.prepare('INSERT INTO scan_log DEFAULT VALUES').run().lastInsertRowid;
  const errors = [];
  let added = 0;
  let updated = 0;

  try {
    const jobs = [];
    for (const root of config.libraries.movies) jobs.push({ root, kind: 'movie' });
    for (const root of config.libraries.series) jobs.push({ root, kind: 'series' });

    if (!jobs.length) {
      lastProgress = { state: 'idle', found: 0, processed: 0, added: 0, updated: 0, removed: 0, current: null };
      return { skipped: true, reason: 'No library folders are configured' };
    }

    const allFiles = [];
    for (const job of jobs) {
      if (!fs.existsSync(job.root)) {
        errors.push(`Library folder not found: ${job.root}`);
        continue;
      }
      const files = await walk(job.root);
      for (const f of files) allFiles.push({ ...job, file: f });
    }

    lastProgress = {
      state: 'scanning', found: allFiles.length, processed: 0, added: 0, updated: 0, removed: 0, current: null,
    };

    const seen = new Set();
    for (const item of allFiles) {
      lastProgress.processed += 1;
      lastProgress.current = path.basename(item.file);
      try {
        const stat = await fsp.stat(item.file);
        const existing = getFileByPath.get(item.file);

        // Skip untouched files unless the caller asked for a full re-read.
        if (!full && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
          seen.add(item.file);
          continue;
        }

        if (item.kind === 'series') {
          const id = await ingestEpisode(item.file, stat, item.root);
          if (!id) {
            // No episode markers — treat it as a film sitting in the series folder.
            await ingestMovie(item.file, stat);
          }
        } else {
          // A film library can still contain an obviously-episodic file.
          const ep = parseEpisode(item.file, item.root);
          if (ep) await ingestEpisode(item.file, stat, item.root);
          else await ingestMovie(item.file, stat);
        }

        seen.add(item.file);
        if (existing) {
          updated += 1;
          lastProgress.updated = updated;
        } else {
          added += 1;
          lastProgress.added = added;
        }
      } catch (err) {
        errors.push(`${item.file}: ${err.message}`);
      }
    }

    // Anything in the database but no longer on disk goes away.
    const known = db.prepare('SELECT id, path FROM media_files').all();
    let removed = 0;
    const del = db.prepare('DELETE FROM media_files WHERE id = ?');
    for (const row of known) {
      if (!fs.existsSync(row.path)) {
        del.run(row.id);
        removed += 1;
      }
    }
    lastProgress.removed = removed;

    // Titles and episodes with no files left are orphans.
    db.exec(`
      DELETE FROM episodes WHERE id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL);
      DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM media_files WHERE title_id IS NOT NULL);
      DELETE FROM seasons WHERE id NOT IN (SELECT season_id FROM episodes WHERE season_id IS NOT NULL);
    `);

    db.prepare(
      "UPDATE scan_log SET finished_at = datetime('now'), added = ?, updated = ?, removed = ?, errors = ? WHERE id = ?"
    ).run(added, updated, removed, JSON.stringify(errors.slice(0, 50)), logId);

    lastProgress.state = 'idle';
    lastProgress.current = null;
    return { added, updated, removed, errors };
  } finally {
    scanning = false;
    movieMetaCache.clear();
    seriesMetaCache.clear();
    seasonCache.clear();
  }
}

/** Ingest a single file — used by the folder watcher. */
export async function ingestPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return null;
  const stat = await fsp.stat(filePath);

  const inSeries = config.libraries.series.some((root) => filePath.startsWith(root + path.sep));
  const root = [...config.libraries.series, ...config.libraries.movies].find((r) =>
    filePath.startsWith(r + path.sep)
  );

  if (inSeries) {
    const id = await ingestEpisode(filePath, stat, root);
    if (id) return id;
  }
  const ep = parseEpisode(filePath, root);
  if (ep) return ingestEpisode(filePath, stat, root);
  return ingestMovie(filePath, stat);
}

export function removePath(filePath) {
  const row = getFileByPath.get(filePath);
  if (!row) return false;
  db.prepare('DELETE FROM media_files WHERE id = ?').run(row.id);
  db.exec(`
    DELETE FROM episodes WHERE id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL);
    DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM media_files WHERE title_id IS NOT NULL);
  `);
  return true;
}
