import { el, clear, icon, formatBytes, toast } from '../ui.js';
import { ErrorState } from '../components/states.js';
import { api } from '../api.js';
import { state } from '../state.js';

const MOODS = [
  'slow burn', 'feel-good', 'mind-bending', 'heist', 'true story', 'dark comedy',
  'coming of age', 'epic scale', 'whodunnit', 'road trip', 'dystopian', 'ensemble cast',
  'single location', 'time loop', 'revenge', 'courtroom', 'space', 'period drama',
];

const AVOID = ['gore', 'jump scares', 'sad endings', 'animal harm', 'found footage', 'musicals', 'subtitles', 'romance'];

export async function SettingsView({ outlet }) {
  const tabs = [
    { id: 'taste', label: 'Taste profile' },
    { id: 'playback', label: 'Playback' },
    { id: 'library', label: 'Library' },
    { id: 'profiles', label: 'Profiles' },
    ...(state.user?.is_admin ? [{ id: 'server', label: 'Server' }] : []),
    { id: 'about', label: 'About' },
  ];

  let activeTab = 'taste';
  const body = el('div', {});

  const nav = el('nav', { class: 'settings__nav' },
    tabs.map((t) =>
      el('button', {
        type: 'button',
        class: t.id === activeTab ? 'is-active' : '',
        onClick: (e) => {
          activeTab = t.id;
          for (const b of nav.children) b.classList.remove('is-active');
          e.currentTarget.classList.add('is-active');
          renderTab();
        },
      }, t.label)));

  async function renderTab() {
    clear(body);
    body.append(el('div', { class: 'skeleton', style: { height: '200px' } }));
    let node;
    try {
      node =
        activeTab === 'taste' ? await TastePanel()
        : activeTab === 'playback' ? await PlaybackPanel()
        : activeTab === 'library' ? await LibraryPanel()
        : activeTab === 'profiles' ? await ProfilesPanel()
        : activeTab === 'server' ? await ServerPanel()
        : AboutPanel();
    } catch (err) {
      node = panelError(err, renderTab);
    }
    clear(body).append(node);
  }

  outlet.append(
    el('div', { class: 'page page--padded' },
      el('div', { class: 'toolbar' }, el('h1', { class: 'toolbar__title' }, 'Settings')),
      el('div', { class: 'settings' }, nav, body))
  );

  renderTab();
}

// --- taste ------------------------------------------------------------------

async function TastePanel() {
  const taste = await api.taste();
  const { genres } = await api.genres();

  const wrap = el('div', {});

  const aboutBox = el('textarea', {
    class: 'input',
    placeholder: 'e.g. I like slow-burn sci-fi and sharp dialogue. I avoid gore and anything over two and a half hours on a weeknight.',
  });
  aboutBox.value = taste.about || '';

  const chosen = {
    likedGenres: new Set(taste.likedGenres),
    dislikedGenres: new Set(taste.dislikedGenres),
    moods: new Set(taste.moods),
    avoid: new Set(taste.avoid),
    favouritePeople: [...taste.favouritePeople],
  };

  const pillGroup = (options, set) =>
    el('div', { class: 'pill-choice' },
      options.map((opt) =>
        el('button', {
          type: 'button',
          class: set.has(opt) ? 'is-on' : '',
          onClick: (e) => {
            if (set.has(opt)) set.delete(opt);
            else set.add(opt);
            e.currentTarget.classList.toggle('is-on');
          },
        }, opt)));

  // Favourite people are free text, so they get a tag input.
  const peopleTags = el('div', { class: 'taglist' });
  const renderPeople = () => {
    clear(peopleTags);
    for (const p of chosen.favouritePeople) {
      peopleTags.append(
        el('span', { class: 'tag' }, p,
          el('button', {
            type: 'button', 'aria-label': `Remove ${p}`,
            onClick: () => {
              chosen.favouritePeople = chosen.favouritePeople.filter((x) => x !== p);
              renderPeople();
            },
          }, '×'))
      );
    }
  };
  renderPeople();

  const personInput = el('input', {
    class: 'input',
    placeholder: 'Add an actor or director, then press Enter',
    onKeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = e.target.value.trim();
      if (value && !chosen.favouritePeople.includes(value)) {
        chosen.favouritePeople.push(value);
        renderPeople();
      }
      e.target.value = '';
    },
  });

  const saveBtn = el('button', {
    class: 'btn btn--corona', type: 'button',
    onClick: async () => {
      saveBtn.disabled = true;
      try {
        await api.saveTaste({
          about: aboutBox.value,
          likedGenres: [...chosen.likedGenres],
          dislikedGenres: [...chosen.dislikedGenres],
          moods: [...chosen.moods],
          avoid: [...chosen.avoid],
          favouritePeople: chosen.favouritePeople,
        });
        toast('Taste profile saved — N.O.V.A. will use it straight away');
      } catch (err) {
        toast(err.message);
      } finally {
        saveBtn.disabled = false;
      }
    },
  }, 'Save taste profile');

  const genreNames = genres.map((g) => g.name);

  wrap.append(
    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'In your own words'),
      el('p', { class: 'panel__hint' }, 'N.O.V.A. reads this before every recommendation. Be specific — "I like heist films but not action for its own sake" is far more useful than "I like action".'),
      aboutBox),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Genres you enjoy'),
      el('p', { class: 'panel__hint' }, 'Taken from what is actually on this server.'),
      pillGroup(genreNames, chosen.likedGenres)),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Genres to show less of'),
      el('p', { class: 'panel__hint' }, 'These are pushed down the ranking rather than hidden entirely.'),
      pillGroup(genreNames, chosen.dislikedGenres)),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'People you follow'),
      el('p', { class: 'panel__hint' }, 'Anything they appear in or directed gets a boost.'),
      peopleTags,
      personInput),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Moods and themes'),
      el('p', { class: 'panel__hint' }, 'What kind of thing pulls you in, regardless of genre.'),
      pillGroup(MOODS, chosen.moods)),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Steer clear of'),
      el('p', { class: 'panel__hint' }, 'N.O.V.A. will avoid recommending these and will say so if you ask for one anyway.'),
      pillGroup(AVOID, chosen.avoid)),

    saveBtn
  );

  return wrap;
}

