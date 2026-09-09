import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, paths } from '../config.js';
import { db } from '../db.js';

/**
 * Getting a subtitle track to the player as WebVTT — the only subtitle format
 * a browser's <track> element understands.
 *
 * Three shapes arrive here and leave the same way:
 *   - a .vtt sitting next to the video: passed through
 *   - a .srt/.ass/.ssa next to the video: converted
 *   - a track inside the container: demuxed out, converted, and kept
 *
 * The third is why this caches. Pulling one subtitle stream out of a 40GB
 * remux means ffmpeg reads the whole file, which is fine once and absurd on
 * every play.
 */

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Text subtitles a viewer picked, ready to serve. */
export async function resolveSubtitle(file, trackId) {
  if (trackId.startsWith('s-')) return sidecarSubtitle(Number(trackId.slice(2)));
  if (trackId.startsWith('e-')) return embeddedSubtitle(file, Number(trackId.slice(2)));
  return { error: 'Unknown subtitle track', status: 404 };
}

function sidecarSubtitle(subtitleId) {
  const row = db.prepare('SELECT * FROM subtitles WHERE id = ?').get(subtitleId);
  if (!row) return { error: 'Subtitle not found', status: 404 };
  if (!fs.existsSync(row.path)) return { error: 'Subtitle file is no longer on disk', status: 410 };

  const ext = path.extname(row.path).toLowerCase();
  if (ext === '.vtt') return { path: row.path };
  if (ext === '.srt') return { body: srtToVtt(fs.readFileSync(row.path, 'utf8')) };

  // .ass/.ssa carry styling ffmpeg has to interpret; converting is the only
  // way to hand a browser something it can render.
  if (!config.ffmpeg.enabled) {
    return { error: 'This subtitle format needs ffmpeg, which is disabled on this server', status: 415 };
  }
  return convert(['-i', row.path]);
}

async function embeddedSubtitle(file, typeIndex) {
  const stream = db
    .prepare("SELECT * FROM media_streams WHERE media_file_id = ? AND kind = 'subtitle' AND type_index = ?")
    .get(file.id, typeIndex);

  if (!stream) return { error: 'That subtitle track is not in this file', status: 404 };

  // Picture-based subtitles are images of words. There's no honest conversion
  // to text without OCR, so say so plainly rather than serving an empty track
  // and letting the viewer wonder why nothing appears.
  if (stream.is_extractable !== 1) {
    return {
      error: 'This is a picture-based subtitle track and has to be burned into the video',
      status: 415,
      requiresBurnIn: true,
    };
  }

  if (!config.ffmpeg.enabled) {
    return { error: 'Extracting embedded subtitles needs ffmpeg, which is disabled on this server', status: 415 };
  }
  if (!fs.existsSync(file.path)) return { error: 'The video file is no longer on disk', status: 410 };

  const cached = cachePath(file, typeIndex);
  if (isFresh(cached, file)) return { path: cached };

  const result = await convert(['-i', file.path, '-map', `0:s:${typeIndex}`]);
  if (result.error) return result;

  // An empty result means the track exists but holds nothing usable — worth
  // caching too, so a broken track doesn't re-demux the file on every play.
  try {
    fs.writeFileSync(cached, result.body);
  } catch {
    /* cache is an optimisation; serving still works without it */
  }
  return { body: result.body };
}

function cachePath(file, typeIndex) {
  return path.join(paths.subtitles, `${file.id}-${typeIndex}.vtt`);
}

/**
 * A cached track is only good while the file behind it hasn't changed —
 * re-encoding an episode in place would otherwise keep serving the old
 * timings forever.
 */
function isFresh(cached, file) {
  try {
    const stat = fs.statSync(cached);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return false;
    return stat.mtimeMs >= (file.mtime || 0);
  } catch {
    return false;
  }
}

/** Run ffmpeg to produce WebVTT on stdout. */
function convert(inputArgs) {
  return new Promise((resolve) => {
    const ff = spawn(
      config.ffmpeg.bin,
      ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-f', 'webvtt', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.stderr.on('data', (d) => { err += d.toString().slice(0, 2000); });

    ff.on('error', () => resolve({ error: 'ffmpeg is not available on this server', status: 503 }));
    ff.on('close', (code) => {
      if (code !== 0) {
        return resolve({ error: `Could not read that subtitle track${err ? `: ${err.trim().split('\n').pop()}` : ''}`, status: 500 });
      }
      resolve({ body: out || 'WEBVTT\n\n' });
    });
  });
}

/** SubRip and WebVTT differ by a header and a comma. */
export function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, '')
    .replace(/^﻿/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/** Dropped when a file leaves the library, so the cache can't outlive it. */
export function clearSubtitleCache(fileId) {
  try {
    for (const name of fs.readdirSync(paths.subtitles)) {
      if (name.startsWith(`${fileId}-`)) fs.unlinkSync(path.join(paths.subtitles, name));
    }
  } catch {
    /* nothing to clear */
  }
}
