/**
 * Start the library over: `npm run reset`
 *
 * Deletes the ECLIPSE database — profiles, watch history, taste profiles and
 * the scanned library — and the cached artwork. Your actual media files are
 * never touched; this only clears what ECLIPSE built up about them.
 *
 * Your .env is left alone, so folders and keys survive.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config, paths } from '../server/config.js';

const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const targets = [
  paths.db,
  `${paths.db}-wal`,
  `${paths.db}-shm`,
];

const existing = targets.filter((t) => fs.existsSync(t));
const artworkExists = fs.existsSync(paths.artwork);

if (!existing.length && !artworkExists) {
  console.log('\nNothing to reset — no database or cached artwork found.\n');
  process.exit(0);
}

console.log(`\n${yellow('This will delete:')}`);
console.log(`  · every profile, watch history and taste profile`);
console.log(`  · the scanned library (your media files are NOT touched)`);
console.log(`  · cached artwork`);
console.log(dim(`\n  ${config.dataDir}\n`));

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('Type "reset" to confirm: ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'reset') {
    console.log('\nCancelled — nothing was deleted.\n');
    process.exit(0);
  }
}

for (const target of existing) fs.rmSync(target, { force: true });
if (artworkExists) fs.rmSync(paths.artwork, { recursive: true, force: true });

// The demo library's placeholder files live under the data directory too.
const demoDir = path.join(config.dataDir, 'demo-media');
if (fs.existsSync(demoDir)) fs.rmSync(demoDir, { recursive: true, force: true });

console.log(`\n${green('Done.')} Run ${'npm start'} and create your profile again.\n`);
