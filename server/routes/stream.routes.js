import express from 'express';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { getMediaFile, playbackContext, getTitle } from '../library.js';
import { db } from '../db.js';
import { log } from '../log.js';
import { resolveSubtitle } from '../media/subtitles.js';
import { decidePlayback, buildArgs, detectHardware } from '../media/transcode.js';
import {
  startSession, attachProcess, endSession, transcodeCount, registerDevice,
} from '../media/sessions.js';

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

/** Playback metadata: what to play, what can be switched, and what follows. */
router.get('/context/:fileId', requireAuth, (req, res) => {
  const ctx = playbackContext(Number(req.params.fileId), req.user.id);
  if (!ctx) return res.status(404).json({ error: 'That file is not in the library' });
  res.json(ctx);
});

/**
 * What would happen if this device played this file — before it commits to
 * trying. The player asks first so it can pick the right URL, and so the
 * technical panel can explain why something is being converted.
 */
router.get('/decide/:fileId', requireAuth, async (req, res) => {
  const file = getMediaFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: 'That file is not in the library' });

  const capabilities = parseCapabilities(req.query);
  const decision = decidePlayback(file, capabilities, serverLimits());
  const hardware = decision.needsVideoEncode ? await detectHardware() : null;

  res.json({
    ...decision,
    hardware: hardware?.available ? hardware.label : null,
    canDirectPlay: decision.method === 'direct',
    busy: decision.method === 'transcode' && transcodeCount() >= config.ffmpeg.maxSessions,
  });
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
  if (!file) return res.status(404).json({ error: 'That file is not in the library' });
  if (!fs.existsSync(file.path)) {
    log.warn('stream', `Missing file on disk: ${file.path}`);
    return res.status(410).json({ error: 'That file is no longer on disk' });
  }

  let stat;
  try {
    stat = fs.statSync(file.path);
  } catch (err) {
    log.error('stream', `Could not read ${file.path}`, err.message);
    return res.status(500).json({ error: 'That file could not be read' });
  }

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
 * Remux or re-encode, whichever this device actually needs.
 *
 * Seeking works by restarting the pipe at an offset — the player passes
 * ?t=<seconds> and sets currentTime to match — because a fragmented mp4 on a
 * pipe has no length for the browser to byte-seek into.
 */
router.get('/transcode/:fileId', requireAuth, async (req, res) => {
  if (!config.ffmpeg.enabled) {
    return res.status(503).json({ error: 'Transcoding is switched off on this server' });
  }

  const file = getMediaFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: 'That file is not in the library' });
  if (!fs.existsSync(file.path)) return res.status(410).json({ error: 'That file is no longer on disk' });

  const startAt = Math.max(0, Number(req.query.t) || 0);
  const audioTrack = req.query.audio !== undefined && req.query.audio !== '' ? Number(req.query.audio) : null;
  const burnSubtitle = req.query.burn !== undefined && req.query.burn !== '' ? Number(req.query.burn) : null;

  const capabilities = parseCapabilities(req.query);
  const limits = serverLimits();
  if (req.query.maxHeight) limits.maxHeight = Number(req.query.maxHeight);
  if (req.query.maxBitrate) limits.maxBitrate = Number(req.query.maxBitrate);

  const decision = decidePlayback(file, capabilities, {
    ...limits,
    audioTrack,
    burnSubtitle,
    // "mode=full" is the player saying it tried the cheap path and the video
    // still didn't play, so stop copying the stream and actually encode it.
    ...(req.query.mode === 'full' ? { forceEncode: true } : {}),
  });
  if (req.query.mode === 'full') {
    decision.method = 'transcode';
    decision.needsVideoEncode = true;
  }

  // Encodes are the expensive kind. Refusing a fourth one plainly is better
  // than accepting it and making all four stutter.
  if (decision.needsVideoEncode && transcodeCount() >= config.ffmpeg.maxSessions) {
    log.warn('stream', `Refused a transcode: ${config.ffmpeg.maxSessions} already running`);
    return res.status(503).json({
      error: 'The server is already converting as many streams as it can handle. Try again in a moment.',
      code: 'TRANSCODE_BUSY',
    });
  }

  const { args, hardware } = await buildArgs({ file, decision, startAt, audioTrack, burnSubtitle });

  const device = registerDevice({
    userId: req.user.id,
    deviceKey: req.get('x-eclipse-device'),
    userAgent: req.get('user-agent'),
  });

  const title = getTitle(file.title_id);
  const episode = file.episode_id ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(file.episode_id) : null;
  const sessionId = startSession({
    userId: req.user.id,
    deviceId: device?.id ?? null,
    file,
    title,
    episode,
    decision,
    hardware,
    method: decision.needsVideoEncode ? 'transcode' : 'remux',
  });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Eclipse-Session', sessionId);
  res.setHeader('X-Eclipse-Method', decision.needsVideoEncode ? 'transcode' : 'remux');
  // A piped fragmented mp4 has no length and can't be byte-seeked.
  res.setHeader('Accept-Ranges', 'none');

  const ff = spawn(config.ffmpeg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  attachProcess(sessionId, ff);

  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  ff.on('error', (err) => {
    log.error('stream', `ffmpeg failed to start for ${file.filename}`, err.message);
    endSession(sessionId);
    if (!res.headersSent) res.status(503).json({ error: 'ffmpeg is not available on this server' });
    else res.destroy();
  });

  ff.on('close', (code) => {
    endSession(sessionId);
    // 255 is what ffmpeg exits with when it gets killed, which is the normal
    // way a session ends — the viewer navigated away.
    if (code !== 0 && code !== null && code !== 255 && stderr) {
      log.error('stream', `Conversion of ${file.filename} failed`, stderr.split('\n').slice(-3).join(' '));
    }
    res.end();
  });

  // Stop encoding the moment the viewer navigates away — otherwise a skipped
  // episode keeps a CPU core busy until ffmpeg reaches the end of the file.
  // Watch the response only: a request stream can be destroyed (and emit
  // 'close') as soon as it has been read, which would kill ffmpeg immediately.
  res.on('close', () => endSession(sessionId));

  ff.stdout.pipe(res);
});

/**
 * A subtitle track as WebVTT — embedded or sidecar, the player doesn't care
 * which. Track ids come straight from the playback context.
 */
router.get('/subtitles/:fileId/:trackId', requireAuth, async (req, res) => {
  const file = getMediaFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: 'That file is not in the library' });

  const result = await resolveSubtitle(file, req.params.trackId);
  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error, requiresBurnIn: result.requiresBurnIn || false });
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (result.path) return fs.createReadStream(result.path).pipe(res);
  res.send(result.body);
});

/** What a client says it can play, as query parameters. */
function parseCapabilities(query) {
  const list = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
  return {
    videoCodecs: list(query.video),
    audioCodecs: list(query.audio_codecs),
    maxHeight: Number(query.maxHeight) || 0,
    maxBitrate: Number(query.maxBitrate) || 0,
  };
}

function serverLimits() {
  return { maxHeight: config.ffmpeg.maxHeight, maxBitrate: config.ffmpeg.maxBitrate };
}
