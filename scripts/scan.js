/** Run a library scan from the command line: `npm run scan [-- --full]` */
import { runScan } from '../server/scanner/scanner.js';
import { config } from '../server/config.js';
import { libraryStats } from '../server/library.js';

const full = process.argv.includes('--full');

const roots = [...config.libraries.movies, ...config.libraries.series];
if (!roots.length) {
  console.error('No library folders configured. Set ECLIPSE_MOVIES_DIR / ECLIPSE_SERIES_DIR in .env');
  process.exit(1);
}

console.log(`Scanning ${roots.length} folder(s)${full ? ' (full re-read)' : ''}…`);
const result = await runScan({ full });

if (result.skipped) {
  console.log(result.reason);
} else {
  console.log(`\nAdded ${result.added}, updated ${result.updated}, removed ${result.removed}.`);
  if (result.errors?.length) {
    console.log(`\n${result.errors.length} problem(s):`);
    for (const e of result.errors.slice(0, 10)) console.log(`  ${e}`);
  }
}

const stats = libraryStats();
console.log(`\nLibrary now holds ${stats.movies} film(s), ${stats.series} series, ${stats.episodes} episode(s).`);
process.exit(0);
