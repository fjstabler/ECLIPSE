/**
 * Age ratings, and what a profile is allowed to see.
 *
 * Certifications are regional and TMDB returns whatever the region uses, so
 * this maps the common British, American and television systems onto one
 * scale. A rating nobody recognises is treated as unrated rather than as
 * "allowed": a children's profile should not be shown something just because
 * ECLIPSE couldn't classify it.
 */

import { db } from './db.js';

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

const certificationForFile = db.prepare(
  'SELECT t.certification FROM media_files mf JOIN titles t ON t.id = mf.title_id WHERE mf.id = ?'
);

/**
 * Whether a profile may play a specific file.
 *
 * Hiding a title from the shelves is presentation; this is the part that
 * actually enforces the limit. A file id is guessable, clients cache them,
 * and a title that has been hidden since the last sync is still one HTTP
 * request away — so every route that hands over bytes, or records that
 * someone watched them, asks here rather than trusting that the viewer could
 * only have arrived from a page they were allowed to see.
 */
export function canPlayFile(fileId, user) {
  if (!user?.max_rating) return true;
  const row = certificationForFile.get(fileId);
  // A file with no title behind it is a 404 elsewhere; don't let it pass here.
  if (!row) return false;
  return isAllowed(row.certification, user.max_rating);
}

/**
 * Express guard for the routes that serve or record media, keyed on whichever
 * of the usual places the file id arrives in.
 */
export function requirePermittedFile(req, res, next) {
  const fileId = Number(req.params.fileId ?? req.body?.fileId ?? req.query?.fileId);
  if (!Number.isFinite(fileId)) return next();
  if (!canPlayFile(fileId, req.user)) {
    return res.status(403).json({ error: 'This title is not available on this profile' });
  }
  next();
}