// --- library ----------------------------------------------------------------

async function LibraryPanel() {
  if (!state.user?.is_admin) {
    return el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Library'),
      el('p', { class: 'panel__hint' }, 'Only an administrator can manage the library on this server.'));
  }

  const status = await api.adminStatus();
  const wrap = el('div', {});

  const scanInfo = el('p', { class: 'panel__hint' });
  const scanBtn = el('button', {
    class: 'btn btn--corona', type: 'button',
    onClick: async () => {
      scanBtn.disabled = true;
      await api.adminScan(false);
      toast('Scan started');
      pollScan();
    },
  }, 'Scan library now');

  const fullScanBtn = el('button', {
    class: 'btn btn--ghost', type: 'button', style: { marginLeft: '10px' },
    onClick: async () => {
      fullScanBtn.disabled = true;
      await api.adminScan(true);
      toast('Full rescan started — this re-reads every file');
      pollScan();
    },
  }, 'Full rescan');

  async function pollScan() {
    const s = await api.adminStatus();
    if (s.scan.scanning) {
      scanInfo.textContent = `Scanning — ${s.scan.processed} of ${s.scan.found} files. ${s.scan.current || ''}`;
      setTimeout(pollScan, 1200);
    } else {
      scanInfo.textContent = 'Idle.';
      scanBtn.disabled = false;
      fullScanBtn.disabled = false;
      toast('Scan finished');
    }
  }
  scanInfo.textContent = status.scan.scanning
    ? `Scanning — ${status.scan.processed} of ${status.scan.found} files.`
    : 'Idle.';
  if (status.scan.scanning) pollScan();

  wrap.append(
    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'What is on this server'),
      el('div', { class: 'statgrid' },
        stat(status.stats.movies, 'FILMS'),
        stat(status.stats.series, 'SERIES'),
        stat(status.stats.episodes, 'EPISODES'),
        stat(formatBytes(status.stats.totalBytes), 'ON DISK'),
        stat(status.stats.unmatched, 'UNMATCHED'))),

    LibrariesCard(status.libraries, scanBtn, fullScanBtn, scanInfo),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Integrations'),
      el('p', { class: 'panel__hint' },
        'Each of these is one line in the ', el('code', {}, '.env'),
        ' file in your ECLIPSE folder. Add the key, save the file, then restart the server.'),
      el('div', { class: 'factlist' },
        setupRow({
          name: 'Artwork and metadata',
          on: status.integrations.tmdb,
          envVar: 'TMDB_API_KEY',
          link: 'https://www.themoviedb.org/settings/api',
          linkLabel: 'Get a free TMDB key →',
          whenOn: 'Posters, backdrops, synopses, cast and episode titles are being fetched and cached locally.',
          whenOff:
            'Without this, your files still appear and play — but they get generated placeholder posters ' +
            'instead of real artwork, and no synopsis or cast. This is the one worth setting up first.',
        }),
        setupRow({
          name: 'N.O.V.A. conversation',
          on: status.integrations.nova,
          envVar: 'OPENAI_API_KEY',
          link: 'https://platform.openai.com/api-keys',
          linkLabel: 'Get an OpenAI key →',
          whenOn: 'Chatting with N.O.V.A. is on.',
          whenOff:
            'N.O.V.A. still ranks your library and explains every pick without this. A key lets you talk ' +
            'to her — ask for something short and funny, or something like a film you liked.',
        }),
        setupRow({
          name: 'Playing .mkv files',
          on: status.integrations.transcode,
          whenOn: 'ffmpeg conversion is on, so containers your browser cannot open will still play.',
          whenOff:
            'Install ffmpeg on this machine so .mkv and similar files can be converted as they play. ' +
            'MP4 files play either way.',
        }),
        setupRow({
          name: 'Watching folders',
          on: status.integrations.watching,
          whenOn: 'Files dropped into your library folders are added automatically, within seconds.',
          whenOff: 'Automatic pickup is off — use the scan button above after adding files.',
        })))
  );

  return wrap;
}

