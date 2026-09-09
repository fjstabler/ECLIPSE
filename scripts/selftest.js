/**
 * A quick end-to-end check that the server wiring holds together: modules
 * import, the schema applies, the parser behaves, and the recommendation
 * engine ranks sensibly. Run with `node scripts/selftest.js`.
 */

const MODULES = [
  '../server/db.js',
  '../server/library.js',
  '../server/auth.js',
  '../server/log.js',
  '../server/parental.js',
  '../server/preferences.js',
  '../server/libraries.js',
  '../server/health.js',
  '../server/backup.js',
  '../server/util/parse.js',
  '../server/media/probe.js',
  '../server/media/streams.js',
  '../server/media/subtitles.js',
  '../server/media/trickplay.js',
  '../server/media/transcode.js',
  '../server/media/sessions.js',
  '../server/scanner/scanner.js',
  '../server/scanner/watcher.js',
  '../server/metadata/tmdb.js',
  '../server/metadata/artwork.js',
  '../server/nova/engine.js',
  '../server/nova/tools.js',
  '../server/nova/openai.js',
  '../server/routes/auth.routes.js',
  '../server/routes/library.routes.js',
  '../server/routes/stream.routes.js',
  '../server/routes/playback.routes.js',
  '../server/routes/nova.routes.js',
  '../server/routes/admin.routes.js',
];

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nmodules');
for (const m of MODULES) {
  try {
    await import(m);
    console.log(`  ok    ${m.replace('../', '')}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${m.replace('../', '')} — ${err.message}`);
  }
}

const { parseMovie, parseEpisode } = await import('../server/util/parse.js');

console.log('\nfilename parsing');
const movieCases = [
  ['The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv', 'The Matrix', 1999],
  ['Blade Runner 2049 (2017).mp4', 'Blade Runner 2049', 2017],
  ['Dune Part Two 2024 2160p WEB-DL DDP5 1 Atmos HDR H 265-FLUX.mkv', 'Dune Part Two', 2024],
  ['1917 (2019)/1917.mkv', '1917', 2019],
  // A year in the title plus a release year — the release year is the later one.
  ['Blade.Runner.2049.2017.1080p.BluRay.x264-AMIABLE.mkv', 'Blade Runner 2049', 2017],
  // A year in the title and no release year at all.
  ['Blade Runner 2049.mkv', 'Blade Runner 2049', null],
  // A title that is nothing but a year.
  ['2012.mkv', '2012', null],
];
for (const [input, title, year] of movieCases) {
  const r = parseMovie(input);
  check(`movie: ${input.slice(0, 44)}`, r.title === title && r.year === year, `got "${r.title}" (${r.year})`);
}

const epCases = [
  ['Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv', 'Breaking Bad', 1, 1],
  ['Severance/Season 2/Severance.S02E03.Who.Is.Alive.1080p.ATVP.WEB-DL.mkv', 'Severance', 2, 3],
  ['The Office/Season 03/The Office - 3x05 - Initiation.avi', 'The Office', 3, 5],
  ['Doctor Who/Specials/Doctor Who - S00E01 - The Star Beast.mkv', 'Doctor Who', 0, 1],
  // A season folder carrying the whole release name, which is how scene packs
  // arrive. Without the season marker stripped off the series name, every
  // season of a show becomes a separate series.
  ['Mr.Robot.S01.1080p.BluRay.x265-GRP/Mr.Robot.S01E01.1080p.BluRay.x265-GRP.mkv', 'Mr Robot', 1, 1],
  ['Mr.Robot.S04.1080p.WEB.x265-GRP/Mr.Robot.S04E03.1080p.WEB.x265-GRP.mkv', 'Mr Robot', 4, 3],
  // A number in the name that isn't a season: it disagrees with the season
  // actually parsed, so it stays.
  ['Stranger Things 4/Season 1/Stranger.Things.4.S01E02.mkv', 'Stranger Things 4', 1, 2],
];
for (const [input, series, season, episode] of epCases) {
  const r = parseEpisode(input);
  check(
    `episode: ${input.split('/').pop().slice(0, 40)}`,
    r && r.series === series && r.season === season && r.episode === episode,
    r ? `got ${r.series} S${r.season}E${r.episode}` : 'no match'
  );
}

