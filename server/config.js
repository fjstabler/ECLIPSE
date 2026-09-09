import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function resolveFromRoot(p, fallback) {
  const value = p || fallback;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function splitPaths(value) {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p)));
}

export const config = {
  port: Number(process.env.PORT || 8383),
  host: process.env.HOST || '0.0.0.0',

  // Where ECLIPSE keeps its own state: database, cached artwork, transcode temp.
  dataDir: resolveFromRoot(process.env.ECLIPSE_DATA_DIR, 'data'),

  // Media libraries. Point these at the folders you drop films/series into.
  // Multiple folders per library are allowed, separated by the OS path delimiter.
  libraries: {
    movies: splitPaths(process.env.ECLIPSE_MOVIES_DIR) ,
    series: splitPaths(process.env.ECLIPSE_SERIES_DIR),
  },

  // Metadata provider. Without a key ECLIPSE still works — it derives titles and
  // years from filenames and generates placeholder artwork.
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
    language: process.env.TMDB_LANGUAGE || 'en-GB',
    imageBase: 'https://image.tmdb.org/t/p',
  },

  // N.O.V.A.'s conversational layer, on the OpenAI API. Without a key she still
  // recommends using the local scoring engine; she just can't talk about it.
  //
  // baseUrl lets you point at any OpenAI-compatible endpoint instead — a local
  // model via LM Studio or Ollama, OpenRouter, and so on.
  nova: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.NOVA_MODEL || 'gpt-4o',
    baseUrl: process.env.OPENAI_BASE_URL || '',
  },

  session: {
    secret: process.env.ECLIPSE_SESSION_SECRET || '',
    cookieName: 'eclipse_session',
    maxAgeDays: 30,
  },

  scanner: {
    // Watch library folders and pick up new files automatically.
    watch: process.env.ECLIPSE_WATCH !== 'false',
    // Wait for a file to stop growing before scanning it (copies in progress).
    stabilityMs: Number(process.env.ECLIPSE_STABILITY_MS || 4000),
    scanOnBoot: process.env.ECLIPSE_SCAN_ON_BOOT !== 'false',
    // A periodic sweep, because the folder watcher is not enough on its own:
    // inotify does not cross a network mount, so a library on a NAS — which
    // is most of them — never reports a new file at all. Hours; 0 turns it
    // off for anyone whose media really is on local disk.
    intervalHours: Number(process.env.ECLIPSE_SCAN_INTERVAL_HOURS ?? 6),
  },

  // Transcoding is optional. If ffmpeg is on PATH, ECLIPSE can remux containers
  // the browser can't open natively (most .mkv files) on the fly.
  ffmpeg: {
    bin: process.env.FFMPEG_PATH || 'ffmpeg',
    probeBin: process.env.FFPROBE_PATH || 'ffprobe',
    enabled: process.env.ECLIPSE_TRANSCODE !== 'false',
    // 'auto' tries every hardware encoder ffmpeg was built with and keeps the
    // first that actually encodes a frame; 'off' forces software; or name one
    // directly (h264_nvenc, h264_qsv, h264_vaapi, h264_videotoolbox).
    hwaccel: process.env.ECLIPSE_HWACCEL || 'auto',
    // How many encodes may run at once. Each one costs a chunk of a CPU, so
    // the honest failure ("the server is busy") beats every stream stuttering.
    maxSessions: Number(process.env.ECLIPSE_MAX_TRANSCODES || 3),
    // Ceilings applied to every stream. 0 means "whatever the file is".
    maxHeight: Number(process.env.ECLIPSE_MAX_HEIGHT || 0),
    maxBitrate: Number(process.env.ECLIPSE_MAX_BITRATE || 0),
  },
};

export const paths = {
  db: path.join(config.dataDir, 'eclipse.db'),
  artwork: path.join(config.dataDir, 'artwork'),
  // Extracted subtitle tracks. Pulling one out of a large mkv means demuxing
  // the whole file, so it's done once and kept rather than on every play.
  subtitles: path.join(config.dataDir, 'subtitles'),
  web: path.join(ROOT, 'web'),
};

export function ensureDataDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(paths.artwork, { recursive: true });
  fs.mkdirSync(paths.subtitles, { recursive: true });
}

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.mpg', '.mpeg', '.m2ts', '.ts', '.flv', '.ogv',
]);

// Containers most browsers open directly. Everything else needs a remux.
export const DIRECT_PLAY_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov']);

export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
