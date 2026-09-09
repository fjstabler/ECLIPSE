import { db } from './db.js';
import { log } from './log.js';

/**
 * Folding several titles into one.
 *
 * A scan can split one series across several titles — a season folder named
 * in a way the parser doesn't recognise as a season, and each one becomes its
 * own show. Until now that was permanent: a rescan deliberately keeps a file
 * attached to the title it already has (that's what stops a title you edited
 * drifting back to whatever its filename says), so nothing short of editing
 * the database could put the pieces back together.
 *
 * Merging moves everything — files, seasons, episodes, and what each person
 * watched of them — onto one title and removes the husks.
 */

/** Titles that plausibly belong together, for the picker to offer. */
export function mergeCandidates(titleId) {
  const target = db.prepare('SELECT id, kind, title, sort_title FROM titles WHERE id = ?').get(titleId);
  if (!target) return [];

  // The leading words of the name, which is what survives a bad split: a
  // series broken up by season keeps its own name at the front of each piece.
  const stem = target.sort_title.split(/[\s:.-]+/).slice(0, 2).join(' ');

  return db
    .prepare(`
      SELECT t.id, t.title, t.year, t.poster, t.kind,
             (SELECT COUNT(*) FROM media_files WHERE title_id = t.id) AS files,
             (SELECT COUNT(*) FROM episodes WHERE title_id = t.id) AS episodes
      FROM titles t
      WHERE t.id != @id AND t.kind = @kind AND (t.sort_title LIKE @stem OR @stem LIKE t.sort_title || '%')
      ORDER BY t.sort_title
      LIMIT 40
    `)
    .all({ id: target.id, kind: target.kind, stem: `${stem}%` });
}

/**
 * Merge `sourceIds` into `targetId`. Returns what moved.
 *
 * Runs as one transaction: a merge that half-succeeded would leave a library
 * in a worse state than the one being fixed.
 */
export function mergeTitles(targetId, sourceIds) {
  const target = db.prepare('SELECT * FROM titles WHERE id = ?').get(targetId);
  if (!target) throw new Error('No title with that id');

  const sources = sourceIds
    .map(Number)
    .filter((id) => id && id !== targetId)
    .map((id) => db.prepare('SELECT * FROM titles WHERE id = ?').get(id))
    .filter(Boolean);

  if (!sources.length) throw new Error('Nothing to merge');
  const wrongKind = sources.find((s) => s.kind !== target.kind);
  if (wrongKind) throw new Error(`"${wrongKind.title}" is a ${wrongKind.kind} and "${target.title}" is a ${target.kind}`);

  const run = db.transaction(() => {
    let files = 0;
    let episodes = 0;

    for (const source of sources) {
      for (const season of db.prepare('SELECT * FROM seasons WHERE title_id = ?').all(source.id)) {
        // A season the target already has absorbs the source's episodes;
        // otherwise the season row itself moves across.
        const existingSeason = db
          .prepare('SELECT id FROM seasons WHERE title_id = ? AND number = ?')
          .get(target.id, season.number);

        const seasonId = existingSeason
          ? existingSeason.id
          : db.prepare(`
              INSERT INTO seasons (title_id, number, name, overview, poster)
              VALUES (?, ?, ?, ?, ?)
            `).run(target.id, season.number, season.name, season.overview, season.poster).lastInsertRowid;

        for (const ep of db.prepare('SELECT * FROM episodes WHERE season_id = ?').all(season.id)) {
          const clash = db
            .prepare('SELECT id FROM episodes WHERE title_id = ? AND season = ? AND number = ?')
            .get(target.id, ep.season, ep.number);

          if (clash) {
            // Both sides have this episode. The target's row wins and the
            // source's file joins it as another version — which is what two
            // copies of one episode actually are.
            db.prepare('UPDATE media_files SET episode_id = ?, title_id = ? WHERE episode_id = ?')
              .run(clash.id, target.id, ep.id);
            db.prepare('UPDATE playback_state SET title_id = ? WHERE title_id = ?').run(target.id, source.id);
            db.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id);
          } else {
            db.prepare('UPDATE episodes SET title_id = ?, season_id = ? WHERE id = ?')
              .run(target.id, seasonId, ep.id);
            episodes += 1;
          }
        }

        if (!existingSeason) continue;
        db.prepare('DELETE FROM seasons WHERE id = ?').run(season.id);
      }

      files += db.prepare('UPDATE media_files SET title_id = ? WHERE title_id = ?').run(target.id, source.id).changes;

      // What people watched follows the files. The per-user tables are keyed
      // on (user, title), so anyone who had both titles would collide —
      // ignore the duplicate and keep the target's row.
      db.prepare('UPDATE playback_state SET title_id = ? WHERE title_id = ?').run(target.id, source.id);
      db.prepare('UPDATE watch_events SET title_id = ? WHERE title_id = ?').run(target.id, source.id);
      for (const table of ['ratings', 'favourites', 'watchlist']) {
        db.prepare(`UPDATE OR IGNORE ${table} SET title_id = ? WHERE title_id = ?`).run(target.id, source.id);
        db.prepare(`DELETE FROM ${table} WHERE title_id = ?`).run(source.id);
      }

      // Tags worth keeping that the target hasn't got — a season folder that
      // became its own title may carry the only cast list.
      db.prepare(`
        INSERT OR IGNORE INTO title_tags (title_id, tag_type, tag_value, weight, ordering, image)
        SELECT ?, tag_type, tag_value, weight, ordering, image FROM title_tags WHERE title_id = ?
      `).run(target.id, source.id);

      db.prepare('DELETE FROM titles WHERE id = ?').run(source.id);
    }

    return { files, episodes };
  });

  const moved = run();
  log.info(
    'library',
    `Merged ${sources.length} title${sources.length === 1 ? '' : 's'} into "${target.title}"`,
    `${moved.files} file(s), ${moved.episodes} episode(s) — from ${sources.map((s) => s.title).join(', ')}`
  );
  return { ...moved, merged: sources.length, title: target.title };
}
