import { db } from '../db.js';
import { config } from '../config.js';
import * as library from '../library.js';
import { recommend, similarTo, tasteSummary, saveTasteProfile, getTasteProfile } from './engine.js';

/**
 * The tools NOVA can call. Every one of them reads or writes the same data the
 * rest of ECLIPSE uses — NOVA can only ever talk about films that are actually
 * on this server, which is the whole point.
 */

export const toolDefinitions = [
  {
    name: 'search_library',
    description:
      'Search the titles available on this ECLIPSE server by free text, genre, kind or year range. ' +
      'Use this whenever the user names a film or series, asks what is available, or asks for something ' +
      'by category. Returns only titles that actually exist on this server. Call this before claiming ' +
      'something is or is not in the library.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against title and synopsis. Omit to browse by filter alone.' },
        genre: { type: 'string', description: 'Restrict to one genre, e.g. "Science Fiction", "Comedy".' },
        kind: { type: 'string', enum: ['movie', 'series'], description: 'Restrict to films or to series.' },
        yearFrom: { type: 'integer', description: 'Earliest release year, inclusive.' },
        yearTo: { type: 'integer', description: 'Latest release year, inclusive.' },
        maxRuntime: { type: 'integer', description: 'Maximum runtime in minutes. Useful for "something short".' },
        limit: { type: 'integer', description: 'How many results to return. Default 12, maximum 40.' },
      },
    },
  },
  {
    name: 'get_recommendations',
    description:
      "Run ECLIPSE's taste engine for the current viewer and return ranked, unwatched titles with the " +
      'reason each one scored well. This is the primary tool for "what should I watch" questions — ' +
      'prefer it over picking from search results yourself, then explain and filter its output.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series'], description: 'Restrict to films or series.' },
        limit: { type: 'integer', description: 'How many to return. Default 10, maximum 30.' },
        includeWatched: { type: 'boolean', description: 'Include things already watched. Default false.' },
      },
    },
  },
  {
    name: 'get_similar_titles',
    description:
      'Given a title already on the server, find the closest matches in the library by shared genre, ' +
      'cast, director and themes. Use this when the user says "something like X".',
    input_schema: {
      type: 'object',
      properties: {
        titleId: { type: 'integer', description: 'The id of the seed title, from search_library.' },
        limit: { type: 'integer', description: 'How many to return. Default 8, maximum 20.' },
      },
      required: ['titleId'],
    },
  },
  {
    name: 'get_viewer_context',
    description:
      'Read the current viewer\'s taste profile, the strongest signals the engine has learned from their ' +
      'viewing, and what they recently watched or rated. Call this at the start of a recommendation ' +
      'conversation so your suggestions are grounded in their actual history rather than guesswork.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_title_details',
    description:
      'Full detail for one title: synopsis, cast, crew, runtime, rating, and — for series — the seasons ' +
      'and episodes present on this server, plus where the viewer left off.',
    input_schema: {
      type: 'object',
      properties: { titleId: { type: 'integer', description: 'The id of the title.' } },
      required: ['titleId'],
    },
  },
  {
    name: 'update_taste_profile',
    description:
      'Record something durable you have learned about the viewer\'s taste, so future sessions start ' +
      'from it. Only call this when they state a real preference ("I can\'t stand gore", "I love ' +
      'Denis Villeneuve") — not for a passing mood. Fields you omit are left unchanged; fields you ' +
      'provide replace the previous list entirely, so include existing entries you want to keep.',
    input_schema: {
      type: 'object',
      properties: {
        about: { type: 'string', description: 'A short free-text description of their taste, in your words.' },
        likedGenres: { type: 'array', items: { type: 'string' }, description: 'Genres they enjoy.' },
        dislikedGenres: { type: 'array', items: { type: 'string' }, description: 'Genres they want less of.' },
        favouritePeople: { type: 'array', items: { type: 'string' }, description: 'Actors, directors or creators they follow.' },
        moods: { type: 'array', items: { type: 'string' }, description: 'Themes or moods they gravitate to, e.g. "slow burn", "heist".' },
        avoid: { type: 'array', items: { type: 'string' }, description: 'Content to steer away from, e.g. "gore", "jump scares".' },
      },
    },
  },
  {
    name: 'add_to_watchlist',
    description: 'Add a title on this server to the viewer\'s watchlist so it is waiting for them on the home screen.',
    input_schema: {
      type: 'object',
      properties: { titleId: { type: 'integer', description: 'The id of the title to save.' } },
      required: ['titleId'],
    },
  },
];

/** Trim a title down to what's useful in a tool result — full rows waste context. */
function compact(t) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    year: t.year,
    runtime: t.runtime,
    rating: t.rating,
    certification: t.certification,
    genres: t.genres?.slice(0, 4),
    directors: t.directors?.slice(0, 2),
    creators: t.creators?.slice(0, 2),
    cast: t.cast?.slice(0, 4),
    overview: t.overview ? t.overview.slice(0, 300) : null,
    reason: t.reason,
    matchedOn: t.matchedOn,
  };
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * Execute one tool call. Returns { result, refs } where refs are title ids the
 * UI should render as cards alongside NOVA's reply.
 */