/**
 * One integration, written so somebody who has never opened a .env file can act
 * on it: what it does, what you lose without it, and exactly what to paste.
 */
function setupRow({ name, on, envVar, link, linkLabel, whenOn, whenOff }) {
  return el('div', { class: 'fact' },
    el('div', { class: 'fact__k' }, name.toUpperCase()),
    el('div', { class: 'fact__v' },
      el('span', { style: { color: on ? 'var(--good)' : 'var(--text-faint)', fontWeight: '600' } },
        on ? '● Active' : '○ Not set up'),
      el('div', { style: { fontSize: '12.5px', color: 'var(--text-faint)', marginTop: '5px', lineHeight: '1.55' } },
        on ? whenOn : whenOff),
      !on && envVar
        ? el('div', { style: { marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
            el('code', {
              style: {
                fontSize: '12px', background: 'var(--surface-3)', border: '1px solid var(--hairline)',
                padding: '6px 10px', borderRadius: '6px',
                fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--text)',
              },
            }, `${envVar}=paste-your-key-here`),
            link
              ? el('a', {
                  href: link, target: '_blank', rel: 'noopener',
                  style: { fontSize: '12.5px', color: '#b9aeff', textDecoration: 'underline' },
                }, linkLabel)
              : null)
        : null));
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__n' }, String(value)),
    el('div', { class: 'stat__l' }, label));
}

// --- profiles ---------------------------------------------------------------

async function ProfilesPanel() {
  const wrap = el('div', {});

  if (state.user?.is_admin) {
    const { users } = await api.adminUsers();
    const list = el('div', { class: 'factlist' },
      users.map((u) =>
        el('div', { class: 'fact', style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          el('div', {
            class: 'profilepick__face',
            style: { background: u.avatar_color, width: '40px', height: '40px', fontSize: '16px' },
          }, u.display_name[0]?.toUpperCase()),
          el('div', { style: { flex: 1 } },
            el('div', { class: 'fact__v' }, u.display_name),
            el('div', { style: { fontSize: '12px', color: 'var(--text-faint)' } },
              [u.is_admin ? 'Administrator' : 'Viewer', u.is_kids ? 'Kids' : null,
                u.max_rating ? `${u.max_rating} and under` : null,
                u.has_pin ? 'PIN set' : null].filter(Boolean).join(' · '))),
          el('select', {
            'aria-label': `Age limit for ${u.display_name}`,
            title: 'Only titles rated at or below this appear on this profile',
            onChange: async (e) => {
              await api.adminUpdateUser(u.id, { maxRating: e.target.value || null });
              toast(e.target.value ? `${u.display_name} is limited to ${e.target.value} and under` : 'Age limit removed');
            },
          }, [['', 'No age limit'], ['U', 'U'], ['PG', 'PG'], ['12', '12'], ['15', '15'], ['18', '18']].map(([v, label]) => {
            const option = el('option', { value: v }, label);
            if ((u.max_rating || '') === v) option.selected = true;
            return option;
          })),
          u.id === state.user.id
            ? el('span', { class: 'chip' }, 'You')
            : el('button', {
                class: 'btn btn--ghost btn--sm', type: 'button',
                onClick: async () => {
                  if (!confirm(`Delete the profile "${u.display_name}"? Their history and taste profile go with it.`)) return;
                  await api.adminDeleteUser(u.id);
                  toast('Profile deleted');
                  ProfilesPanel().then((n) => wrap.replaceWith(n));
                },
              }, 'Delete'))));

    const nu = { username: el('input', { class: 'input', placeholder: 'username' }),
                 name: el('input', { class: 'input', placeholder: 'Display name' }),
                 pass: el('input', { class: 'input', type: 'password', placeholder: 'Password' }),
                 kids: el('input', { type: 'checkbox' }) };

    wrap.append(
      el('div', { class: 'panel' },
        el('h2', { class: 'panel__title' }, 'Household profiles'),
        el('p', { class: 'panel__hint' }, 'Everyone gets their own watch history, watchlist and taste profile — so N.O.V.A. recommends to each of them, not to the household average.'),
        list),

      el('div', { class: 'panel' },
        el('h2', { class: 'panel__title' }, 'Add a profile'),
        el('div', { class: 'auth__field' }, el('label', {}, 'USERNAME'), nu.username),
        el('div', { class: 'auth__field' }, el('label', {}, 'DISPLAY NAME'), nu.name),
        el('div', { class: 'auth__field' }, el('label', {}, 'PASSWORD'), nu.pass),
        el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px', marginBottom: '18px' } },
          nu.kids, 'Kids profile'),
        el('button', {
          class: 'btn btn--corona', type: 'button',
          onClick: async () => {
            try {
              await api.createUser({
                username: nu.username.value,
                displayName: nu.name.value,
                password: nu.pass.value,
                isKids: nu.kids.checked,
              });
              toast('Profile created');
              ProfilesPanel().then((n) => wrap.replaceWith(n));
            } catch (err) {
              toast(err.message);
            }
          },
        }, 'Create profile'))
    );
  } else {
    wrap.append(el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Your profile'),
      el('p', { class: 'panel__hint' }, `Signed in as ${state.user.display_name}. Ask an administrator to add more profiles.`)));
  }

  wrap.append(PinPanel());
  return wrap;
}

