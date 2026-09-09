/**
 * Age ratings, and what a profile is allowed to see.
 *
 * Certifications are regional and TMDB returns whatever the region uses, so
 * this maps the common British, American and television systems onto one
 * scale. A rating nobody recognises is treated as unrated rather than as
 * "allowed": a children's profile should not be shown something just because
 * ECLIPSE couldn't classify it.
 */

const RANKS = {
  // United Kingdom (BBFC)
  U: 0, UC: 0, PG: 1, '12': 2, '12A': 2, '15': 3, '18': 4, R18: 5,
  // United States (MPA)
  G: 0, 'PG-13': 2, R: 3, 'NC-17': 4, 'NR': null, 'UNRATED': null,
  // Television
  'TV-Y': 0, 'TV-Y7': 0, 'TV-G': 0, 'TV-PG': 1, 'TV-14': 2, 'TV-MA': 4,
  // Ireland / others that turn up alongside UK data
  GA: 0, '16': 3, '18+': 4,
};

/** The ladder a profile's limit is chosen from, mildest first. */
export const RATING_LADDER = ['U', 'PG', '12', '15', '18'];

export function ratingRank(certification) {
  if (!certification) return null;
  const key = String(certification).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(RANKS, key) ? RANKS[key] : null;
}

/**
 * Whether a profile limited to `maxRating` may see a title certified
 * `certification`. An unclassified title is blocked for a limited profile —
 * the safe direction to be wrong in.
 */
export function isAllowed(certification, maxRating) {
  if (!maxRating) return true;
  const limit = ratingRank(maxRating);
  if (limit === null) return true;
  const rank = ratingRank(certification);
  if (rank === null) return false;
  return rank <= limit;
}

/**
 * A SQL fragment for the same rule, so a restricted profile's queries never
 * load the rows in the first place. Written out rather than parameterised
 * because the values are drawn from RANKS, not from user input.
 */
export function ratingSqlFilter(maxRating) {
  if (!maxRating) return null;
  const limit = ratingRank(maxRating);
  if (limit === null) return null;

  const allowed = Object.entries(RANKS)
    .filter(([, rank]) => rank !== null && rank <= limit)
    .map(([cert]) => `'${cert.replace(/'/g, "''")}'`);

  if (!allowed.length) return 'AND 0';
  return `AND t.certification IS NOT NULL AND UPPER(TRIM(t.certification)) IN (${allowed.join(', ')})`;
}