export function runTool(name, input, ctx) {
  const { userId } = ctx;

  switch (name) {
    case 'search_library': {
      const limit = clamp(input.limit, 1, 40, 12);
      let results = library.listTitles({
        kind: input.kind || null,
        genre: input.genre || null,
        search: input.query || null,
        limit: 200,
      });

      if (input.yearFrom) results = results.filter((t) => t.year && t.year >= input.yearFrom);
      if (input.yearTo) results = results.filter((t) => t.year && t.year <= input.yearTo);
      if (input.maxRuntime) results = results.filter((t) => !t.runtime || t.runtime <= input.maxRuntime);

      const sliced = results.slice(0, limit);
      return {
        result: {
          found: results.length,
          returned: sliced.length,
          titles: sliced.map(compact),
        },
        refs: sliced.map((t) => t.id),
      };
    }

    case 'get_recommendations': {
      const limit = clamp(input.limit, 1, 30, 10);
      const picks = recommend(userId, {
        limit,
        kind: input.kind || null,
        excludeSeen: !input.includeWatched,
      });
      return {
        result: {
          count: picks.length,
          note: picks.length ? undefined : 'Nothing scored — the library may be empty or everything has been watched.',
          recommendations: picks.map(compact),
        },
        refs: picks.map((t) => t.id),
      };
    }

    case 'get_similar_titles': {
      const seed = library.getTitle(input.titleId);
      if (!seed) return { result: { error: `No title with id ${input.titleId} on this server.` }, refs: [] };
      const limit = clamp(input.limit, 1, 20, 8);
      const items = similarTo(input.titleId, { limit });
      return {
        result: { seed: { id: seed.id, title: seed.title }, similar: items.map(compact) },
        refs: items.map((t) => t.id),
      };
    }

    case 'get_viewer_context': {
      const summary = tasteSummary(userId);
      const history = library.watchHistory(userId, 15);
      const watchlist = library.getWatchlist(userId, 10);
      const stats = library.libraryStats();
      return {
        result: {
          profile: summary.profile,
          strongestSignals: summary.topSignals,
          avoiding: summary.avoiding,
          recentlyWatched: history.map((t) => ({
            id: t.id,
            title: t.title,
            year: t.year,
            kind: t.kind,
            completed: t.completed,
            rating: t.userRating === 2 ? 'loved' : t.userRating === 1 ? 'liked' : t.userRating === -1 ? 'disliked' : null,
          })),
          watchlist: watchlist.map((t) => ({ id: t.id, title: t.title })),
          libraryStats: { films: stats.movies, series: stats.series, episodes: stats.episodes },
        },
        refs: [],
      };
    }

    case 'get_title_details': {
      const detail = library.getTitleDetail(input.titleId, userId);
      if (!detail) return { result: { error: `No title with id ${input.titleId} on this server.` }, refs: [] };
      return {
        result: {
          ...compact(detail),
          tagline: detail.tagline,
          overview: detail.overview,
          status: detail.status,
          inWatchlist: detail.inWatchlist,
          yourRating: detail.userRating,
          seasons: detail.seasons?.map((s) => ({
            number: s.number,
            name: s.name,
            episodesOnServer: s.episodes.length,
          })),
          resume: detail.resume
            ? { label: detail.resume.label, season: detail.resume.season, episode: detail.resume.episode }
            : null,
        },
        refs: [detail.id],
      };
    }

    case 'update_taste_profile': {
      const saved = saveTasteProfile(userId, {
        about: input.about,
        likedGenres: input.likedGenres,
        dislikedGenres: input.dislikedGenres,
        favouritePeople: input.favouritePeople,
        moods: input.moods,
        avoid: input.avoid,
      });
      return { result: { saved: true, profile: saved }, refs: [] };
    }

    case 'add_to_watchlist': {
      const t = library.getTitle(input.titleId);
      if (!t) return { result: { error: `No title with id ${input.titleId} on this server.` }, refs: [] };
      db.prepare('INSERT OR IGNORE INTO watchlist (user_id, title_id) VALUES (?, ?)').run(userId, input.titleId);
      return { result: { added: true, title: t.title }, refs: [t.id] };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` }, refs: [] };
  }
}

/** Context handed to NOVA up front so it doesn't have to ask for the basics. */
export function buildSystemPrompt(user) {
  const stats = library.libraryStats();
  const genres = library
    .allGenres()
    .slice(0, 20)
    .map((g) => `${g.name} (${g.count})`)
    .join(', ');
  const profile = getTasteProfile(user.id);

  return `You are NOVA, the resident film and television curator built into ECLIPSE — a private streaming server running on someone's home network.

You are talking to ${user.display_name}. This server holds ${stats.movies} film${stats.movies === 1 ? '' : 's'} and ${stats.series} series (${stats.episodes} episodes).${genres ? ` The genres present are: ${genres}.` : ''}

## What you are for
Helping this household decide what to watch tonight, from what they actually own. You know their viewing history and taste profile, and you get better at this the more they watch.

## Ground rules
- Only ever recommend titles that are on this server. Use search_library or get_recommendations to confirm something exists before you mention it. If they ask for a film that isn't here, say so plainly and offer the closest thing that is.
- Call get_viewer_context at the start of a recommendation conversation. Their history is the whole point; guessing wastes it.
- Lead with the recommendation, not the preamble. Two or three specific picks beats a list of ten.
- Say *why* each pick fits them — connect it to something they watched, rated or told you. "Because you liked X" is more useful than a synopsis they can read on the title page.
- When they state a durable preference, record it with update_taste_profile so the next session starts from it. Don't record passing moods ("something light tonight") — only lasting taste.
- Match the mood they're in. "Something short and funny" is a constraint, not a suggestion: use maxRuntime and genre filters rather than recommending a three-hour drama.
- The title cards appear beside your reply automatically, so don't recite full metadata. Name the title and give the reason.

## Voice
Warm, direct, and specific — a friend with genuinely good taste who has seen everything on this server. Opinions are welcome; hedging isn't. Keep replies to a few sentences unless they ask you to go deeper.${
    profile.about ? `\n\n## What you already know about ${user.display_name}\n${profile.about}` : ''
  }`;
}