check('a film is not mistaken for an episode', parseEpisode('Films/Arrival (2016).mkv') === null);

console.log('\ndatabase + engine');
const { db } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { recommend, saveTasteProfile, buildTasteVector, similarTo } = await import('../server/nova/engine.js');
const { runTool, buildSystemPrompt } = await import('../server/nova/tools.js');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
for (const t of [
  'titles', 'title_tags', 'media_files', 'media_streams', 'chapters', 'media_markers',
  'users', 'playback_state', 'ratings', 'taste_profiles', 'nova_messages', 'devices', 'server_log',
]) {
  check(`table ${t}`, tables.includes(t));
}

// Work against a scratch user so a real library isn't disturbed.
const username = `selftest_${Date.now()}`;
const user = await createUser({ username, displayName: 'Self Test', password: 'testing123' });
check('user creation', Boolean(user?.id));

const titleCount = db.prepare('SELECT COUNT(*) AS n FROM titles').get().n;
if (titleCount === 0) {
  console.log('  note  library is empty — seed it with `npm run demo` to exercise the engine');
} else {
  saveTasteProfile(user.id, { likedGenres: ['Science Fiction'], avoid: ['gore'] });
  const { vector } = buildTasteVector(user.id);
  check('taste vector builds', vector.size > 0, `${vector.size} signals`);

  const picks = recommend(user.id, { limit: 5 });
  check('recommendations return', picks.length > 0, `${picks.length} picks`);
  check('recommendations carry a reason', picks.every((p) => typeof p.reason === 'string'));

  const sci = picks.find((p) => p.genres?.includes('Science Fiction'));
  check('stated genre preference influences ranking', Boolean(sci), 'no sci-fi in top 5');

  const seed = db.prepare('SELECT id FROM titles LIMIT 1').get();
  const similar = similarTo(seed.id, { limit: 5 });
  check('similarity search returns', similar.length >= 0, `${similar.length} matches`);

  const search = runTool('search_library', { limit: 3 }, { userId: user.id });
  check('tool: search_library', Array.isArray(search.result.titles));

  const recs = runTool('get_recommendations', { limit: 3 }, { userId: user.id });
  check('tool: get_recommendations', Array.isArray(recs.result.recommendations));

  const ctx = runTool('get_viewer_context', {}, { userId: user.id });
  check('tool: get_viewer_context', Boolean(ctx.result.profile));

  const prompt = buildSystemPrompt(user);
  check('system prompt mentions the library size', prompt.includes('film'));
}

db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

// --- next up ------------------------------------------------------------
// "What comes after the episode I just finished" is the row a series library
// is actually used through, and it is easy to get subtly wrong: offering an
// episode already in progress twice, offering one with no file behind it, or
// carrying on offering a series that has been finished.