/**
 * A PIN for this profile. Worth its own panel because it's the thing that
 * makes signing in on a TV bearable — four digits on a D-pad instead of a
 * password typed one letter at a time.
 */
function PinPanel() {
  const input = el('input', {
    class: 'input', type: 'password', inputmode: 'numeric', maxlength: '8',
    placeholder: '4 to 8 digits',
  });

  return el('div', { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'Sign-in PIN'),
    el('p', { class: 'panel__hint' },
      'Set a PIN and this profile can sign in with it instead of a password. Typing a real password with a TV remote is miserable enough that people choose bad ones to avoid it — a PIN on the TV and a password everywhere else is the better trade.'),
    input,
    el('div', { style: { marginTop: '14px', display: 'flex', gap: '10px' } },
      el('button', {
        class: 'btn btn--corona', type: 'button',
        onClick: async () => {
          try {
            await api.setPin(input.value);
            input.value = '';
            toast('PIN saved');
          } catch (err) {
            toast(err.message);
          }
        },
      }, 'Save PIN'),
      el('button', {
        class: 'btn btn--ghost', type: 'button',
        onClick: async () => {
          await api.setPin('');
          input.value = '';
          toast('PIN removed — this profile signs in with its password');
        },
      }, 'Remove PIN')));
}

function AboutPanel() {
  return el('div', { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'ECLIPSE'),
    el('p', { class: 'panel__hint' },
      'A private streaming service for your home network. Drop files into a watched folder and they appear here with artwork and synopses, ready to play in any browser on the network. N.O.V.A. learns what each person likes and picks accordingly.'),
    el('div', { class: 'factlist' },
      el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, 'VERSION'),
        el('div', { class: 'fact__v' }, '1.0.0')),
      el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, 'BUILD'),
        // Bumped by hand with every fix that touches web/ — the fastest way
        // to confirm a server is actually running what was just pushed,
        // rather than guessing from symptoms whether a git pull + restart
        // happened. Read this back rather than re-describing what's broken.
        el('div', { class: 'fact__v' }, '2026-09-09.3')),
      el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, 'KEYBOARD'),
        el('div', { class: 'fact__v' }, 'Space play/pause · ← → skip 10s · F fullscreen · M mute · C subtitles · / search · Esc close'))));
}

// --- playback ---------------------------------------------------------------

const SUBTITLE_COLOURS = [
  ['#ffffff', 'White'], ['#f5e663', 'Yellow'], ['#9ee7ff', 'Pale blue'], ['#bdbdbd', 'Grey'],
];

/**
 * How playback behaves for this viewer. Everything saves as you change it —
 * a settings page with a Save button people forget to press is a settings
 * page that quietly does nothing.
 */
