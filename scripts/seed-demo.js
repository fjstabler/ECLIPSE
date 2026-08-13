/**
 * Seed a demo library so the interface can be judged before any real media is
 * added. Creates title, season and episode rows with a stub file each.
 *
 * If TMDB_API_KEY is set the seeder pulls real artwork and synopses; without
 * it, ECLIPSE's own generated posters are used. Either way the tag data is
 * real enough that N.O.V.A.'s recommendations behave the way they will in
 * production.
 *
 *   npm run demo            seed the demo library
 *   npm run demo -- --clear remove it again
 */

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { config, paths } from '../server/config.js';
import { sortTitle } from '../server/util/parse.js';
import { placeholderPoster, placeholderBackdrop, cacheImage } from '../server/metadata/artwork.js';
import * as tmdb from '../server/metadata/tmdb.js';

const DEMO_DIR = path.join(config.dataDir, 'demo-media');

const FILMS = [
  {
    title: 'Arrival', year: 2016, runtime: 116, rating: 7.6, certification: '12A',
    tagline: 'Why are they here?',
    overview: 'A linguist is recruited by the military to communicate with alien lifeforms after twelve mysterious spacecraft appear around the world.',
    genres: ['Science Fiction', 'Drama', 'Mystery'],
    directors: ['Denis Villeneuve'], cast: ['Amy Adams', 'Jeremy Renner', 'Forest Whitaker'],
    keywords: ['first contact', 'linguistics', 'slow burn', 'time loop'],
  },
  {
    title: 'Blade Runner 2049', year: 2017, runtime: 164, rating: 7.6, certification: '15',
    tagline: 'The key to the future is finally unearthed.',
    overview: 'A young blade runner uncovers a secret that could plunge what remains of society into chaos, and sets out to find a man missing for thirty years.',
    genres: ['Science Fiction', 'Drama', 'Thriller'],
    directors: ['Denis Villeneuve'], cast: ['Ryan Gosling', 'Harrison Ford', 'Ana de Armas'],
    keywords: ['dystopian', 'replicant', 'slow burn', 'neo-noir'],
  },
  {
    title: 'Heat', year: 1995, runtime: 170, rating: 8.0, certification: '15',
    tagline: 'A Los Angeles crime saga.',
    overview: 'A career thief and the detective pursuing him find they have more in common than either would like to admit.',
    genres: ['Crime', 'Drama', 'Thriller'],
    directors: ['Michael Mann'], cast: ['Al Pacino', 'Robert De Niro', 'Val Kilmer'],
    keywords: ['heist', 'ensemble cast', 'obsession'],
  },
  {
    title: 'The Grand Budapest Hotel', year: 2014, runtime: 99, rating: 8.1, certification: '15',
    tagline: 'A perfect holiday, without a hitch.',
    overview: 'A legendary concierge and his most trusted lobby boy become embroiled in the theft of a priceless painting and a battle over an enormous fortune.',
    genres: ['Comedy', 'Drama', 'Adventure'],
    directors: ['Wes Anderson'], cast: ['Ralph Fiennes', 'Tony Revolori', 'Saoirse Ronan'],
    keywords: ['dark comedy', 'period drama', 'ensemble cast', 'caper'],
  },
  {
    title: 'Parasite', year: 2019, runtime: 132, rating: 8.5, certification: '15',
    tagline: 'Act like you own the place.',
    overview: 'A poor family schemes to become employed by a wealthy household by infiltrating it and posing as unrelated, highly qualified individuals.',
    genres: ['Thriller', 'Drama', 'Comedy'],
    directors: ['Bong Joon-ho'], cast: ['Song Kang-ho', 'Lee Sun-kyun', 'Cho Yeo-jeong'],
    keywords: ['class divide', 'dark comedy', 'single location', 'twist'],
  },
  {
    title: 'Mad Max: Fury Road', year: 2015, runtime: 120, rating: 7.6, certification: '15',
    tagline: 'What a lovely day.',
    overview: 'In a post-apocalyptic wasteland, a drifter and a rebel warrior flee from a tyrant in a relentless convoy chase across the desert.',
    genres: ['Action', 'Adventure', 'Science Fiction'],
    directors: ['George Miller'], cast: ['Tom Hardy', 'Charlize Theron', 'Nicholas Hoult'],
    keywords: ['dystopian', 'car chase', 'practical effects'],
  },
  {
    title: 'Knives Out', year: 2019, runtime: 130, rating: 7.9, certification: '12A',
    tagline: 'Hell, any of them could have done it.',
    overview: 'A detective investigates the death of the patriarch of an eccentric, combative family at his estate.',
    genres: ['Mystery', 'Comedy', 'Crime'],
    directors: ['Rian Johnson'], cast: ['Daniel Craig', 'Ana de Armas', 'Chris Evans'],
    keywords: ['whodunnit', 'ensemble cast', 'single location', 'dark comedy'],
  },
  {
    title: 'Spirited Away', year: 2001, runtime: 125, rating: 8.5, certification: 'PG',
    tagline: 'The tunnel led Chihiro to a mysterious town.',
    overview: 'A ten-year-old girl wanders into a world ruled by gods and witches, where humans are turned into beasts, and must find a way to free her parents.',
    genres: ['Animation', 'Fantasy', 'Adventure'],
    directors: ['Hayao Miyazaki'], cast: ['Rumi Hiiragi', 'Miyu Irino', 'Mari Natsuki'],
    keywords: ['coming of age', 'hand drawn', 'folklore'],
  },
  {
    title: 'Whiplash', year: 2014, runtime: 106, rating: 8.4, certification: '15',
    tagline: 'The road to greatness can take you to the edge.',
    overview: 'A promising young drummer enrols at a cut-throat music conservatory where his dreams are mentored by an instructor who will stop at nothing to realise a student\'s potential.',
    genres: ['Drama', 'Music'],
    directors: ['Damien Chazelle'], cast: ['Miles Teller', 'J.K. Simmons', 'Paul Reiser'],
    keywords: ['obsession', 'mentor', 'single location'],
  },
  {
    title: 'Everything Everywhere All at Once', year: 2022, runtime: 139, rating: 7.8, certification: '15',
    tagline: 'The universe is so much bigger than you realise.',
    overview: 'An exhausted laundromat owner discovers she must connect with parallel-universe versions of herself to prevent a powerful being from destroying the multiverse.',
    genres: ['Action', 'Adventure', 'Science Fiction', 'Comedy'],
    directors: ['Daniel Kwan', 'Daniel Scheinert'], cast: ['Michelle Yeoh', 'Ke Huy Quan', 'Stephanie Hsu'],
    keywords: ['mind-bending', 'multiverse', 'family', 'feel-good'],
  },
  {
    title: 'No Country for Old Men', year: 2007, runtime: 122, rating: 8.2, certification: '15',
    tagline: "There are no clean getaways.",
    overview: 'A hunter stumbles on a drug deal gone wrong and takes the money, setting an implacable killer on his trail across the Texas border country.',
    genres: ['Crime', 'Drama', 'Thriller'],
    directors: ['Joel Coen', 'Ethan Coen'], cast: ['Javier Bardem', 'Josh Brolin', 'Tommy Lee Jones'],
    keywords: ['slow burn', 'neo-western', 'cat and mouse'],
  },
  {
    title: 'Paddington 2', year: 2017, runtime: 103, rating: 7.8, certification: 'PG',
    tagline: 'The bear is back.',
    overview: 'Paddington picks up odd jobs to buy the perfect present for his aunt, only for the gift to be stolen and the blame to fall on him.',
    genres: ['Family', 'Comedy', 'Adventure'],
    directors: ['Paul King'], cast: ['Ben Whishaw', 'Hugh Grant', 'Sally Hawkins'],
    keywords: ['feel-good', 'wholesome', 'london'],
  },
];