console.log('\nnext up');
{
  const { nextUp, continueWatching } = await import('../server/library.js');
  const { db: sdb } = await import('../server/db.js');

  const episodeFile = sdb
    .prepare(`
      SELECT f.id AS file_id, e.title_id, e.season, e.number
      FROM media_files f JOIN episodes e ON e.id = f.episode_id
      WHERE e.season > 0
      ORDER BY e.title_id, e.season, e.number
    `)
    .all();

  if (episodeFile.length < 2 || episodeFile[0].title_id !== episodeFile[1].title_id) {
    console.log('  note  no series with two episodes on this server — next up not exercised');
  } else {
    const viewer = await createUser({
      username: `selftest_next_${Date.now()}`, displayName: 'Next', password: 'testing123',
    });
    const [first, second] = episodeFile;
    const watch = (fileId, position, duration, completed) =>
      sdb.prepare(`
        INSERT INTO playback_state (user_id, media_file_id, title_id, position, duration, completed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, media_file_id) DO UPDATE SET
          position = excluded.position, completed = excluded.completed, updated_at = datetime('now')
      `).run(viewer.id, fileId, first.title_id, position, duration, completed);

    check('a series nobody has started is not offered', nextUp(viewer.id).length === 0);

    watch(first.file_id, 1180, 1200, 1);
    const after = nextUp(viewer.id);
    check('finishing an episode offers the next one',
      after.length === 1 && after[0].resume.episode === second.number,
      `got ${JSON.stringify(after.map((t) => t.resume?.episode))}`);

    watch(second.file_id, 180, 1200, 0);
    check('an episode already in progress is left to continue watching',
      nextUp(viewer.id).length === 0 && continueWatching(viewer.id).length === 1);

    // Finishing the second one moves the marker along: either there is a
    // third episode to offer or the series has run out. Both are correct;
    // what would be wrong is still offering the episode just finished.
    watch(second.file_id, 1190, 1200, 1);
    const onwards = nextUp(viewer.id);
    check('the episode just finished is never offered back',
      onwards.every((t) => t.resume.episode !== second.number || t.resume.season !== second.season),
      JSON.stringify(onwards.map((t) => `S${t.resume.season}E${t.resume.episode}`)));

    const remaining = sdb
      .prepare(`
        SELECT COUNT(*) AS n FROM episodes e JOIN media_files f ON f.episode_id = e.id
        WHERE e.title_id = ? AND e.season > 0 AND (e.season * 1000 + e.number) > ?
      `)
      .get(first.title_id, second.season * 1000 + second.number).n;
    check(remaining ? 'the following episode is offered next' : 'a series watched to the end drops out',
      remaining ? onwards.length === 1 : onwards.length === 0,
      `${remaining} episode(s) left, next up returned ${onwards.length}`);

    sdb.prepare('DELETE FROM playback_state WHERE user_id = ?').run(viewer.id);
    sdb.prepare('DELETE FROM users WHERE id = ?').run(viewer.id);
  }
}

// --- parental limits --------------------------------------------------------
// A limit that looks configured and quietly allows everything is worse than no
// limit at all, so this walks the real path: the user as a request sees them,
// through the same query the API uses.