async function PlaybackPanel() {
  const prefs = await api.preferences();

  const save = debounce(async (patch) => {
    Object.assign(prefs, patch);
    try {
      await api.savePreferences(patch);
    } catch (err) {
      toast(err.message || 'That setting could not be saved');
    }
  }, 250);

  // A live sample, so the size and colour controls show what they mean
  // rather than describing it.
  const sample = el('div', { class: 'subpreview' },
    el('div', { class: 'subpreview__cue' }, 'The quick brown fox jumps over the lazy dog'));

  const applyPreview = () => {
    sample.style.setProperty('--sub-size', String((prefs.subtitleSize || 100) / 100));
    sample.style.setProperty('--sub-colour', prefs.subtitleColour || '#ffffff');
    sample.style.setProperty('--sub-bg', `rgba(0, 0, 0, ${prefs.subtitleBackground ?? 0.55})`);
  };

  const panel = el('div', { class: 'panel-stack' },
    card('While watching',
      'What happens on its own, without you reaching for the remote.',
      el('div', { class: 'setting-list' },
        toggleRow('Play the next episode automatically', prefs.autoplayNext, (on) => save({ autoplayNext: on })),
        choiceRow('Intros and recaps', prefs.skipIntro, [
          ['ask', 'Offer a skip button'], ['auto', 'Skip them for me'], ['off', 'Leave them alone'],
        ], (v) => save({ skipIntro: v }),
          'Only offered when the file marks where the intro is — ECLIPSE never guesses at it.'),
        choiceRow('End credits', prefs.skipCredits, [
          ['ask', 'Offer a skip button'], ['auto', 'Skip them for me'], ['off', 'Leave them alone'],
        ], (v) => save({ skipCredits: v })))),

    card('Languages',
      'Used when a file actually has the track. Nothing here invents one.',
      el('div', { class: 'setting-list' },
        textRow('Preferred audio language', prefs.audioLanguage || '', 'e.g. English, or eng',
          (v) => save({ audioLanguage: v || null })),
        textRow('Preferred subtitle language', prefs.subtitleLanguage || '', 'e.g. Japanese, or jpn',
          (v) => save({ subtitleLanguage: v || null })),
        toggleRow('Turn subtitles on by default', prefs.subtitlesDefault, (on) => save({ subtitlesDefault: on })),
        el('p', { class: 'setting-note' },
          'With subtitles off, a track marked "forced" still appears — that’s the one translating signs and other languages.'))),

    card('How subtitles look', null,
      el('div', { class: 'setting-list' },
        sample,
        sliderRow('Size', prefs.subtitleSize, 50, 250, 5, (v) => { prefs.subtitleSize = v; applyPreview(); save({ subtitleSize: v }); }, (v) => `${v}%`),
        sliderRow('Background', Math.round((prefs.subtitleBackground ?? 0.55) * 100), 0, 100, 5,
          (v) => { prefs.subtitleBackground = v / 100; applyPreview(); save({ subtitleBackground: v / 100 }); }, (v) => `${v}%`),
        sliderRow('Height on screen', prefs.subtitlePosition, 50, 98, 1,
          (v) => save({ subtitlePosition: v }), (v) => `${v}%`),
        el('div', { class: 'setting-row' },
          el('div', { class: 'setting-row__label' }, 'Colour'),
          el('div', { class: 'pill-choice' },
            SUBTITLE_COLOURS.map(([hex, name]) =>
              el('button', {
                type: 'button',
                class: prefs.subtitleColour === hex ? 'is-on' : '',
                onClick: (e) => {
                  for (const b of e.currentTarget.parentElement.children) b.classList.remove('is-on');
                  e.currentTarget.classList.add('is-on');
                  prefs.subtitleColour = hex;
                  applyPreview();
                  save({ subtitleColour: hex });
                },
              }, el('span', { class: 'swatch', style: { background: hex } }), name)))))),

    card('Quality',
      'Caps every stream sent to this profile. Useful over a slow connection, or on a TV that struggles with 4K.',
      el('div', { class: 'setting-list' },
        choiceRow('Maximum resolution', String(prefs.maxHeight || 0), [
          ['0', 'Whatever the file is'], ['2160', '4K'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'],
        ], (v) => save({ maxHeight: Number(v) })),
        choiceRow('Maximum bitrate', String(prefs.maxBitrate || 0), [
          ['0', 'Unlimited'], ['20000000', '20 Mbps'], ['8000000', '8 Mbps'], ['4000000', '4 Mbps'], ['2000000', '2 Mbps'],
        ], (v) => save({ maxBitrate: Number(v) })),
        el('p', { class: 'setting-note' },
          'A cap means the server re-encodes rather than sending the file as-is, which costs it some work.'))));

  applyPreview();
  return panel;
}

// --- server -----------------------------------------------------------------

/**
 * What the machine is doing, and what it's doing it for. Refreshes itself
 * while the tab is open, because "is it still scanning" is a question you ask
 * by looking, not by pressing reload.
 */
/**
 * Copies of the database, which is the one part of an install that cannot be
 * rebuilt from what is on disk: profiles, PINs, what everyone has watched,
 * their lists and ratings, and the library setup.
 *
 * The download matters as much as the backup does — one that only exists on
 * the machine that fails has not saved anything.
 */
function BackupsCard(rows, refresh) {
  const makeBtn = el('button', {
    class: 'btn btn--corona btn--sm', type: 'button',
    onClick: async () => {
      makeBtn.disabled = true;
      try {
        await api.adminCreateBackup();
        toast('Database backed up');
        await refresh();
      } catch (err) {
        toast(err.message);
      } finally {
        makeBtn.disabled = false;
      }
    },
  }, 'Back up now');

  return el('div', { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'Backups'),
    el('p', { class: 'panel__hint' },
      'A copy of the database — every profile, everything watched, all lists and ratings, and the library setup. ',
      'Taken automatically each day, keeping the last seven. Media and artwork are not included: those can be scanned again, this cannot. ',
      'Download one and keep it somewhere other than this machine.'),
    rows.length
      ? el('div', { class: 'backup-list' },
          rows.map((b) =>
            el('div', { class: 'backup-row' },
              el('div', {},
                el('div', { class: 'backup-row__name' }, b.name.replace(/^eclipse-|\.db$/g, '').replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')),
                el('div', { class: 'backup-row__meta' }, formatBytes(b.size))),
              el('a', { class: 'btn btn--ghost btn--sm', href: api.adminBackupUrl(b.name), download: b.name }, 'Download'))))
      : el('p', { class: 'panel__hint' }, 'No backups yet. The first one is taken a minute after the server starts.'),
    makeBtn);
}

async function ServerPanel() {
  const panel = el('div', { class: 'panel-stack' });
  const health = el('div', {});
  const sessions = el('div', {});
  const logs = el('div', {});
  const backups = el('div', {});
  panel.append(health, sessions, backups, logs);

  let timer = null;
  let stopped = false;

  async function refresh() {
    let status;
    try {
      status = await api.adminStatus();
    } catch (err) {
      clear(health).append(panelError(err, refresh));
      return;
    }
    if (stopped) return;

    clear(health).append(HealthCard(status));
    clear(sessions).append(SessionsCard(status, refresh));
  }

  async function refreshLogs() {
    try {
      const { logs: rows } = await api.adminLogs();
      if (!stopped) clear(logs).append(LogsCard(rows));
    } catch { /* the panel above already reports a dead server */ }
  }

  async function refreshBackups() {
    try {
      const { backups: rows } = await api.adminBackups();
      if (!stopped) clear(backups).append(BackupsCard(rows, refreshBackups));
    } catch { /* the panel above already reports a dead server */ }
  }

  await refresh();
  await refreshBackups();
  await refreshLogs();

  // Poll while the tab is on screen, and stop the moment it isn't — a
  // settings page left open shouldn't keep waking a Fire TV's CPU.
  timer = setInterval(() => {
    if (!panel.isConnected) { clearInterval(timer); stopped = true; return; }
    refresh();
  }, 5000);

  return panel;
}

function HealthCard(status) {
  const h = status.health;
  const i = status.integrations;

  return card('This server', `${h.hostname} · ${h.platform} · Node ${h.node} · up ${formatUptime(h.uptime)}`,
    el('div', {},
      el('div', { class: 'meter-grid' },
        meter('Processor', h.cpu.percent, h.cpu.percent == null ? h.cpu.loadAverage[0].toFixed(2) + ' load' : `${h.cpu.percent}%`,
          `${h.cpu.cores} cores · ${h.cpu.model}`),
        meter('Memory', h.memory.percent, `${formatBytes(h.memory.used)} of ${formatBytes(h.memory.total)}`,
          `ECLIPSE itself is using ${formatBytes(h.memory.process)}`),
        ...h.storage.filter((v) => !v.error).map((v) =>
          meter(v.label, v.percent, `${formatBytes(v.free)} free`, v.path))),

      el('div', { class: 'stat-row' },
        stat(status.stats.movies, 'Films'),
        stat(status.stats.series, 'Series'),
        stat(status.stats.episodes, 'Episodes'),
        stat(formatBytes(status.stats.totalBytes), 'On disk'),
        stat(`${i.transcodesRunning}/${i.maxTranscodes}`, 'Converting')),

      el('div', { class: 'chip-row' },
        featureChip('Artwork & metadata', i.tmdb, 'TMDB key set', 'No TMDB key'),
        featureChip('N.O.V.A. conversation', i.nova, 'Connected', 'No OpenAI key'),
        featureChip('Converting', i.transcode, i.hardware, 'Disabled'),
        featureChip('Watching folders', i.watching, 'On', 'Off'))));
}

function SessionsCard(status, refresh) {
  const rows = status.sessions;
  return card('Playing now', rows.length ? null : 'Nothing is playing.',
    el('div', {},
      rows.length
        ? el('div', { class: 'session-list' }, rows.map((s) => SessionRow(s, refresh)))
        : null,
      el('h4', { class: 'subhead' }, 'Devices'),
      status.devices.length
        ? el('div', { class: 'device-list' }, status.devices.map((d) =>
            el('div', { class: 'device' },
              el('div', {},
                el('div', { class: 'device__name' }, d.name),
                el('div', { class: 'device__meta' },
                  [d.user, `last seen ${formatWhen(d.lastSeen)}`].filter(Boolean).join(' · '))),
              el('button', {
                class: 'btn btn--ghost btn--sm', type: 'button',
                onClick: async () => {
                  const name = prompt('What should this device be called?', d.name);
                  if (!name) return;
                  await api.adminRenameDevice(d.id, name);
                  refresh();
                },
              }, 'Rename'))))
        : el('p', { class: 'setting-note' }, 'No devices have connected yet.')));
}

function SessionRow(s, refresh) {
  const methodLabel = { direct: 'Direct play', remux: 'Repackaging', transcode: 'Converting' }[s.method] || s.method;
  return el('div', { class: 'session' },
    el('div', { class: 'session__main' },
      el('div', { class: 'session__title' },
        s.title, s.episode ? ` · S${s.episode.season} E${s.episode.number}` : ''),
      el('div', { class: 'session__meta' },
        [`${s.user} on ${s.device}`, methodLabel, s.hardware, s.source && s.target && s.source !== s.target ? `${s.source} → ${s.target}` : null]
          .filter(Boolean).join(' · ')),
      s.reasons?.length ? el('div', { class: 'session__why' }, s.reasons.join('. ')) : null,
      el('div', { class: 'session__bar' }, el('span', { style: { width: `${Math.round(s.progress * 100)}%` } }))),
    el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      onClick: async () => { await api.adminStopSession(s.id); refresh(); },
    }, 'Stop'));
}