const SERIES = [
  {
    title: 'Severance', year: 2022, runtime: 50, rating: 8.7, certification: '15', status: 'Returning Series',
    tagline: 'Whose life is it anyway?',
    overview: 'Employees at a mysterious corporation undergo a procedure that surgically divides their memories between work and personal life.',
    genres: ['Drama', 'Mystery', 'Science Fiction'],
    creators: ['Dan Erickson'], cast: ['Adam Scott', 'Britt Lower', 'Patricia Arquette'],
    keywords: ['slow burn', 'dystopian', 'workplace', 'mind-bending'],
    seasons: [
      { number: 1, episodes: ['Good News About Hell', 'Half Loop', 'In Perpetuity', 'The You You Are', 'The Grim Barbarity of Optics and Design'] },
      { number: 2, episodes: ['Hello, Ms. Cobel', 'Goodbye, Mrs. Selvig', 'Who Is Alive?'] },
    ],
  },
  {
    title: 'Chernobyl', year: 2019, runtime: 62, rating: 9.3, certification: '15', status: 'Ended',
    tagline: 'What is the cost of lies?',
    overview: 'A dramatisation of the 1986 nuclear accident and the sacrifices made by those who contained the disaster.',
    genres: ['Drama', 'History', 'Thriller'],
    creators: ['Craig Mazin'], cast: ['Jared Harris', 'Stellan Skarsgård', 'Emily Watson'],
    keywords: ['true story', 'slow burn', 'period drama', 'disaster'],
    seasons: [{ number: 1, episodes: ['1:23:45', 'Please Remain Calm', 'Open Wide, O Earth', 'The Happiness of All Mankind', 'Vichnaya Pamyat'] }],
  },
  {
    title: 'The Bear', year: 2022, runtime: 30, rating: 8.4, certification: '15', status: 'Returning Series',
    tagline: 'Every second counts.',
    overview: 'A fine-dining chef returns to Chicago to run his late brother\'s chaotic sandwich shop.',
    genres: ['Drama', 'Comedy'],
    creators: ['Christopher Storer'], cast: ['Jeremy Allen White', 'Ayo Edebiri', 'Ebon Moss-Bachrach'],
    keywords: ['single location', 'grief', 'kitchen', 'ensemble cast'],
    seasons: [
      { number: 1, episodes: ['System', 'Hands', 'Brigade', 'Dogs', 'Sheridan', 'Ceres'] },
      { number: 2, episodes: ['Beef', 'Pasta', 'Sundae'] },
    ],
  },
  {
    title: 'Fleabag', year: 2016, runtime: 27, rating: 8.7, certification: '15', status: 'Ended',
    tagline: 'Everyone has a secret.',
    overview: 'A dry-witted woman navigates grief, family and disastrous romance in London, narrating her life directly to the audience.',
    genres: ['Comedy', 'Drama'],
    creators: ['Phoebe Waller-Bridge'], cast: ['Phoebe Waller-Bridge', 'Sian Clifford', 'Andrew Scott'],
    keywords: ['dark comedy', 'grief', 'london', 'fourth wall'],
    seasons: [
      { number: 1, episodes: ['Episode 1', 'Episode 2', 'Episode 3'] },
      { number: 2, episodes: ['Episode 1', 'Episode 2', 'Episode 3'] },
    ],
  },
  {
    title: 'Breaking Bad', year: 2008, runtime: 47, rating: 8.9, certification: '18', status: 'Ended',
    tagline: 'All hail the king.',
    overview: 'A high-school chemistry teacher diagnosed with terminal cancer turns to manufacturing methamphetamine to secure his family\'s future.',
    genres: ['Drama', 'Crime', 'Thriller'],
    creators: ['Vince Gilligan'], cast: ['Bryan Cranston', 'Aaron Paul', 'Anna Gunn'],
    keywords: ['slow burn', 'transformation', 'crime empire'],
    seasons: [{ number: 1, episodes: ['Pilot', "Cat's in the Bag...", "...And the Bag's in the River", 'Cancer Man'] }],
  },
  {
    title: 'The Last of Us', year: 2023, runtime: 55, rating: 8.7, certification: '18', status: 'Returning Series',
    tagline: 'When you are lost in the darkness, look for the light.',
    overview: 'Twenty years after a fungal outbreak collapses civilisation, a hardened survivor is hired to smuggle a teenage girl out of a quarantine zone.',
    genres: ['Drama', 'Science Fiction', 'Adventure'],
    creators: ['Craig Mazin', 'Neil Druckmann'], cast: ['Pedro Pascal', 'Bella Ramsey', 'Anna Torv'],
    keywords: ['dystopian', 'road trip', 'video game', 'found family'],
    seasons: [{ number: 1, episodes: ['When You\'re Lost in the Darkness', 'Infected', 'Long, Long Time', 'Please Hold to My Hand'] }],
  },
];