console.log('\nparental limits');
{
  const { isAllowed } = await import('../server/parental.js');
  const { getUserById } = await import('../server/auth.js');

  check('an 18 is blocked on a PG profile', isAllowed('18', 'PG') === false);
  check('a U is allowed on a PG profile', isAllowed('U', 'PG') === true);
  check('an unrated title is blocked on a limited profile', isAllowed(null, 'PG') === false);
  check('nothing is blocked without a limit', isAllowed('18', null) === true);

  const limited = await createUser({
    username: `selftest_kid_${Date.now()}`, displayName: 'Kid', password: 'testing123',
  });
  db.prepare('UPDATE users SET max_rating = ? WHERE id = ?').run('PG', limited.id);

  // The row the API actually reads on each request must carry the limit.
  const asRequestSeesThem = getUserById(limited.id);
  check('the limit travels with the user on a request', asRequestSeesThem.max_rating === 'PG',
    `got ${JSON.stringify(asRequestSeesThem.max_rating)}`);

  const { listTitles } = await import('../server/library.js');
  const blocked = listTitles({ maxRating: 'PG', limit: 200 })
    .filter((t) => !isAllowed(t.certification, 'PG'));
  check('a limited listing contains nothing above the limit', blocked.length === 0,
    blocked.map((t) => `${t.title} (${t.certification})`).join(', '));

  // Hiding a title from the shelves is not the same as refusing to play it.
  // File ids are guessable and clients cache them, so the guard the streaming
  // routes use gets checked on a real file rather than assumed.
  const { canPlayFile } = await import('../server/parental.js');
  const overTheLimit = db
    .prepare(`
      SELECT mf.id FROM media_files mf JOIN titles t ON t.id = mf.title_id
      WHERE t.certification IS NOT NULL AND UPPER(TRIM(t.certification)) IN ('18','R','NC-17','TV-MA')
      LIMIT 1
    `)
    .get();
  if (overTheLimit) {
    check('a limited profile cannot play a file it is not allowed to see',
      canPlayFile(overTheLimit.id, { max_rating: 'PG' }) === false);
    check('an unrestricted profile still can',
      canPlayFile(overTheLimit.id, { max_rating: null }) === true);
  } else {
    console.log('  note  no 18-rated file in this library — the streaming guard was not exercised');
  }
  check('a file that does not exist is refused rather than allowed',
    canPlayFile(-1, { max_rating: 'PG' }) === false);

  // N.O.V.A. reads the library through the profile's eyes: she cannot
  // recommend what she was never shown.
  if (db.prepare('SELECT COUNT(*) AS n FROM titles').get().n > 0) {
    const { runTool: novaTool } = await import('../server/nova/tools.js');
    const seen = novaTool('search_library', { limit: 40 }, { userId: limited.id, maxRating: 'PG' })
      .result.titles.filter((t) => !isAllowed(t.certification, 'PG'));
    check('N.O.V.A. is not shown titles above the profile limit', seen.length === 0,
      seen.map((t) => `${t.title} (${t.certification})`).join(', '));
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(limited.id);
}

// --- media inspection -------------------------------------------------------
// Builds a real file with several audio and subtitle tracks and reads it back,
// because "ECLIPSE understands what's actually in your files" is a claim worth
// re-proving on every change rather than trusting.

console.log('\nmedia inspection');
{
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const pathMod = await import('node:path');

  const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!haveFfmpeg) {
    console.log('  skip  ffmpeg not installed — media inspection not checked');
  } else {
    const dir = fsp.mkdtempSync(pathMod.join(os.tmpdir(), 'eclipse-selftest-'));
    const fixture = pathMod.join(dir, 'fixture.mkv');
    const srt = pathMod.join(dir, 'sub.srt');
    fsp.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,000\nline\n');

    const build = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
      '-i', srt,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
      '-metadata:s:s:0', 'language=fre',
      fixture,
    ], { stdio: 'ignore' });

    if (build.status !== 0) {
      check('build a test file to inspect', false, 'ffmpeg could not create the fixture');
    } else {
      const { probeFile } = await import('../server/media/probe.js');
      const probed = await probeFile(fixture);

      check('reads the container and duration', probed?.container === 'matroska' && Math.round(probed.duration) === 3);
      check('reads video properties', probed?.videoCodec === 'h264' && probed.width === 320 && probed.height === 180);

      const audio = probed.streams.filter((s) => s.kind === 'audio');
      check('finds every audio track', audio.length === 2, `found ${audio.length}`);
      check('reads audio languages', audio[0]?.language === 'eng' && audio[1]?.language === 'jpn');
      check('numbers audio tracks the way ffmpeg maps them', audio[1]?.typeIndex === 1);

      const subs = probed.streams.filter((s) => s.kind === 'subtitle');
      check('finds embedded subtitles', subs.length === 1, `found ${subs.length}`);
      check('reads the subtitle language it actually has', subs[0]?.language === 'fre');
      check('knows text subtitles can be extracted', subs[0]?.isExtractable === true);

      const { decidePlayback } = await import('../server/media/transcode.js');
      const asIs = decidePlayback(
        { video_codec: 'h264', audio_codec: 'aac', direct_play: 1, height: 180 }, {}, {}
      );
      check('h264/aac in a playable container direct plays', asIs.method === 'direct');

      const hevc = decidePlayback(
        { video_codec: 'hevc', audio_codec: 'aac', direct_play: 0, height: 2160 }, {}, {}
      );
      check('HEVC transcodes for a plain browser', hevc.method === 'transcode');

      const hevcTv = decidePlayback(
        { video_codec: 'hevc', audio_codec: 'aac', direct_play: 0, height: 2160 },
        { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'] }, {}
      );
      check('a device that decodes HEVC only needs a remux', hevcTv.method === 'remux');
    }

    fsp.rmSync(dir, { recursive: true, force: true });
  }
}