function LogsCard(rows) {
  return card('Recent activity', 'The last few things the server did, newest first.',
    rows.length
      ? el('div', { class: 'log-list' }, rows.slice(0, 60).map((r) =>
          el('div', { class: `log log--${r.level}` },
            el('span', { class: 'log__time' }, formatWhen(r.at)),
            el('span', { class: 'log__scope' }, r.scope),
            el('span', { class: 'log__msg' }, r.message + (r.detail ? ` — ${r.detail}` : '')))))
      : el('p', { class: 'setting-note' }, 'Nothing logged yet.'));
}

// --- shared bits ------------------------------------------------------------

function card(title, subtitle, body) {
  return el('section', { class: 'card-panel' },
    el('h3', { class: 'card-panel__title' }, title),
    subtitle ? el('p', { class: 'card-panel__sub' }, subtitle) : null,
    body);
}

function meter(label, percent, value, note) {
  const pct = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : null;
  return el('div', { class: 'meter' },
    el('div', { class: 'meter__head' },
      el('span', { class: 'meter__label' }, label),
      el('span', { class: 'meter__value' }, value)),
    el('div', { class: 'meter__track' },
      el('span', {
        class: `meter__fill${pct != null && pct > 90 ? ' is-high' : ''}`,
        style: { width: `${pct ?? 0}%` },
      })),
    note ? el('div', { class: 'meter__note' }, note) : null);
}

