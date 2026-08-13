import { el, clear, icon, formatBytes, toast } from '../ui.js';
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
    { id: 'library', label: 'Library' },
    { id: 'profiles', label: 'Profiles' },
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
    const node =
      activeTab === 'taste' ? await TastePanel()
      : activeTab === 'library' ? await LibraryPanel()
      : activeTab === 'profiles' ? await ProfilesPanel()
      : AboutPanel();
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
        toast('Taste profile saved — NOVA will use it straight away');
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
      el('p', { class: 'panel__hint' }, 'NOVA reads this before every recommendation. Be specific — "I like heist films but not action for its own sake" is far more useful than "I like action".'),
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
      el('p', { class: 'panel__hint' }, 'NOVA will avoid recommending these and will say so if you ask for one anyway.'),
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

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Watched folders'),
      el('p', { class: 'panel__hint' }, 'Set with ECLIPSE_MOVIES_DIR and ECLIPSE_SERIES_DIR in your .env file. New files appear automatically; a scan catches anything the watcher missed.'),
      status.libraries.length
        ? el('div', { class: 'factlist' },
            status.libraries.map((l) =>
              el('div', { class: 'fact' },
                el('div', { class: 'fact__k' }, l.kind.toUpperCase()),
                el('div', { class: 'fact__v', style: { color: l.exists ? '' : 'var(--bad)' } },
                  l.path, l.exists ? '' : ' — folder not found'))))
        : el('p', { style: { color: 'var(--bad)', fontSize: '14px' } }, 'No library folders are configured yet.'),
      el('div', { style: { marginTop: '20px' } }, scanBtn, fullScanBtn),
      scanInfo),

    el('div', { class: 'panel' },
      el('h2', { class: 'panel__title' }, 'Integrations'),
      el('div', { class: 'factlist' },
        integrationRow('Metadata (TMDB)', status.integrations.tmdb, 'Set TMDB_API_KEY to fetch posters, synopses and cast.'),
        integrationRow('NOVA conversation', status.integrations.nova, 'Set ANTHROPIC_API_KEY to chat with NOVA. Recommendations work without it.'),
        integrationRow('On-the-fly conversion', status.integrations.transcode, 'Install ffmpeg so the browser can play .mkv and other containers.'),
        integrationRow('Folder watching', status.integrations.watching, 'New files are picked up automatically.')))
  );

  return wrap;
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__n' }, String(value)),
    el('div', { class: 'stat__l' }, label));
}

function integrationRow(name, on, hint) {
  return el('div', { class: 'fact' },
    el('div', { class: 'fact__k' }, name.toUpperCase()),
    el('div', { class: 'fact__v' },
      el('span', { style: { color: on ? 'var(--good)' : 'var(--text-faint)' } }, on ? '● Active' : '○ Not configured'),
      el('div', { style: { fontSize: '12.5px', color: 'var(--text-faint)', marginTop: '3px' } }, hint)));
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
              [u.is_admin ? 'Administrator' : 'Viewer', u.is_kids ? 'Kids' : null].filter(Boolean).join(' · '))),
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
        el('p', { class: 'panel__hint' }, 'Everyone gets their own watch history, watchlist and taste profile — so NOVA recommends to each of them, not to the household average.'),
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

  return wrap;
}

function AboutPanel() {
  return el('div', { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'ECLIPSE'),
    el('p', { class: 'panel__hint' },
      'A private streaming service for your home network. Drop files into a watched folder and they appear here with artwork and synopses, ready to play in any browser on the network. NOVA learns what each person likes and picks accordingly.'),
    el('div', { class: 'factlist' },
      el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, 'VERSION'),
        el('div', { class: 'fact__v' }, '1.0.0')),
      el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, 'KEYBOARD'),
        el('div', { class: 'fact__v' }, 'Space play/pause · ← → skip 10s · F fullscreen · M mute · C subtitles · / search · Esc close'))));
}
