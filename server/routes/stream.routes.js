import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { getMediaFile, playbackContext } from '../library.js';

export const router = express.Router();

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
};

/** Playback metadata: what to play, from where, and what comes next. */
router.get('/context/:fileId', requireAuth, (req, res) => {
  const ctx = playbackContext(Number(req.params.fileId), req.user.id);
  if (!ctx) return res.status(404).json({ error: 'File not found' });
  res.json(ctx);
});

/**
 * Direct play with HTTP range support.
 *
 * Range requests are what make seeking work — the browser asks for a byte
 * window rather than the whole file, so scrubbing doesn't re-download an
 * eight-gigabyte remux from the start.
 */
router.get('/direct/:fileId', requireAuth, (req, res) => {
  const file = getMediaFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(file.path)) return res.status(410).json({ error: 'File is no longer on disk' });

  const stat = fs.statSync(file.path);
  const total = stat.size;
  const mime = MIME_TYPES[file.extension] || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache');

  if (!range) {
    res.setHeader('Content-Length', total);
    return fs.createReadStream(file.path).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;

  // A suffix range ("bytes=-500") asks for the last N bytes.
  if (!match[1] && match[2]) {
    start = Math.max(0, total - Number(match[2]));
    end = total - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  end = Math.min(end, total - 1);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);

  const stream = fs.createReadStream(file.path, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
});

/**
 * On-the-fly remux for containers the browser can't open (most .mkv).
 *
 * This copies the video stream where possible and only re-encodes audio, which
 * is cheap enough to run on a NAS. Seeking works by restarting the pipe at an
 * offset — the player passes ?t=<seconds> and sets currentTime to match.
 */
router.get('/transcode/:fileId', requireAuth, (req, res) => {
  if (!config.ffmpeg.enabled) {
    return res.status(503).json({ error: 'Transcoding is disabled on this server' });
  }

  const file = getMediaFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(file.path)) return res.status(410).json({ error: 'File is no longer on disk' });

  const startAt = Math.max(0, Number(req.query.t) || 0);
  const forceVideo = req.query.mode === 'full';

  // Copy the video stream unless the codec can't play in a browser.
  const videoArgs =
    forceVideo || !['h264', 'vp8', 'vp9', 'av1'].includes(file.video_codec || 'h264')
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.1']
      : ['-c:v', 'copy'];

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    ...(startAt > 0 ? ['-ss', String(startAt)] : []),
    '-i', file.path,
    ...videoArgs,
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '192k',
    '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  // A piped fragmented mp4 has no length and can't be byte-seeked.
  res.setHeader('Accept-Ranges', 'none');

  const ff = spawn(config.ffmpeg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  ff.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  ff.on('error', (err) => {
    console.warn(`[stream] ffmpeg failed to start: ${err.message}`);
    if (!res.headersSent) res.status(503).json({ error: 'ffmpeg is not available on this server' });
    else res.destroy();
  });

  ff.on('close', (code) => {
    if (code !== 0 && code !== null && stderr) {
      console.warn(`[stream] ffmpeg exited ${code}: ${stderr.split('\n').slice(-3).join(' ')}`);
    }
    res.end();
  });

  // Stop encoding the moment the viewer navigates away — otherwise a skipped
  // episode keeps a CPU core busy until ffmpeg reaches the end of the file.
  // Watch the response only: a request stream can be destroyed (and emit
  // 'close') as soon as it has been read, which would kill ffmpeg immediately.
  const cleanup = () => {
    if (!ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', cleanup);

  ff.stdout.pipe(res);
});

/** Sidecar subtitles, converted to WebVTT because that's what <track> wants. */
router.get('/subtitles/:subtitleId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM subtitles WHERE id = ?').get(Number(req.params.subtitleId));
  if (!row) return res.status(404).json({ error: 'Subtitle not found' });
  if (!fs.existsSync(row.path)) return res.status(410).json({ error: 'Subtitle file is missing' });

  const ext = path.extname(row.path).toLowerCase();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

  if (ext === '.vtt') return fs.createReadStream(row.path).pipe(res);

  if (ext === '.srt') {
    const srt = fs.readFileSync(row.path, 'utf8');
    return res.send(srtToVtt(srt));
  }

  // .ass/.ssa need ffmpeg to convert; skip rather than serve something broken.
  if (!config.ffmpeg.enabled) return res.status(415).json({ error: 'Unsupported subtitle format' });
  const ff = spawn(config.ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-i', row.path, '-f', 'webvtt', 'pipe:1']);
  ff.on('error', () => res.status(503).end());
  ff.stdout.pipe(res);
});

/** SubRip and WebVTT differ by a header and a comma. */
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, '')
    .replace(/^﻿/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}
