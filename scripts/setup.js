/**
 * Interactive first-run setup: `npm run setup`
 *
 * Creates the .env file — which doesn't exist until you make one, because it
 * holds private keys and is deliberately kept out of the repository. Asks for
 * the media folders and the two optional API keys, explains what each one
 * actually does, and writes the file.
 *
 * Safe to re-run: existing answers become the defaults, so pressing Enter
 * through it changes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const violet = (s) => `\x1b[35m${s}\x1b[0m`;

const rl = readline.createInterface({ input: stdin, output: stdout });

/**
 * Questions are served from a queue of input lines rather than rl.question(),
 * so this behaves identically whether someone is typing at a prompt or piping
 * answers in. If input ends early — Ctrl-D, or a short pipe — the remaining
 * questions fall back to their defaults instead of hanging.
 */
const waiting = [];
const buffered = [];
let inputClosed = false;

rl.on('line', (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else buffered.push(line);
});

rl.on('close', () => {
  inputClosed = true;
  while (waiting.length) waiting.shift()('');
});

function prompt(text) {
  stdout.write(text);
  if (buffered.length) return Promise.resolve(buffered.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => waiting.push(resolve));
}

/** Read the current .env (if any) so re-running keeps what's already set. */
function readExistingEnv() {
  const values = {};
  if (!fs.existsSync(ENV_PATH)) return values;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

async function ask(question, { current = '', placeholder = '' } = {}) {
  const shown = current ? ` ${dim(`[${maskIfSecret(question, current)}]`)}` : placeholder ? ` ${dim(`(${placeholder})`)}` : '';
  const answer = (await prompt(`${question}${shown}\n> `)).trim();
  return answer || current;
}

function maskIfSecret(question, value) {
  if (!/key/i.test(question)) return value;
  return value.length > 8 ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'set';
}

/** Folders get checked, because a typo here is the most common reason a library looks empty. */
async function askFolder(label, current) {
  while (true) {
    const answer = await ask(label, { current, placeholder: 'leave blank to skip for now' });
    if (!answer) return '';

    // Strip quotes — dragging a folder into a terminal often adds them.
    const cleaned = answer.replace(/^['"]|['"]$/g, '').trim();

    if (fs.existsSync(cleaned) && fs.statSync(cleaned).isDirectory()) {
      const count = countVideos(cleaned);
      console.log(green(`  ✓ Found that folder${count ? ` — ${count} video file${count === 1 ? '' : 's'} inside` : ' (no video files in it yet, that\'s fine)'}`));
      return cleaned;
    }

    console.log(yellow(`  ! No folder at "${cleaned}"`));
    if (inputClosed) return cleaned;
    const again = (await prompt(dim('  Use it anyway (y), or type it again (Enter)? '))).trim().toLowerCase();
    if (again === 'y') return cleaned;
  }
}

function countVideos(dir, depth = 0) {
  if (depth > 3) return 0;
  let n = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) n += countVideos(path.join(dir, entry.name), depth + 1);
    else if (/\.(mp4|m4v|mkv|avi|mov|webm|wmv|mpg|mpeg|ts|m2ts)$/i.test(entry.name)) n += 1;
  }
  return n;
}

/**
 * Write values into the annotated template so the resulting .env keeps all the
 * explanatory comments rather than being a bare list of keys.
 */
function writeEnv(values) {
  let template = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(template)) template = template.replace(pattern, `${key}=${value}`);
    else template += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, template);
}

// ---------------------------------------------------------------------------

console.log(`
${violet('  ECLIPSE setup')}

  This creates the ${bold('.env')} file — the one place your settings and keys live.
  It doesn't exist yet, which is why there's nothing to open.

  Press ${bold('Enter')} to skip any question. You can re-run this any time with
  ${bold('npm run setup')}, and nothing you've already set will be lost.
`);

const existing = readExistingEnv();

console.log(bold('\n  1. Your media\n'));
console.log(dim('  Where do your films and series live? Paste the full path to the folder.'));
console.log(dim('  On macOS you can drag the folder into this window to paste its path.'));
console.log(dim('  Examples:  /Users/finley/Movies    D:\\Media\\Films    /mnt/media/Films\n'));

const moviesDir = await askFolder('  Folder containing your FILMS:', existing.ECLIPSE_MOVIES_DIR || '');
console.log('');
const seriesDir = await askFolder('  Folder containing your SERIES:', existing.ECLIPSE_SERIES_DIR || '');

console.log(bold('\n\n  2. Artwork and metadata (recommended)\n'));
console.log(dim('  A free TMDB key gets you real posters, backdrops, synopses, cast and'));
console.log(dim('  episode titles. Without it your files still play, but with plain'));
console.log(dim('  generated posters and no synopsis.\n'));
console.log(`  Get one here: ${violet('https://www.themoviedb.org/settings/api')}`);
console.log(dim('  (sign up, then copy the "API Read Access Token" or the "API Key")\n'));

const tmdbKey = await ask('  Paste your TMDB key:', { current: existing.TMDB_API_KEY || '', placeholder: 'or press Enter to skip' });

console.log(bold('\n\n  3. Talking to N.O.V.A. (optional)\n'));
console.log(dim("  N.O.V.A. already ranks your library and explains every pick without this."));
console.log(dim('  An OpenAI key lets you chat with her — "something short and funny", or'));
console.log(dim('  "something like the film I watched last night".\n'));
console.log(`  Get one here: ${violet('https://platform.openai.com/api-keys')}\n`);

const openaiKey = await ask('  Paste your OpenAI key:', { current: existing.OPENAI_API_KEY || '', placeholder: 'or press Enter to skip' });

rl.close();

writeEnv({
  ECLIPSE_MOVIES_DIR: moviesDir,
  ECLIPSE_SERIES_DIR: seriesDir,
  TMDB_API_KEY: tmdbKey,
  OPENAI_API_KEY: openaiKey,
});

console.log(`\n\n${green('  Saved to .env')}  ${dim(ENV_PATH)}\n`);
console.log('  ' + bold('What you have set up:'));
console.log(`    Films folder     ${moviesDir || dim('not set — add it later with npm run setup')}`);
console.log(`    Series folder    ${seriesDir || dim('not set — add it later with npm run setup')}`);
console.log(`    Artwork (TMDB)   ${tmdbKey ? green('yes') : dim('no — posters will be plain placeholders')}`);
console.log(`    N.O.V.A. chat    ${openaiKey ? green('yes') : dim('no — recommendations still work, just no conversation')}`);

console.log(`\n  ${bold('Now run:')}  ${violet('npm start')}\n`);
console.log(dim('  Then open the address it prints, and create your profile.\n'));
