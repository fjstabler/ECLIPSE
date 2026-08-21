import { config } from '../config.js';

const BASE = 'https://api.themoviedb.org/3';

// TMDB rate-limits generously but a scan of a big library can still burst.
// One request at a time with a small gap keeps us comfortably inside it.
let chain = Promise.resolve();
const MIN_GAP_MS = 60;

function schedule(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, MIN_GAP_MS)),
    () => new Promise((r) => setTimeout(r, MIN_GAP_MS))
  );
  return run;
}

export function hasTmdb() {
  return Boolean(config.tmdb.apiKey);
}

let warnedBadKey = false;
function warnBadKeyOnce() {
  if (warnedBadKey) return;
  warnedBadKey = true;
  console.warn(
    '\n[metadata] TMDB rejected your API key, so artwork and synopses cannot be fetched.\n' +
    '           Your films and series will still appear and play, with placeholder posters.\n' +
    '           Check TMDB_API_KEY in your .env file — run `npm run setup` to change it —\n' +
    '           then restart and run a scan from Settings → Library.\n'
  );
}

async function request(endpoint, params = {}) {
  if (!hasTmdb()) throw new Error('TMDB_API_KEY is not configured');
  const url = new URL(BASE + endpoint);
  url.searchParams.set('language', config.tmdb.language);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = { accept: 'application/json' };
  // TMDB accepts either a v3 key as a query param or a v4 token as a bearer.
  if (config.tmdb.apiKey.startsWith('ey')) {
    headers.authorization = `Bearer ${config.tmdb.apiKey}`;
  } else {
    url.searchParams.set('api_key', config.tmdb.apiKey);
  }

  return schedule(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') || 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        // A rejected key would otherwise show up as a cryptic "TMDB 401" once
        // per title, which reads like a network fault rather than a typo.
        if (res.status === 401) warnBadKeyOnce();
        throw new Error(`TMDB ${res.status} on ${endpoint}`);
      }
      return res.json();
    }
    throw new Error(`TMDB rate limit exhausted on ${endpoint}`);
  });
}

function imageUrl(pathPart, size) {
  if (!pathPart) return null;
  return `${config.tmdb.imageBase}/${size}${pathPart}`;
}

/** Score a candidate so the closest title+year match wins. */
function scoreCandidate(candidate, wantedTitle, wantedYear) {
  const name = (candidate.title || candidate.name || '').toLowerCase();
  const want = wantedTitle.toLowerCase();
  let score = 0;

  if (name === want) score += 100;
  else if (name.startsWith(want) || want.startsWith(name)) score += 60;
  else if (name.includes(want) || want.includes(name)) score += 30;

  const date = candidate.release_date || candidate.first_air_date || '';
  const year = date ? Number(date.slice(0, 4)) : null;
  if (wantedYear && year) {
    const diff = Math.abs(year - wantedYear);
    if (diff === 0) score += 50;
    else if (diff === 1) score += 20;
    else score -= diff * 8;
  }

  // Popularity is a tiebreaker only — it should never beat an exact title match.
  score += Math.min(candidate.popularity || 0, 40) / 8;
  return score;
}

export async function searchMovie(title, year) {
  const data = await request('/search/movie', { query: title, year, include_adult: false });
  const results = data.results || [];
  if (!results.length) {
    // A year in the filename is often the edition year, not the release year.
    if (year) return searchMovie(title, null);
    return null;
  }
  return results
    .map((r) => ({ r, s: scoreCandidate(r, title, year) }))
    .sort((a, b) => b.s - a.s)[0].r;
}

export async function searchSeries(title, year) {
  const data = await request('/search/tv', { query: title, first_air_date_year: year, include_adult: false });
  const results = data.results || [];
  if (!results.length) {
    if (year) return searchSeries(title, null);
    return null;
  }
  return results
    .map((r) => ({ r, s: scoreCandidate(r, title, year) }))
    .sort((a, b) => b.s - a.s)[0].r;
}

/**
 * The full candidate list for a search, for a picker UI rather than the
 * scanner's automatic best-guess. Ordered by the same scoring searchMovie
 * uses, just not collapsed down to one result.
 */
