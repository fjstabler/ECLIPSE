import chokidar from 'chokidar';
import path from 'node:path';
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

  watcher
    .on('add', async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) return;
      try {
        console.log(`[watch] new file: ${path.basename(filePath)}`);
        await ingestPath(filePath);
        console.log(`[watch] added to library: ${path.basename(filePath)}`);
      } catch (err) {
        console.warn(`[watch] failed to ingest ${filePath}: ${err.message}`);
      }
    })
    .on('unlink', (filePath) => {
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
