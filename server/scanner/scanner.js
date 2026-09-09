import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { config, VIDEO_EXTENSIONS, DIRECT_PLAY_EXTENSIONS, SUBTITLE_EXTENSIONS } from '../config.js';
import { parseMovie, parseEpisode, sortTitle, parseSubtitleLanguage } from '../util/parse.js';
import { probeFile, PROBE_VERSION } from '../media/probe.js';
import { scanTargets, markScanned } from '../libraries.js';
import { log } from '../log.js';
import * as tmdb from '../metadata/tmdb.js';
import { cacheImage, placeholderPoster, placeholderBackdrop } from '../metadata/artwork.js';

let scanning = false;
let lastProgress = { state: 'idle', found: 0, processed: 0, added: 0, updated: 0, removed: 0, current: null };
// Set for the duration of a scan that's populating a previously-empty
// library. Everything found in that first pass is the household's existing
// collection, not something newly added to it — flagging all of it "NEW"
// for a week would just be noise the day the server comes online.
let backdateNewTitles = false;

/** Matches SQLite's own `datetime('now')` format so isNew()'s parsing keeps working. */
function addedAtValue() {
  const ms = backdateNewTitles ? Date.now() - 8 * 86400_000 : Date.now();
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

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

/**
 * A file is "direct play" when a browser can open it with no help at all.
 * mp4/webm carrying h264/aac almost always work; mkv, HEVC and the surround
 * formats generally need at least a remux.
 *
 * Reads either shape — a fresh probe result or the stored row — because the
 * scan only re-probes files that changed.
 */
function isDirectPlay(ext, probed) {
  if (!DIRECT_PLAY_EXTENSIONS.has(ext)) return false;
  if (!probed) return true;
  const videoCodec = probed.videoCodec ?? probed.video_codec;
  const audioCodec = probed.audioCodec ?? probed.audio_codec;
  const okVideo = !videoCodec || ['h264', 'vp8', 'vp9', 'av1'].includes(videoCodec);
  const okAudio = !audioCodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(audioCodec);
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
      certification, status, poster, backdrop, logo, trailer_url, tmdb_id, imdb_id, metadata_state, added_at)
    VALUES (@kind, @title, @sort_title, @original_title, @year, @overview, @tagline, @runtime, @rating,
      @certification, @status, @poster, @backdrop, @logo, @trailer_url, @tmdb_id, @imdb_id, @metadata_state, @added_at)
  `).run({ ...fields, added_at: addedAtValue() });
  return { id: info.lastInsertRowid, manual: false };
}

async function replaceTags(titleId, tags) {
  if (!tags?.length) return;
  // Cast headshots are the only tag rows with an image — cache each one
  // locally (like poster/backdrop) so cast strips don't hotlink TMDB and
  // still work if the API key is later removed.
  const withImages = await Promise.all(
    tags.map(async (t) => (t.image ? { ...t, image: await cacheImage(t.image) } : t))
  );
  db.prepare('DELETE FROM title_tags WHERE title_id = ?').run(titleId);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO title_tags (title_id, tag_type, tag_value, weight, ordering, image) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const run = db.transaction((rows) => {
    for (const t of rows) insert.run(titleId, t.type, t.value, t.weight, t.ordering, t.image || null);
  });
  run(withImages);
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

async function ingestMovie(filePath, stat, libraryId = null, probed = null) {
  const parsed = parseMovie(filePath);
  const meta = await lookupMovie(parsed.title, parsed.year);
  const existingTitleId = getFileByPath.get(filePath)?.title_id || null;
  const { id: titleId, manual } = upsertTitle({ kind: 'movie', title: parsed.title, year: parsed.year, meta, existingTitleId });
  if (meta?.tags && !manual) await replaceTags(titleId, meta.tags);
  await attachFile({ filePath, stat, titleId, episodeId: null, libraryId, probed });
  return titleId;
}

async function ingestEpisode(filePath, stat, libraryRoot, libraryId = null, probed = null) {
  const parsed = parseEpisode(filePath, libraryRoot);
  if (!parsed) return null;

  const meta = await lookupSeries(parsed.series, parsed.seriesYear);
  const existingTitleId = getFileByPath.get(filePath)?.title_id || null;
  const { id: titleId, manual } = upsertTitle({ kind: 'series', title: parsed.series, year: parsed.seriesYear, meta, existingTitleId });
  if (meta?.tags && !manual) await replaceTags(titleId, meta.tags);

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

  await attachFile({ filePath, stat, titleId, episodeId: episodeRow.id, libraryId, probed });
  return titleId;
}

async function attachFile({ filePath, stat, titleId, episodeId, libraryId = null, probed: alreadyProbed = null }) {
  const ext = path.extname(filePath).toLowerCase();
  const existing = getFileByPath.get(filePath);

  // Probing is the slow part of a scan, so it only happens when there's a
  // reason: the file changed, or it was last read by an older prober that
  // didn't know about (say) subtitle streams. The second case is what makes
  // an upgrade backfill the whole library on its next scan by itself.
  const unchanged = existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs);
  const staleProbe = !existing || (existing.probe_version ?? 0) < PROBE_VERSION;
  const probed = alreadyProbed ?? (unchanged && !staleProbe ? null : await probeFile(filePath));

  const row = {
    title_id: titleId,
    episode_id: episodeId,
    library_id: libraryId ?? existing?.library_id ?? null,
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
    container: probed?.container ?? existing?.container ?? null,
    bitrate: probed?.bitrate ?? existing?.bitrate ?? null,
    video_bitrate: probed?.videoBitrate ?? existing?.video_bitrate ?? null,
    frame_rate: probed?.frameRate ?? existing?.frame_rate ?? null,
    bit_depth: probed?.bitDepth ?? existing?.bit_depth ?? null,
    pixel_format: probed?.pixelFormat ?? existing?.pixel_format ?? null,
    color_space: probed?.colorSpace ?? existing?.color_space ?? null,
    color_transfer: probed?.colorTransfer ?? existing?.color_transfer ?? null,
    color_primaries: probed?.colorPrimaries ?? existing?.color_primaries ?? null,
    hdr_format: probed?.hdrFormat ?? existing?.hdr_format ?? null,
    aspect_ratio: probed?.aspectRatio ?? existing?.aspect_ratio ?? null,
    video_profile: probed?.videoProfile ?? existing?.video_profile ?? null,
    stream_count: probed?.streamCount ?? existing?.stream_count ?? null,
    probe_version: probed ? PROBE_VERSION : existing?.probe_version ?? 0,
    direct_play: isDirectPlay(ext, probed || existing) ? 1 : 0,
  };

  db.prepare(`
    INSERT INTO media_files (title_id, episode_id, library_id, path, filename, extension, size, mtime, duration,
      width, height, video_codec, audio_codec, container, bitrate, video_bitrate, frame_rate, bit_depth,
      pixel_format, color_space, color_transfer, color_primaries, hdr_format, aspect_ratio, video_profile,
      stream_count, probe_version, direct_play, scanned_at)
    VALUES (@title_id, @episode_id, @library_id, @path, @filename, @extension, @size, @mtime, @duration,
      @width, @height, @video_codec, @audio_codec, @container, @bitrate, @video_bitrate, @frame_rate, @bit_depth,
      @pixel_format, @color_space, @color_transfer, @color_primaries, @hdr_format, @aspect_ratio, @video_profile,
      @stream_count, @probe_version, @direct_play, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      title_id=@title_id, episode_id=@episode_id, library_id=@library_id, size=@size, mtime=@mtime, duration=@duration,
      width=@width, height=@height, video_codec=@video_codec, audio_codec=@audio_codec,
      container=@container, bitrate=@bitrate, video_bitrate=@video_bitrate, frame_rate=@frame_rate,
      bit_depth=@bit_depth, pixel_format=@pixel_format, color_space=@color_space,
      color_transfer=@color_transfer, color_primaries=@color_primaries, hdr_format=@hdr_format,
      aspect_ratio=@aspect_ratio, video_profile=@video_profile, stream_count=@stream_count,
      probe_version=@probe_version, direct_play=@direct_play, scanned_at=datetime('now')
  `).run(row);

  const fileRow = getFileByPath.get(filePath);

  // Sidecar subtitles
  const subs = findSubtitlesFor(filePath);
  for (const s of subs) {
    db.prepare(
      'INSERT OR IGNORE INTO subtitles (media_file_id, path, language, label, forced) VALUES (?, ?, ?, ?, ?)'
    ).run(fileRow.id, s.path, s.language, s.label, s.forced ? 1 : 0);
  }

  // Streams, chapters and skip markers are only replaced when this pass
  // actually read the file. An unchanged file keeps what was found last time
  // — there's nothing newer to replace it with.
  if (probed) {
    storeStreams(fileRow.id, probed.streams);
    storeChapters(fileRow.id, probed.chapters);
  }

  return { fileRow, isNew: !existing };
}

function storeStreams(fileId, streams = []) {
  db.prepare('DELETE FROM media_streams WHERE media_file_id = ?').run(fileId);
  const insert = db.prepare(`
    INSERT INTO media_streams (media_file_id, kind, stream_index, type_index, codec, codec_long,
      language, title, label, is_default, is_forced, is_hearing_impaired, is_visual_impaired,
      is_commentary, is_text, is_extractable, channels, channel_layout, sample_rate, bitrate,
      width, height, frame_rate, bit_depth, profile)
    VALUES (@media_file_id, @kind, @stream_index, @type_index, @codec, @codec_long,
      @language, @title, @label, @is_default, @is_forced, @is_hearing_impaired, @is_visual_impaired,
      @is_commentary, @is_text, @is_extractable, @channels, @channel_layout, @sample_rate, @bitrate,
      @width, @height, @frame_rate, @bit_depth, @profile)
  `);
  const run = db.transaction((rows) => {
    for (const s of rows) {
      insert.run({
        media_file_id: fileId,
        kind: s.kind,
        stream_index: s.streamIndex,
        type_index: s.typeIndex,
        codec: s.codec,
        codec_long: s.codecLong,
        language: s.language,
        title: s.title,
        label: s.label,
        is_default: s.isDefault ? 1 : 0,
        is_forced: s.isForced ? 1 : 0,
        is_hearing_impaired: s.isHearingImpaired ? 1 : 0,
        is_visual_impaired: s.isVisualImpaired ? 1 : 0,
        is_commentary: s.isCommentary ? 1 : 0,
        is_text: s.isText ? 1 : 0,
        is_extractable: s.isExtractable ? 1 : 0,
        channels: s.channels ?? null,
        channel_layout: s.channelLayout ?? null,
        sample_rate: s.sampleRate ?? null,
        bitrate: s.bitrate ?? null,
        width: s.width ?? null,
        height: s.height ?? null,
        frame_rate: s.frameRate ?? null,
        bit_depth: s.bitDepth ?? null,
        profile: s.profile ?? null,
      });
    }
  });
  run(streams);
}

function storeChapters(fileId, chapters = []) {
  db.prepare('DELETE FROM chapters WHERE media_file_id = ?').run(fileId);
  db.prepare('DELETE FROM media_markers WHERE media_file_id = ? AND source = ?').run(fileId, 'chapters');
  if (!chapters.length) return;

  const insert = db.prepare(
    'INSERT INTO chapters (media_file_id, idx, title, start_time, end_time) VALUES (?, ?, ?, ?, ?)'
  );
  const run = db.transaction((rows) => {
    for (const c of rows) insert.run(fileId, c.index, c.title, c.start, c.end);
  });
  run(chapters);

  for (const marker of derivedMarkers(chapters)) {
    db.prepare(`
      INSERT OR REPLACE INTO media_markers (media_file_id, kind, start_time, end_time, source)
      VALUES (?, ?, ?, ?, 'chapters')
    `).run(fileId, marker.kind, marker.start, marker.end);
  }
}

/**
 * Turn chapter names into skippable sections.
 *
 * Nothing here guesses: a chapter has to actually say it's an intro, a recap
 * or the end credits before ECLIPSE will offer to skip it. Detecting those
 * sections in a file that doesn't label them needs audio fingerprinting
 * against other episodes, which is a different feature — offering a "Skip
 * intro" button that jumps to the wrong place is worse than not offering one.
 */
function derivedMarkers(chapters) {
  const markers = [];
  const INTRO = /\b(intro|opening|opening credits|op|title sequence|main title|titles)\b/i;
  const RECAP = /\b(recap|previously|previously on)\b/i;
  const CREDITS = /\b(end credits|closing credits|credits|ending|outro|ed)\b/i;

  for (const c of chapters) {
    if (c.end == null || c.end <= c.start) continue;
    const name = c.title || '';
    if (!name) continue;

    // An "intro" long enough to be the feature itself is a mislabelled
    // chapter, not something anyone wants to skip past.
    const length = c.end - c.start;
    if (length > 300) continue;

    if (RECAP.test(name)) markers.push({ kind: 'recap', start: c.start, end: c.end });
    else if (INTRO.test(name)) markers.push({ kind: 'intro', start: c.start, end: c.end });
    else if (CREDITS.test(name)) markers.push({ kind: 'credits', start: c.start, end: c.end });
  }

  // One of each: the first intro/recap, and the last set of credits.
  const first = (kind) => markers.find((m) => m.kind === kind);
  const last = (kind) => [...markers].reverse().find((m) => m.kind === kind);
  return [first('recap'), first('intro'), last('credits')].filter(Boolean);
}

// --- the scan itself --------------------------------------------------------

/**
 * Walk every configured library, ingest what's there, and drop rows for files
 * that have disappeared. Safe to run repeatedly.
 */
export async function runScan({ full = false } = {}) {
  if (scanning) return { skipped: true, reason: 'A scan is already running' };
  scanning = true;
  backdateNewTitles = db.prepare('SELECT COUNT(*) AS n FROM titles').get().n === 0;

  const logId = db.prepare('INSERT INTO scan_log DEFAULT VALUES').run().lastInsertRowid;
  const errors = [];
  let added = 0;
  let updated = 0;

  try {
    const jobs = scanTargets();

    if (!jobs.length) {
      lastProgress = { state: 'idle', found: 0, processed: 0, added: 0, updated: 0, removed: 0, current: null };
      return { skipped: true, reason: 'No library folders are configured' };
    }

    // Files scanned before libraries existed — or before this library was
    // added — carry no library. A scan skips files that haven't changed, so
    // without this they would stay unassigned until something touched them,
    // and every library would report an empty count on an existing install.
    // Longest root first, so a series library nested inside a films folder
    // claims its own files rather than losing them to the parent.
    for (const job of [...jobs].sort((a, b) => b.root.length - a.root.length)) {
      if (!job.libraryId) continue;
      db.prepare("UPDATE media_files SET library_id = ? WHERE library_id IS NULL AND path LIKE ? ESCAPE '\\'")
        .run(job.libraryId, `${job.root.replace(/[\\%_]/g, '\\$&')}${path.sep}%`);
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

        // A scan can run while something is still being copied in. Leave that
        // file alone rather than recording a title with nothing readable
        // behind it — but count it as seen, so the sweep below doesn't decide
        // it has been deleted.
        const probed = await readIfReady(item.file, stat);
        if (!probed) {
          console.log(`[scan] skipping ${path.basename(item.file)} — still being written`);
          seen.add(item.file);
          continue;
        }

        if (item.kind === 'series') {
          const id = await ingestEpisode(item.file, stat, item.root, item.libraryId, probed);
          if (!id) {
            // No episode markers — treat it as a film sitting in the series folder.
            await ingestMovie(item.file, stat, item.libraryId, probed);
          }
        } else {
          // A film library can still contain an obviously-episodic file.
          const ep = parseEpisode(item.file, item.root);
          if (ep) await ingestEpisode(item.file, stat, item.root, item.libraryId, probed);
          else await ingestMovie(item.file, stat, item.libraryId, probed);
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

    markScanned([...new Set(jobs.map((j) => j.libraryId).filter(Boolean))]);

    lastProgress.state = 'idle';
    lastProgress.current = null;
    if (errors.length) log.warn('scan', `Scan finished with ${errors.length} problem(s)`, errors.slice(0, 5).join(' | '));
    else log.info('scan', `Scan finished — ${added} added, ${updated} updated, ${removed} removed`);
    return { added, updated, removed, errors };
  } finally {
    scanning = false;
    backdateNewTitles = false;
    movieMetaCache.clear();
    seriesMetaCache.clear();
    seasonCache.clear();
  }
}

/**
 * Whether a file on disk is finished enough to be worth reading.
 *
 * The folder watcher waits for a file to stop growing before it reports it,
 * but "stopped growing" and "finished" are not the same thing: a writer that
 * creates the file and then pauses — ffmpeg opening its output before it has
 * encoded anything, a download client preallocating, a copy over a stalled
 * network share — looks perfectly stable at zero bytes. Ingesting that stores
 * a title with no duration, no codec and no size, which shows up on the home
 * screen and fails to play.
 *
 * So the file has to prove itself: it must have bytes, and ffprobe must find
 * something playable in it. Anything else is not rejected, just not ready —
 * the watcher will be told again when it grows.
 */
export async function readIfReady(filePath, stat, { settled = false } = {}) {
  if (!stat.size) return null;
  const probed = await probeFile(filePath);
  if (!probed || !probed.videoCodec) return null;

  // A container states its length once it has been finalised, so a duration is
  // the clearest signal that a writer has finished. Half of an encode reports
  // its codec and dimensions quite happily and no duration at all — which is
  // how a 20-second film ends up in the library as a 256 KB fragment.
  if (probed.duration) return probed;

  // Not every container carries one — a stream capture may never state its
  // length — so a file whose size has stopped moving is accepted anyway
  // rather than being kept out of the library forever.
  return settled ? probed : null;
}

function notReady() {
  const err = new Error('not finished being written');
  err.code = 'ENOTREADY';
  return err;
}

/** Ingest a single file — used by the folder watcher. */
export async function ingestPath(filePath, { settled = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return null;
  const stat = await fsp.stat(filePath);

  // A file still being written has nothing to read yet. Committing a row for
  // it would put a broken entry in the library that nothing ever revisits.
  // The probe is carried through so the file is only read once.
  const probed = await readIfReady(filePath, stat, { settled });
  if (!probed) {
    const err = notReady();
    err.size = stat.size;
    throw err;
  }

  // Which library this file appeared in decides how it's read. The longest
  // matching root wins, so a series library nested inside a films folder
  // still claims its own episodes.
  const target = scanTargets()
    .filter((t) => filePath.startsWith(t.root + path.sep))
    .sort((a, b) => b.root.length - a.root.length)[0];

  const root = target?.root;
  const libraryId = target?.libraryId ?? null;

  if (target?.kind === 'series') {
    const id = await ingestEpisode(filePath, stat, root, libraryId, probed);
    if (id) return id;
  }
  const ep = parseEpisode(filePath, root);
  if (ep) return ingestEpisode(filePath, stat, root, libraryId, probed);
  return ingestMovie(filePath, stat, libraryId, probed);
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