export async function searchMovieCandidates(query) {
  const data = await request('/search/movie', { query, include_adult: false });
  return (data.results || [])
    .map((r) => ({ r, s: scoreCandidate(r, query, null) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map(({ r }) => ({
      tmdbId: r.id,
      title: r.title,
      year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
      poster: imageUrl(r.poster_path, 'w185'),
      overview: r.overview || '',
    }));
}

export async function searchSeriesCandidates(query) {
  const data = await request('/search/tv', { query, include_adult: false });
  return (data.results || [])
    .map((r) => ({ r, s: scoreCandidate(r, query, null) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map(({ r }) => ({
      tmdbId: r.id,
      title: r.name,
      year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
      poster: imageUrl(r.poster_path, 'w185'),
      overview: r.overview || '',
    }));
}

export async function movieDetails(id) {
  const data = await request(`/movie/${id}`, {
    append_to_response: 'credits,keywords,videos,release_dates,images',
    include_image_language: `${config.tmdb.language.slice(0, 2)},en,null`,
  });
  return normaliseMovie(data);
}

export async function seriesDetails(id) {
  const data = await request(`/tv/${id}`, {
    append_to_response: 'credits,keywords,videos,content_ratings,images,external_ids',
    include_image_language: `${config.tmdb.language.slice(0, 2)},en,null`,
  });
  return normaliseSeries(data);
}

export async function seasonDetails(seriesId, seasonNumber) {
  return request(`/tv/${seriesId}/season/${seasonNumber}`);
}

function pickTrailer(videos) {
  const results = videos?.results || [];
  const trailer =
    results.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
    results.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    results.find((v) => v.site === 'YouTube' && v.type === 'Teaser');
  return trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
}

function pickLogo(images) {
  const logos = images?.logos || [];
  const preferred = logos.find((l) => l.iso_639_1 === 'en') || logos[0];
  return preferred ? imageUrl(preferred.file_path, 'w500') : null;
}

function certificationFromReleaseDates(data, region) {
  const entry = (data.release_dates?.results || []).find((r) => r.iso_3166_1 === region);
  const cert = entry?.release_dates?.find((d) => d.certification)?.certification;
  return cert || null;
}

function normaliseMovie(data) {
  const region = config.tmdb.language.split('-')[1] || 'US';
  return {
    kind: 'movie',
    tmdbId: data.id,
    imdbId: data.imdb_id || null,
    title: data.title,
    originalTitle: data.original_title,
    year: data.release_date ? Number(data.release_date.slice(0, 4)) : null,
    overview: data.overview || null,
    tagline: data.tagline || null,
    runtime: data.runtime || null,
    rating: data.vote_average || null,
    certification: certificationFromReleaseDates(data, region) || certificationFromReleaseDates(data, 'US'),
    status: data.status || null,
    poster: imageUrl(data.poster_path, 'w780'),
    backdrop: imageUrl(data.backdrop_path, 'w1280'),
    logo: pickLogo(data.images),
    trailerUrl: pickTrailer(data.videos),
    tags: collectTags(data, 'movie'),
  };
}

function normaliseSeries(data) {
  const region = config.tmdb.language.split('-')[1] || 'US';
  const ratings = data.content_ratings?.results || [];
  const cert =
    ratings.find((r) => r.iso_3166_1 === region)?.rating ||
    ratings.find((r) => r.iso_3166_1 === 'US')?.rating ||
    null;

  return {
    kind: 'series',
    tmdbId: data.id,
    imdbId: data.external_ids?.imdb_id || null,
    title: data.name,
    originalTitle: data.original_name,
    year: data.first_air_date ? Number(data.first_air_date.slice(0, 4)) : null,
    overview: data.overview || null,
    tagline: data.tagline || null,
    runtime: data.episode_run_time?.[0] || null,
    rating: data.vote_average || null,
    certification: cert,
    status: data.status || null,
    poster: imageUrl(data.poster_path, 'w780'),
    backdrop: imageUrl(data.backdrop_path, 'w1280'),
    logo: pickLogo(data.images),
    trailerUrl: pickTrailer(data.videos),
    seasons: (data.seasons || []).map((s) => ({
      number: s.season_number,
      name: s.name,
      overview: s.overview,
      poster: imageUrl(s.poster_path, 'w342'),
      episodeCount: s.episode_count,
    })),
    tags: collectTags(data, 'series'),
  };
}

/**
 * Flatten genres, keywords, cast and crew into the tag rows the recommendation
 * engine scores against.
 */
function collectTags(data, kind) {
  const tags = [];

  for (const [i, g] of (data.genres || []).entries()) {
    tags.push({ type: 'genre', value: g.name, weight: 1, ordering: i });
  }

  const keywords = data.keywords?.keywords || data.keywords?.results || [];
  for (const [i, k] of keywords.slice(0, 25).entries()) {
    tags.push({ type: 'keyword', value: k.name, weight: 0.6, ordering: i });
  }

  const cast = data.credits?.cast || [];
  for (const [i, c] of cast.slice(0, 12).entries()) {
    // Top billing carries more signal than the twelfth name on the call sheet.
    tags.push({ type: 'cast', value: c.name, weight: Math.max(0.3, 1 - i * 0.06), ordering: i });
  }

  const crew = data.credits?.crew || [];
  if (kind === 'movie') {
    for (const [i, d] of crew.filter((c) => c.job === 'Director').entries()) {
      tags.push({ type: 'director', value: d.name, weight: 1.2, ordering: i });
    }
    for (const [i, w] of crew.filter((c) => c.job === 'Screenplay' || c.job === 'Writer').slice(0, 3).entries()) {
      tags.push({ type: 'writer', value: w.name, weight: 0.7, ordering: i });
    }
  } else {
    for (const [i, c] of (data.created_by || []).entries()) {
      tags.push({ type: 'creator', value: c.name, weight: 1.2, ordering: i });
    }
  }

  for (const [i, c] of (data.production_companies || data.networks || []).slice(0, 4).entries()) {
    tags.push({ type: 'studio', value: c.name, weight: 0.4, ordering: i });
  }

  return tags;
}