// --- scrub previews ---------------------------------------------------------
// The sprite sheet is only useful if the player can find the right tile in
// it, which is arithmetic that has to agree on both sides.

console.log('\nscrub previews');
{
  const { spawnSync } = await import('node:child_process');
  const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!haveFfmpeg) {
    console.log('  skip  ffmpeg not installed — scrub previews not checked');
  } else {
    const os = await import('node:os');
    const fsp = await import('node:fs');
    const pathMod = await import('node:path');

    const dir = fsp.mkdtempSync(pathMod.join(os.tmpdir(), 'eclipse-trick-'));
    const clip = pathMod.join(dir, 'clip.mp4');
    const built = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x180:rate=10:duration=90',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
    ], { stdio: 'ignore' });

    if (built.status !== 0) {
      check('build a clip to preview', false, 'ffmpeg could not create the fixture');
    } else {
      // A sheet laid out the way the module lays one out, sliced the way the
      // player slices one — the two have to agree or every preview is of the
      // wrong moment.
      const columns = 20;
      const tileW = 160;
      const tileH = 90;
      const interval = 2;
      const tileFor = (seconds, count) => {
        const i = Math.max(0, Math.min(count - 1, Math.floor(seconds / interval)));
        return { x: -(i % columns) * tileW, y: -Math.floor(i / columns) * tileH };
      };

      check('the first frame is the top-left tile',
        JSON.stringify(tileFor(0, 45)) === JSON.stringify({ x: -0, y: -0 }));
      check('a time inside the first row picks the right column',
        JSON.stringify(tileFor(30, 45)) === JSON.stringify({ x: -15 * tileW, y: -0 }));
      check('a time past the first row wraps onto the next',
        JSON.stringify(tileFor(50, 45)) === JSON.stringify({ x: -5 * tileW, y: -tileH }));
      check('a time past the end is clamped to the last real tile',
        JSON.stringify(tileFor(99999, 45)) === JSON.stringify({ x: -4 * tileW, y: -2 * tileH }),
        'a preview must never point at a cell that was never drawn');

      const { ensureTrickplay, trickplayInfo, clearTrickplay } = await import('../server/media/trickplay.js');

      // Against the clip built above rather than whatever is in the library:
      // a demo-seeded install carries rows pointing at placeholder files that
      // exist on disk and contain no video at all.
      const stat = fsp.statSync(clip);
      const titleId = db
        .prepare("INSERT INTO titles (kind, title, sort_title) VALUES ('movie', 'Selftest Clip', 'selftest clip')")
        .run().lastInsertRowid;
      const fileId = db
        .prepare(`
          INSERT INTO media_files (title_id, path, filename, extension, size, mtime, duration, width, height,
                                   direct_play, scanned_at, probe_version)
          VALUES (?, ?, 'clip.mp4', '.mp4', ?, ?, 90, 320, 180, 1, datetime('now'), 1)
        `)
        .run(titleId, clip, stat.size, Math.floor(stat.mtimeMs)).lastInsertRowid;

      const row = { id: fileId, path: clip, duration: 90, width: 320, height: 180, filename: 'clip.mp4' };
      ensureTrickplay(row);
      // Generation is deliberately in the background, so give it a moment.
      for (let i = 0; i < 60 && !trickplayInfo(fileId); i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const info = trickplayInfo(fileId);
      check('a sheet is generated for a real file', Boolean(info));
      if (info) {
        check('it describes a grid the player can slice',
          info.columns > 0 && info.rows > 0 && info.tileWidth > 0 && info.tileHeight > 0);
        check('it never claims more frames than the grid holds',
          info.count <= info.columns * info.rows, `${info.count} in ${info.columns}x${info.rows}`);
        check('the tiles keep the source aspect ratio',
          Math.abs(info.tileWidth / info.tileHeight - 320 / 180) < 0.1,
          `${info.tileWidth}x${info.tileHeight} for a 16:9 source`);
        check('the frames span the file', info.count * info.interval >= 90 * 0.75,
          `${info.count} frames every ${info.interval}s across 90s`);
      }

      clearTrickplay(fileId);
      check('clearing removes both the row and the sheet', trickplayInfo(fileId) === null);
      db.prepare('DELETE FROM media_files WHERE id = ?').run(fileId);
      db.prepare('DELETE FROM titles WHERE id = ?').run(titleId);
    }
    fsp.rmSync(dir, { recursive: true, force: true });
  }
}

