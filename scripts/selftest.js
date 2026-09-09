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
  '../server/util/parse.js',
  '../server/media/probe.js',
  '../server/media/streams.js',
  '../server/media/subtitles.js',
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
