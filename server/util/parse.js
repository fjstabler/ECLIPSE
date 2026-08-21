import path from 'node:path';

// Junk that shows up in scene releases and torrent names. Everything from the
// first match onwards is almost always noise rather than title.
const NOISE_TOKENS = [
  '2160p', '1080p', '720p', '480p', '4k', 'uhd', 'hdr10plus', 'hdr10', 'hdr', 'dolby vision', 'dovi', 'dv',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'dvdrip', 'dvd',
  'remux', 'proper', 'repack', 'extended', 'unrated', 'directors cut', 'theatrical', 'imax',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'eac3', 'dts-hd', 'dts', 'truehd', 'atmos', 'ddp5 1', 'dd5 1', 'flac', 'mp3',
  '5 1', '7 1', '2 0', 'multi', 'dual audio', 'subbed', 'dubbed', 'hardsub',
  'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'pcok', 'stan', 'itunes',
];

const NOISE_PATTERN = new RegExp(
  `\\b(${NOISE_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ .]')).join('|')})\\b`,
  'i'
);

// Release-group suffixes: "-RARBG", "-YTS.MX", "[SPARKS]"
const GROUP_SUFFIX = /[-–—]\s*[A-Za-z0-9_.]+$|\[[^\]]+\]\s*$|\{[^}]+\}\s*$/;

const YEAR_PATTERN = /\b(19\d{2}|20\d{2})\b/;

// Season/episode notations we understand, most explicit first.
const EPISODE_PATTERNS = [
  // S01E02, s1e2, S01.E02, S01 E02
  { re: /\bS(\d{1,3})[\s._-]*E(\d{1,4})\b/i, season: 1, episode: 2 },
  // 1x02
  { re: /\b(\d{1,3})x(\d{1,4})\b/i, season: 1, episode: 2 },
  // Season 1 Episode 2
  { re: /\bSeason[\s._-]*(\d{1,3})[\s._-]*Episode[\s._-]*(\d{1,4})\b/i, season: 1, episode: 2 },
  // 102 style (S1 E02) — only trusted when the folder already told us it's a series
  { re: /\bE(\d{1,4})\b/i, season: null, episode: 1 },
];

const SEASON_FOLDER = /^(?:season|series|s)[\s._-]*(\d{1,3})$|^specials?$/i;

const MULTI_EPISODE = /\bS?(\d{1,3})?[\s._-]*E(\d{1,4})[\s._-]*[-E](\d{1,4})\b/i;

/** Turn "the.matrix.1999" style separators into spaces and squash whitespace. */
function normaliseSeparators(input) {
  return input
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Strip everything from the first quality/codec token onwards. */
function stripNoise(input) {
  const match = NOISE_PATTERN.exec(input);
  let out = match ? input.slice(0, match.index) : input;
  out = out.replace(GROUP_SUFFIX, '');
  return out.replace(/[\s\-–—_.]+$/, '').trim();
}

/** "matrix, the" -> "matrix, the" is left alone; "The Matrix" -> "matrix, the". */
export function sortTitle(title) {
  const t = title.trim();
  const m = /^(a|an|the)\s+(.+)$/i.exec(t);
  const base = m ? `${m[2]}, ${m[1]}` : t;
  return base.toLowerCase();
}

/**
 * Parse a movie filename into { title, year }.
 * Handles both "The Matrix (1999).mkv" and "The.Matrix.1999.1080p.x264-GRP.mkv".
 */
export function parseMovie(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parent = path.basename(path.dirname(filePath));

  // A folder like "The Matrix (1999)" is a stronger signal than a messy filename,
  // so prefer it when it carries a year and the file doesn't.
  const fromFile = extractTitleYear(base);
  const fromFolder = extractTitleYear(parent);

  let chosen = fromFile;
  if (!fromFile.year && fromFolder.year && fromFolder.title) chosen = fromFolder;
  // Files named "movie.mkv" or "1080p.mkv" inside a well-named folder.
  if (fromFolder.title && (!chosen.title || chosen.title.length < 3)) chosen = fromFolder;

  return {
    title: chosen.title || normaliseSeparators(base),
    year: chosen.year,
    edition: detectEdition(base),
  };
}

function extractTitleYear(raw) {
  let s = normaliseSeparators(raw);

  // Prefer a parenthesised year — it's unambiguous.
  const paren = /\((19\d{2}|20\d{2})\)/.exec(s);
  let year = null;
  if (paren) {
    year = Number(paren[1]);
    s = s.slice(0, paren.index);
  } else {
    const cleaned = stripNoise(s);
    // A title can contain a year-like number ("Blade Runner 2049", "1917",
    // "2012"), so take the *last* plausible release year rather than the
    // first, skip anything too far in the future to be one, and never treat a
    // leading number as metadata — that's the title.
    const maxYear = new Date().getFullYear() + 2;
    let chosen = null;
    for (const match of cleaned.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
      if (Number(match[1]) > maxYear) continue;
      if (cleaned.slice(0, match.index).trim().length === 0) continue;
      chosen = match;
    }
    if (chosen) {
      year = Number(chosen[1]);
      s = cleaned.slice(0, chosen.index);
    } else {
      s = cleaned;
    }
  }

  const title = stripNoise(s)
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/\(\s*\)/g, '')
    .trim();

  return { title, year };
}