// ---------------------------------------------------------------------------

/**
 * Remove the demo library, leaving anything of the user's own intact.
 *
 * The subtlety: if someone owns a film the demo also seeded — Arrival, Heat,
 * Breaking Bad are all likely — the scanner attaches their real file to the
 * same title row. Deleting that row cascades to media_files and would take
 * their own library entry with it. So titles are only removed once nothing
 * but demo files pointed at them.
 */
function clearDemo() {
  const demoFiles = db.prepare('SELECT id, title_id FROM media_files WHERE path LIKE ?').all(`${DEMO_DIR}%`);
  const touchedTitles = [...new Set(demoFiles.map((f) => f.title_id).filter(Boolean))];

  db.prepare('DELETE FROM media_files WHERE path LIKE ?').run(`${DEMO_DIR}%`);

  let removed = 0;
  const kept = [];
  for (const id of touchedTitles) {
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM media_files WHERE title_id = ?').get(id).n;
    if (remaining === 0) {
      db.prepare('DELETE FROM titles WHERE id = ?').run(id);
      removed += 1;
    } else {
      const title = db.prepare('SELECT title FROM titles WHERE id = ?').get(id);
      if (title) kept.push(title.title);
    }
  }

  // Episodes and seasons whose files have gone.
  db.exec(`
    DELETE FROM episodes WHERE id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL);
    DELETE FROM seasons WHERE id NOT IN (SELECT season_id FROM episodes WHERE season_id IS NOT NULL);
  `);

  if (fs.existsSync(DEMO_DIR)) fs.rmSync(DEMO_DIR, { recursive: true, force: true });

  console.log(`\nRemoved ${removed} demo title${removed === 1 ? '' : 's'}.`);
  if (kept.length) {
    console.log(`\nKept ${kept.length} you also own, now showing only your own files:`);
    for (const name of kept) console.log(`  · ${name}`);
    console.log('\nRun `npm run scan` to refresh their details from your files.');
  }

  const left = db.prepare('SELECT COUNT(*) AS n FROM media_files').get().n;
  console.log(`\n${left} file${left === 1 ? '' : 's'} left in your library — all your own.\n`);
}