function featureChip(label, on, onText, offText) {
  return el('div', { class: `feature-chip${on ? ' is-on' : ''}` },
    el('span', { class: 'feature-chip__dot' }),
    el('span', {}, label),
    el('span', { class: 'feature-chip__state' }, on ? onText : offText));
}

function toggleRow(label, value, onChange, note) {
  const input = el('input', { type: 'checkbox', onChange: (e) => onChange(e.target.checked) });
  input.checked = Boolean(value);
  return el('label', { class: 'setting-row setting-row--toggle' },
    el('div', {},
      el('div', { class: 'setting-row__label' }, label),
      note ? el('div', { class: 'setting-row__note' }, note) : null),
    el('span', { class: 'switch' }, input, el('span', { class: 'switch__track' })));
}

function choiceRow(label, value, options, onChange, note) {
  const select = el('select', { onChange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => {
      const option = el('option', { value: v }, text);
      if (String(v) === String(value)) option.selected = true;
      return option;
    }));
  return el('div', { class: 'setting-row' },
    el('div', {},
      el('div', { class: 'setting-row__label' }, label),
      note ? el('div', { class: 'setting-row__note' }, note) : null),
    select);
}

function textRow(label, value, placeholder, onChange) {
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__label' }, label),
    el('input', {
      type: 'text', value, placeholder, class: 'setting-input',
      onChange: (e) => onChange(e.target.value.trim()),
    }));
}

function sliderRow(label, value, min, max, step, onChange, format) {
  const readout = el('span', { class: 'setting-row__value' }, format(value));
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__label' }, label),
    el('div', { class: 'slider' },
      el('input', {
        type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
        onInput: (e) => {
          const v = Number(e.target.value);
          readout.textContent = format(v);
          onChange(v);
        },
      }),
      readout));
}

