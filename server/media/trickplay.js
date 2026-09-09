import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { config, paths } from '../config.js';
import { log } from '../log.js';

/**
 * The strip of thumbnails that appears when you scrub.
 *
 * Without it, seeking is a guess: you drag to somewhere near the middle,
 * let go, and find out. With it you can see the scene you're aiming at,
 * which is how anyone actually finds the bit they wanted.
 *
 * One sprite sheet per file, laid out in a fixed grid, so a preview costs
 * exactly one image request no matter how long the film is. The interval
 * between frames is derived from the duration rather than fixed: a
 * twenty-minute episode gets a frame every six seconds and a three-hour
 * film every fifty, and both end up the same modest size on disk.
 *
 * Generation is the expensive part — ffmpeg decodes the whole file — so it
 * happens once, in the background, after someone actually starts watching.
 * A library nobody has opened costs nothing.
 */

const COLUMNS = 20;
const ROWS = 10;
const TILES = COLUMNS * ROWS;
const TILE_WIDTH = 160;

// One at a time. This runs on the same box that is serving the video, and
// very possibly transcoding it as well; a queue of parallel ffmpeg passes
// would turn a nice-to-have into stuttering playback.
let running = false;
const queue = [];

function sheetPath(fileId) {
  return path.join(paths.trickplay, `${fileId}.jpg`);
}

export function trickplayInfo(fileId) {
  const row = db.prepare('SELECT * FROM trickplay WHERE media_file_id = ?').get(fileId);
  if (!row) return null;
  if (!fs.existsSync(sheetPath(fileId))) {
    // The row outlived its image — a cleared cache, a half-finished write.
    db.prepare('DELETE FROM trickplay WHERE media_file_id = ?').run(fileId);
    return null;
  }
  return {
    url: `/api/stream/trickplay/${fileId}`,
    interval: row.interval,
    columns: row.columns,
    rows: row.rows,
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    count: row.count,
  };
}

export function trickplayFile(fileId) {
  const file = sheetPath(fileId);
  return fs.existsSync(file) ? file : null;
}

/**
 * Ask for a file's thumbnails. Returns immediately: if they don't exist yet
 * the work is queued, and the next time this file is played they will be
 * there. Nothing waits on it, because a viewer pressing play should never
 * wait for a convenience.
 */
export function ensureTrickplay(file) {
  if (!config.trickplay.enabled) return null;
  if (!file?.id || !file.duration || file.duration < 60) return null; // too short to scrub
  const existing = trickplayInfo(file.id);
  if (existing) return existing;
  if (!queue.some((f) => f.id === file.id)) queue.push(file);
  drain();
  return null;
}

function drain() {
  if (running || !queue.length) return;
  const file = queue.shift();
  running = true;
  generate(file)
    .catch((err) => log.warn('trickplay', `Could not build previews for ${file.filename}`, err.message))
    .finally(() => {
      running = false;
      drain();
    });
}

function generate(file) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(paths.trickplay, { recursive: true });

    // Spread the frames across the whole film. One extra frame of headroom
    // stops the last tile landing exactly on the final frame, which is
    // usually black.
    const interval = Math.max(2, file.duration / (TILES + 1));

    // A short file runs out of frames before the grid runs out of cells, and
    // the player must not offer a preview for a tile that was never drawn.
    const count = Math.max(1, Math.min(TILES, Math.floor(file.duration / interval)));
    const out = sheetPath(file.id);
    // The extension has to survive: ffmpeg picks the output format from it,
    // and a name ending .part is simply an unknown format to it.
    const tmp = path.join(paths.trickplay, `${file.id}.building.jpg`);

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file.path,
      '-vf', `fps=1/${interval.toFixed(4)},scale=${TILE_WIDTH}:-2,tile=${COLUMNS}x${ROWS}`,
      '-frames:v', '1',
      '-q:v', '6',
      tmp,
    ];

    const proc = spawn(config.ffmpeg.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tmp)) {
        fs.rmSync(tmp, { force: true });
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`));
        return;
      }

      // Written under a temporary name and moved into place, so a reader can
      // never catch a half-written sheet.
      fs.renameSync(tmp, out);

      // The tile height follows from the source's aspect ratio; ask the file
      // rather than assuming 16:9, which anamorphic and 4:3 content is not.
      const tileHeight = file.width && file.height
        ? Math.round((TILE_WIDTH * file.height) / file.width / 2) * 2
        : Math.round((TILE_WIDTH * 9) / 16 / 2) * 2;

      db.prepare(`
        INSERT INTO trickplay (media_file_id, interval, columns, rows, tile_width, tile_height, count)
        VALUES (@id, @interval, @columns, @rows, @tileWidth, @tileHeight, @count)
        ON CONFLICT(media_file_id) DO UPDATE SET
          interval = @interval, columns = @columns, rows = @rows,
          tile_width = @tileWidth, tile_height = @tileHeight, count = @count,
          created_at = datetime('now')
      `).run({
        id: file.id,
        interval,
        columns: COLUMNS,
        rows: ROWS,
        tileWidth: TILE_WIDTH,
        tileHeight: tileHeight,
        count,
      });

      log.info('trickplay', `Built scrub previews for ${file.filename}`, `${count} frames, every ${interval.toFixed(1)}s`);
      resolve();
    });
  });
}

/** Drop a file's previews — used when its media file goes away. */
export function clearTrickplay(fileId) {
  fs.rmSync(sheetPath(fileId), { force: true });
  db.prepare('DELETE FROM trickplay WHERE media_file_id = ?').run(fileId);
}