function stubFile(relPath) {
  const full = path.join(DEMO_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) {
    // A placeholder so the file row points at something real on disk. Demo
    // titles are for judging the interface; they don't play.
    fs.writeFileSync(full, 'ECLIPSE demo placeholder — replace with real media to play.\n');
  }
  return full;
}

function insertTitle(kind, spec, meta) {
  const poster = meta?.poster || placeholderPoster(spec.title, spec.year, kind);
  const backdrop = meta?.backdrop || placeholderBackdrop(spec.title);

  const info = db.prepare(`
    INSERT INTO titles (kind, title, sort_title, year, overview, tagline, runtime, rating, certification,
                        status, poster, backdrop, logo, tmdb_id, metadata_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    meta?.title || spec.title,
    sortTitle(spec.title),
    meta?.year || spec.year,
    meta?.overview || spec.overview,
    meta?.tagline || spec.tagline || null,
    meta?.runtime || spec.runtime,
    meta?.rating || spec.rating,
    meta?.certification || spec.certification,
    meta?.status || spec.status || null,
    poster,
    backdrop,
    meta?.logo || null,
    meta?.tmdbId || null,
    meta ? 'matched' : 'unmatched'
  );

  const titleId = info.lastInsertRowid;

  const tags = meta?.tags?.length
    ? meta.tags
    : [
        ...(spec.genres || []).map((v, i) => ({ type: 'genre', value: v, weight: 1, ordering: i })),
        ...(spec.keywords || []).map((v, i) => ({ type: 'keyword', value: v, weight: 0.6, ordering: i })),
        ...(spec.cast || []).map((v, i) => ({ type: 'cast', value: v, weight: 1 - i * 0.06, ordering: i })),
        ...(spec.directors || []).map((v, i) => ({ type: 'director', value: v, weight: 1.2, ordering: i })),
        ...(spec.creators || []).map((v, i) => ({ type: 'creator', value: v, weight: 1.2, ordering: i })),
      ];

  const insertTag = db.prepare(
    'INSERT OR REPLACE INTO title_tags (title_id, tag_type, tag_value, weight, ordering) VALUES (?, ?, ?, ?, ?)'
  );
  for (const t of tags) insertTag.run(titleId, t.type, t.value, t.weight, t.ordering);

  return titleId;
}

async function fetchMeta(kind, spec) {
  if (!tmdb.hasTmdb()) return null;
  try {
    const hit = kind === 'movie'
      ? await tmdb.searchMovie(spec.title, spec.year)
      : await tmdb.searchSeries(spec.title, spec.year);
    if (!hit) return null;
    const meta = kind === 'movie' ? await tmdb.movieDetails(hit.id) : await tmdb.seriesDetails(hit.id);
    meta.poster = await cacheImage(meta.poster);
    meta.backdrop = await cacheImage(meta.backdrop);
    meta.logo = await cacheImage(meta.logo);
    return meta;
  } catch (err) {
    console.warn(`  metadata lookup failed for ${spec.title}: ${err.message}`);
    return null;
  }
}

async function seed() {
  console.log(`Seeding demo library${tmdb.hasTmdb() ? ' with real metadata from TMDB' : ' with generated artwork'}…`);
  fs.mkdirSync(DEMO_DIR, { recursive: true });

  for (const spec of FILMS) {
    const meta = await fetchMeta('movie', spec);
    const titleId = insertTitle('movie', spec, meta);
    const file = stubFile(path.join('Films', `${spec.title} (${spec.year})`, `${spec.title} (${spec.year}).mp4`));
    db.prepare(`
      INSERT INTO media_files (title_id, path, filename, extension, size, mtime, duration, width, height,
                               video_codec, audio_codec, direct_play)
      VALUES (?, ?, ?, '.mp4', ?, ?, ?, 1920, 1080, 'h264', 'aac', 1)
    `).run(titleId, file, path.basename(file), 1_400_000_000, Date.now(), (spec.runtime || 100) * 60);
    console.log(`  film    ${spec.title}`);
  }

  for (const spec of SERIES) {
    const meta = await fetchMeta('series', spec);
    const titleId = insertTitle('series', spec, meta);

    for (const season of spec.seasons) {
      db.prepare('INSERT INTO seasons (title_id, number, name) VALUES (?, ?, ?)')
        .run(titleId, season.number, `Season ${season.number}`);
      const seasonId = db.prepare('SELECT id FROM seasons WHERE title_id = ? AND number = ?')
        .get(titleId, season.number).id;

      for (const [i, name] of season.episodes.entries()) {
        const number = i + 1;
        db.prepare(`
          INSERT INTO episodes (title_id, season_id, season, number, name, overview, runtime)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(titleId, seasonId, season.number, number, name,
               `${spec.title} — season ${season.number}, episode ${number}.`, spec.runtime);

        const episodeId = db.prepare('SELECT id FROM episodes WHERE title_id = ? AND season = ? AND number = ?')
          .get(titleId, season.number, number).id;

        const pad = String(number).padStart(2, '0');
        const file = stubFile(path.join(
          'Series', spec.title, `Season ${String(season.number).padStart(2, '0')}`,
          `${spec.title} - S${String(season.number).padStart(2, '0')}E${pad} - ${name.replace(/[/\\:]/g, '')}.mp4`
        ));

        db.prepare(`
          INSERT INTO media_files (title_id, episode_id, path, filename, extension, size, mtime, duration,
                                   width, height, video_codec, audio_codec, direct_play)
          VALUES (?, ?, ?, ?, '.mp4', ?, ?, ?, 1920, 1080, 'h264', 'aac', 1)
        `).run(titleId, episodeId, file, path.basename(file), 900_000_000, Date.now(), (spec.runtime || 45) * 60);
      }
    }
    console.log(`  series  ${spec.title} (${spec.seasons.reduce((n, s) => n + s.episodes.length, 0)} episodes)`);
  }

  console.log(`\nDone. ${FILMS.length} films and ${SERIES.length} series added.`);
  console.log('These are for judging the interface — the files are placeholders and will not play.');
  console.log(`Remove them with:  npm run demo -- --clear`);
}

if (process.argv.includes('--clear')) {
  clearDemo();
} else {
  await seed();
}