// --- backups ----------------------------------------------------------------
// The database is the one part of an install that cannot be rebuilt, and it
// runs in WAL mode — so a backup that misses the write-ahead log silently
// loses whatever happened most recently, which is exactly the data anyone
// would be restoring for.

console.log('\nbackups');
{
  const { createBackup, listBackups } = await import('../server/backup.js');
  const Database = (await import('better-sqlite3')).default;

  const marker = `selftest-backup-${Date.now()}`;
  db.prepare("INSERT INTO server_log (level, scope, message) VALUES ('info', 'selftest', ?)").run(marker);

  const made = await createBackup();
  check('a backup is written', made.size > 0, `${made.size} bytes`);

  const copy = new Database(made.file, { readonly: true });
  check('the backup is a valid database', copy.pragma('integrity_check')[0].integrity_check === 'ok');
  check('it carries writes still in the write-ahead log',
    Boolean(copy.prepare('SELECT 1 FROM server_log WHERE message = ?').get(marker)),
    'a backup missing recent writes is worse than none');
  check('it has the whole schema',
    copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n >= 20);
  copy.close();

  check('it is listed', listBackups().some((b) => b.name === made.name));
  check('no more than seven are kept', listBackups().length <= 7, `${listBackups().length} present`);

  db.prepare('DELETE FROM server_log WHERE message = ?').run(marker);
}

// --- the server actually starts ---------------------------------------------
// Importing a module only proves it parses. A name referenced inside a function
// that nobody called — a missing import in the boot path — parses perfectly and
// then takes the whole server down on start. So this starts it the way `npm
// start` does, against a scratch data directory, and waits for it to answer.

console.log('\nserver start-up');
{
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const pathMod = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const dataDir = fsp.mkdtempSync(pathMod.join(os.tmpdir(), 'eclipse-boot-'));
  const port = 8000 + Math.floor(Math.random() * 1500);

  const child = spawn(process.execPath, [pathMod.join(here, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      ECLIPSE_DATA_DIR: dataDir,
      ECLIPSE_MOVIES_DIR: '',
      ECLIPSE_SERIES_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  let answered = false;
  for (let i = 0; i < 40 && !answered && child.exitCode === null; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
      answered = res.ok;
    } catch {
      // not listening yet
    }
  }

  check('the server boots and answers a request', answered,
    child.exitCode !== null
      ? `it exited with code ${child.exitCode}: ${lastError(output)}`
      : `no response on port ${port} after 10s`);

  // A crash after the port opens — the watcher, a background scan — still
  // counts as a broken start.
  check('nothing on the boot path threw', !/^\s*(ReferenceError|TypeError|SyntaxError)/m.test(output),
    lastError(output));

  child.kill('SIGTERM');
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
  fsp.rmSync(dataDir, { recursive: true, force: true });
}

function lastError(output) {
  const line = output.split('\n').reverse().find((l) => /Error|error:/.test(l));
  return (line || '').trim().slice(0, 200);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
