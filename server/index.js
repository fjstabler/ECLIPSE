import express from 'express';
import cookieParser from 'cookie-parser';
import os from 'node:os';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { isFirstRun } from './db.js';
import { attachUser, pruneSessions } from './auth.js';
import { runScan } from './scanner/scanner.js';
import { startWatcher, stopWatcher } from './scanner/watcher.js';

import { router as authRoutes } from './routes/auth.routes.js';
import { router as libraryRoutes } from './routes/library.routes.js';
import { router as streamRoutes } from './routes/stream.routes.js';
import { router as playbackRoutes } from './routes/playback.routes.js';
import { router as novaRoutes } from './routes/nova.routes.js';
import { router as adminRoutes } from './routes/admin.routes.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);

// Cached artwork. Immutable because every filename is a content hash.
app.use('/artwork', express.static(paths.artwork, {
  maxAge: '30d',
  immutable: true,
}));

app.use('/api/auth', authRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/nova', novaRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', firstRun: isFirstRun() });
});

// The web client. No build step — it's ES modules straight from disk, so you
// can edit the CSS and refresh.
app.use(express.static(paths.web, { extensions: ['html'], maxAge: 0 }));

// Client-side routing: anything that isn't an API call or a file gets the app.
app.get(/^\/(?!api|artwork).*/, (req, res) => {
  res.sendFile('index.html', { root: paths.web });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

const server = app.listen(config.port, config.host, async () => {
  const banner = [
    '',
    '   ███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗',
    '   ██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝',
    '   █████╗  ██║     ██║     ██║██████╔╝███████╗█████╗  ',
    '   ██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝  ',
    '   ███████╗╚██████╗███████╗██║██║     ███████║███████╗',
    '   ╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝',
    '',
  ].join('\n');
  console.log(banner);
  console.log(`   Local      http://localhost:${config.port}`);
  for (const addr of localAddresses()) {
    console.log(`   Network    http://${addr}:${config.port}`);
  }
  console.log('');

  const movieDirs = config.libraries.movies;
  const seriesDirs = config.libraries.series;
  if (!movieDirs.length && !seriesDirs.length) {
    console.log('   No library folders configured yet.');
    console.log('   Set ECLIPSE_MOVIES_DIR and ECLIPSE_SERIES_DIR in .env, then restart.');
  } else {
    for (const d of movieDirs) console.log(`   Films      ${d}${fs.existsSync(d) ? '' : '  (missing)'}`);
    for (const d of seriesDirs) console.log(`   Series     ${d}${fs.existsSync(d) ? '' : '  (missing)'}`);
  }
  if (isFirstRun()) console.log('\n   First run — open the URL above to create your profile.');
  console.log('');

  pruneSessions();

  if (config.scanner.scanOnBoot && (movieDirs.length || seriesDirs.length)) {
    console.log('[scan] starting library scan…');
    runScan()
      .then((r) => {
        if (r.skipped) console.log(`[scan] ${r.reason}`);
        else console.log(`[scan] done — ${r.added} added, ${r.updated} updated, ${r.removed} removed`);
      })
      .catch((err) => console.error('[scan] failed:', err.message));
  }

  startWatcher();
});

// Long-lived video streams shouldn't be cut off by a default header timeout.
server.headersTimeout = 0;
server.requestTimeout = 0;

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down…`);
  await stopWatcher();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