/**
 * Whatever went wrong, said plainly, with the one button that might help.
 * The shared component in its compact form — a settings panel is one card on
 * a page, not the whole screen.
 */
function panelError(err, retry) {
  return ErrorState(err, { retry, compact: true });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatWhen(value) {
  if (!value) return '';
  // SQLite writes UTC without a marker; without the Z this reads hours out.
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString();
}

/**
 * The libraries this server scans. The two that come from the environment are
 * shown as such and can't be edited here — changing them means changing the
 * .env file, and pretending otherwise would produce an edit that silently
 * reverts on the next restart.
 */
function LibrariesCard(libraries, scanBtn, fullScanBtn, scanInfo) {
  const list = el('div', { class: 'library-list' });

  const render = (rows) => {
    clear(list);
    if (!rows.length) {
      list.append(el('p', { class: 'setting-note' },
        'No libraries yet. Add one below, or set ECLIPSE_MOVIES_DIR and ECLIPSE_SERIES_DIR in your .env file.'));
      return;
    }
    for (const library of rows) list.append(LibraryRow(library, reload));
  };

  const reload = async () => {
    try {
      const { libraries: rows } = await api.adminLibraries();
      render(rows);
    } catch (err) {
      clear(list).append(panelError(err, reload));
    }
  };

  render(libraries);

  const nameInput = el('input', { type: 'text', class: 'setting-input', placeholder: 'Anime' });
  const pathInput = el('input', { type: 'text', class: 'setting-input', placeholder: '/mnt/media/Anime' });
  const kindSelect = el('select', {},
    el('option', { value: 'movies' }, 'Films'),
    el('option', { value: 'series' }, 'Series'));

  const addBtn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onClick: async () => {
      try {
        await api.adminAddLibrary({
          name: nameInput.value.trim(),
          kind: kindSelect.value,
          paths: [pathInput.value.trim()],
        });
        nameInput.value = '';
        pathInput.value = '';
        toast('Library added — run a scan to pick it up');
        reload();
      } catch (err) {
        toast(err.message);
      }
    },
  }, 'Add library');

  return el('div', { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'Libraries'),
    el('p', { class: 'panel__hint' },
      'Each library is a name, a type, and the folders to look in. Files dropped into them are picked up automatically; a scan catches anything the watcher missed.'),
    list,
    el('div', { class: 'library-add' },
      el('div', { class: 'library-add__fields' }, nameInput, kindSelect, pathInput),
      addBtn),
    el('div', { style: { marginTop: '20px' } }, scanBtn, fullScanBtn),
    scanInfo);
}

function LibraryRow(library, reload) {
  const fromConfig = library.source === 'config';
  return el('div', { class: `library-row${library.enabled ? '' : ' is-off'}` },
    el('div', { class: 'library-row__main' },
      el('div', { class: 'library-row__head' },
        el('span', { class: 'library-row__name' }, library.name),
        el('span', { class: 'library-row__kind' }, library.kind === 'movies' ? 'Films' : 'Series'),
        fromConfig ? el('span', { class: 'library-row__badge' }, 'from .env') : null,
        library.enabled ? null : el('span', { class: 'library-row__badge' }, 'disabled')),
      el('div', { class: 'library-row__paths' },
        library.paths.length
          ? library.paths.map((p) =>
              el('div', {
                class: `library-row__path${library.missingPaths.includes(p) ? ' is-missing' : ''}`,
              }, p, library.missingPaths.includes(p) ? ' — folder not found' : ''))
          : el('div', { class: 'library-row__path is-missing' }, 'No folders set')),
      el('div', { class: 'library-row__meta' },
        [`${library.titles ?? 0} titles`, `${library.files ?? 0} files`,
          library.bytes ? formatBytes(library.bytes) : null,
          library.scannedAt ? `scanned ${formatWhen(library.scannedAt)}` : 'never scanned',
        ].filter(Boolean).join(' · '))),
    fromConfig
      ? null
      : el('div', { class: 'library-row__actions' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: async () => {
              await api.adminUpdateLibrary(library.id, { enabled: !library.enabled });
              reload();
            },
          }, library.enabled ? 'Disable' : 'Enable'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: async () => {
              // Deleting drops the scanned titles, which is worth a sentence
              // rather than a bare "are you sure".
              if (!confirm(`Remove "${library.name}"? The ${library.titles ?? 0} titles it scanned are removed from ECLIPSE. Your files are not touched.`)) return;
              try {
                await api.adminDeleteLibrary(library.id);
                toast('Library removed');
                reload();
              } catch (err) {
                toast(err.message);
              }
            },
          }, 'Remove')));
}
