import chokidar from 'chokidar';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { config, VIDEO_EXTENSIONS } from '../config.js';
import { scanTargets } from '../libraries.js';
import { ingestPath, removePath } from './scanner.js';

let watcher = null;

/**
 * Watch the library folders so files dropped in show up without a manual scan —
 * the behaviour people expect from a home media server.
 */
export function startWatcher() {
  if (!config.scanner.watch) return null;

  const roots = [...new Set(scanTargets().map((t) => t.root))];
  if (!roots.length) return null;

  watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    persistent: true,
    depth: 8,
    // A large file being copied in shouldn't be scanned until the copy finishes.
    awaitWriteFinish: {
      stabilityThreshold: config.scanner.stabilityMs,
      pollInterval: 500,
    },
    ignored: (p) => path.basename(p).startsWith('.'),
  });

  // Files ECLIPSE has looked at and couldn't read yet, against the size they
  // were when it last looked.
  //
  // chokidar's awaitWriteFinish waits for a file to stop growing, but "stopped
  // growing" is not "finished": a writer that creates its output and then
  // pauses — ffmpeg before it has encoded anything, a download client
  // preallocating, a copy over a stalled share — is perfectly stable at zero
  // bytes. Remembering the size turns two sightings into the answer: same size
  // twice, and the write really has stopped.
  const waiting = new Map();

  const ingest = async (filePath, announce) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return;

    if (announce && !waiting.has(filePath)) {
      console.log(`[watch] new file: ${path.basename(filePath)}`);
    }
    try {
      let settled = false;
      if (waiting.has(filePath)) {
        try {
          settled = (await fsp.stat(filePath)).size === waiting.get(filePath);
        } catch {
          return; // deleted between the event and now
        }
      }
      await ingestPath(filePath, { settled });
      waiting.delete(filePath);
      console.log(`[watch] added to library: ${path.basename(filePath)}`);
    } catch (err) {
      if (err.code === 'ENOTREADY') {
        // Not a failure — the write is still in progress. Every further
        // change to the file is another chance to read it properly.
        if (!waiting.has(filePath)) {
          console.log(`[watch] still being written, will pick it up when it settles: ${path.basename(filePath)}`);
        }
        waiting.set(filePath, err.size ?? -1);
        return;
      }
      console.warn(`[watch] failed to ingest ${filePath}: ${err.message}`);
    }
  };

  watcher
    .on('add', (filePath) => ingest(filePath, true))
    // A file ECLIPSE couldn't read yet gets another look every time it grows.
    // Files it already holds are left to the scanner, which knows how to tell
    // a real edit from a touched timestamp.
    .on('change', (filePath) => {
      if (waiting.has(filePath)) ingest(filePath, false);
    })
    .on('unlink', (filePath) => {
      waiting.delete(filePath);
      if (removePath(filePath)) {
        console.log(`[watch] removed from library: ${path.basename(filePath)}`);
      }
    })
    .on('error', (err) => console.warn(`[watch] ${err.message}`));

  console.log(`[watch] watching ${roots.length} librar${roots.length === 1 ? 'y' : 'ies'} for changes`);
  return watcher;
}

export async function stopWatcher() {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