function detectEdition(raw) {
  const editions = ['Director\'s Cut', 'Extended', 'Unrated', 'Theatrical', 'IMAX', 'Remastered', 'Final Cut'];
  const lower = raw.toLowerCase();
  const found = editions.find((e) => lower.includes(e.toLowerCase().replace(/'/g, '')) || lower.includes(e.toLowerCase()));
  return found || null;
}

/**
 * Parse an episode path into { series, season, episode, episodeEnd, title }.
 * Returns null when nothing looks like an episode marker.
 */
export function parseEpisode(filePath, libraryRoot) {
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const parent = path.basename(dir);
  const grandparent = path.basename(path.dirname(dir));

  let season = null;
  let episode = null;
  let episodeEnd = null;
  let consumedIndex = -1;

  const multi = MULTI_EPISODE.exec(base);
  if (multi && Number(multi[3]) > Number(multi[2])) {
    season = multi[1] ? Number(multi[1]) : null;
    episode = Number(multi[2]);
    episodeEnd = Number(multi[3]);
    consumedIndex = multi.index;
  } else {
    for (const pattern of EPISODE_PATTERNS) {
      const m = pattern.re.exec(base);
      if (!m) continue;
      if (pattern.season === null) {
        episode = Number(m[pattern.episode]);
      } else {
        season = Number(m[pattern.season]);
        episode = Number(m[pattern.episode]);
      }
      consumedIndex = m.index;
      break;
    }
  }

  // A "Season 03" folder fills in the season the filename left out.
  const seasonFolder = SEASON_FOLDER.exec(parent);
  if (season === null && seasonFolder) {
    season = seasonFolder[1] ? Number(seasonFolder[1]) : 0; // "Specials" -> season 0
  }
  if (episode === null) return null;
  if (season === null) season = 1;

  // The series name is the nearest folder that isn't a season folder.
  let seriesRaw = SEASON_FOLDER.test(parent) ? grandparent : parent;
  if (!seriesRaw || seriesRaw === '.' || (libraryRoot && path.resolve(dir) === path.resolve(libraryRoot))) {
    // Flat layout: derive the series name from the part of the filename before SxxExx.
    seriesRaw = consumedIndex > 0 ? base.slice(0, consumedIndex) : base;
  }

  const series = extractTitleYear(seriesRaw);

  // Whatever follows the episode marker is usually the episode title. Strip the
  // leading separator first — otherwise the release-group rule reads "- Pilot"
  // as a group suffix and throws the title away.
  let episodeTitle = null;
  if (consumedIndex >= 0) {
    const afterMatch = base.slice(consumedIndex).replace(/^[^\s._-]*/, '');
    const leadStripped = normaliseSeparators(afterMatch).replace(/^[\s\-–—._]+/, '');
    const cleaned = stripNoise(leadStripped).trim();
    if (cleaned.length > 1) episodeTitle = cleaned;
  }

  return {
    series: series.title || normaliseSeparators(seriesRaw),
    seriesYear: series.year,
    season,
    episode,
    episodeEnd,
    episodeTitle,
  };
}

/**
 * Decide whether a path is a film or an episode without being told which
 * library it came from. Used by the "mixed" library mode.
 */
export function classify(filePath, libraryRoot) {
  const ep = parseEpisode(filePath, libraryRoot);
  if (ep) return { kind: 'episode', ...ep };
  return { kind: 'movie', ...parseMovie(filePath) };
}

export function parseSubtitleLanguage(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split('.');
  const forced = /forced/i.test(base);
  // "Movie.en.srt" / "Movie.eng.forced.srt"
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i].toLowerCase();
    if (/^[a-z]{2,3}$/.test(p) && p !== 'srt' && p !== 'vtt') {
      return { language: p, label: LANGUAGE_NAMES[p] || p.toUpperCase(), forced };
    }
  }
  return { language: 'und', label: 'Subtitles', forced };
}

export const LANGUAGE_NAMES = {
  en: 'English', eng: 'English', fr: 'French', fre: 'French', de: 'German', ger: 'German',
  es: 'Spanish', spa: 'Spanish', it: 'Italian', ita: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish', ru: 'Russian',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese',
  ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', cs: 'Czech', el: 'Greek', he: 'Hebrew',
};
