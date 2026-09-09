import { el, icon, clear, formatRuntime, formatTime, formatBytes, initials, toast } from '../ui.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { Row } from '../components/row.js';
import { openPlayer } from '../components/player.js';
import { openNova } from '../components/nova.js';
import { navigate } from '../router.js';
import { ErrorState } from '../components/states.js';
import { focusFirstIn } from '../tvnav.js';

const TV_MODE = document.documentElement.classList.contains('tv-mode');

export async function TitleView({ params, outlet }) {
  let title;
  try {
    title = await api.title(Number(params.id));
  } catch (err) {
    // A 403 here is a parental limit and a 404 is a title that has left the
    // library — both are ordinary answers, not crashes, and both want a way
    // back rather than a stack trace.
    outlet.replaceChildren(el('div', { class: 'page page--padded' },
      ErrorState(err, {
        retry: err.status === 403 ? null : () => { outlet.replaceChildren(); TitleView({ params, outlet }); },
        home: true,
      })));
    return;
  }

  const meta = [];
  if (title.year) meta.push(el('span', {}, String(title.year)));
  if (title.certification) meta.push(el('span', { class: 'chip chip--cert' }, title.certification));
  if (title.rating) meta.push(el('span', { class: 'chip chip--rating' }, `★ ${title.rating.toFixed(1)}`));
  if (title.kind === 'movie' && title.runtime) meta.push(el('span', {}, formatRuntime(title.runtime)));
  if (title.kind === 'series') meta.push(el('span', {}, `${title.seasons?.length || 0} season${title.seasons?.length === 1 ? '' : 's'}`));
  const best = title.files?.[0] || title.seasons?.[0]?.episodes?.[0];
  if (title.files?.[0]?.quality) meta.push(el('span', { class: `chip${title.files[0].quality === '4K' ? ' chip--4k' : ''}` }, title.files[0].quality));

  const resume = title.resume;

  const watchlistBtn = el('button', {
    class: 'btn btn--ghost btn--icon', type: 'button',
    'aria-label': title.inWatchlist ? 'Remove from your list' : 'Add to your list',
    onClick: async () => {
      const r = await api.toggleWatchlist(title.id);
      title.inWatchlist = r.inWatchlist;
      clear(watchlistBtn).append(icon(r.inWatchlist ? 'check' : 'plus'));
      toast(r.inWatchlist ? 'Added to your list' : 'Removed from your list');
    },
  }, icon(title.inWatchlist ? 'check' : 'plus'));

  const favouriteBtn = el('button', {
    class: `btn btn--ghost btn--icon${title.isFavourite ? ' is-on' : ''}`, type: 'button',
    'aria-label': title.isFavourite ? 'Remove from favourites' : 'Add to favourites',
    title: 'Favourite',
    onClick: async () => {
      const r = await api.toggleFavourite(title.id);
      title.isFavourite = r.favourite;
      clear(favouriteBtn).append(icon(r.favourite ? 'heartFilled' : 'heart'));
      favouriteBtn.classList.toggle('is-on', r.favourite);
      toast(r.favourite ? 'Added to your favourites' : 'Removed from your favourites');
    },
  }, icon(title.isFavourite ? 'heartFilled' : 'heart'));

  // A film has one file and one watched state, so it gets the same control
  // as an episode, in the row of actions rather than beside a list.
  const watchedBtn = title.kind === 'movie' && title.primaryFile
    ? el('button', {
        class: `btn btn--ghost btn--icon${title.primaryFile.completed ? ' is-on' : ''}`,
        type: 'button', title: 'Watched',
        'aria-label': title.primaryFile.completed ? 'Mark as unwatched' : 'Mark as watched',
        onClick: async (e) => {
          const next = !title.primaryFile.completed;
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api.setWatched(title.primaryFile.id, next);
            title.primaryFile.completed = next;
            btn.classList.toggle('is-on', next);
            btn.setAttribute('aria-label', next ? 'Mark as unwatched' : 'Mark as watched');
            toast(next ? 'Marked as watched' : 'Marked as unwatched');
          } catch (err) {
            toast(err.message);
          } finally {
            btn.disabled = false;
          }
        },
      }, icon('check'))
    : null;

  const rateBtn = (score, iconName, label) =>
    el('button', {
      class: `btn btn--ghost btn--icon${title.userRating === score ? ' is-on' : ''}`,
      type: 'button', 'aria-label': label,
      style: title.userRating === score ? { background: 'var(--corona)', borderColor: 'transparent' } : {},
      onClick: async (e) => {
        const next = title.userRating === score ? 0 : score;
        await api.rate(title.id, next);
        title.userRating = next;
        for (const b of e.currentTarget.parentElement.querySelectorAll('.btn--icon')) {
          b.style.background = '';
          b.style.borderColor = '';
        }
        if (next) {
          e.currentTarget.style.background = 'var(--corona)';
          e.currentTarget.style.borderColor = 'transparent';
        }
        toast(next === 1 ? 'N.O.V.A. will find more like this' : next === -1 ? 'N.O.V.A. will show you fewer like this' : 'Rating cleared');
      },
    }, icon(iconName));

  const hero = el(
    'section',
    { class: 'hero detail__hero' },
    el('div', { class: 'hero__media' }, el('img', { src: title.backdrop || title.poster || '', alt: '' })),
    el('div', { class: 'hero__scrim' }),
    el('button', {
      class: 'iconbtn detail__back', type: 'button', 'aria-label': 'Back',
      onClick: () => (history.length > 1 ? history.back() : navigate('/')),
    }, icon('chevronLeft')),
    el(
      'div',
      { class: 'hero__body' },
      title.logo
        ? el('img', { class: 'hero__logo', src: title.logo, alt: title.title })
        : el('h1', { class: 'hero__title' }, title.title),
      title.tagline ? el('p', { style: { margin: '0 0 14px', color: 'var(--text-dim)', fontStyle: 'italic' } }, title.tagline) : null,
      el('div', { class: 'hero__meta' }, meta),
      el(
        'div',
        { class: 'hero__actions' },
        resume
          ? el('button', {
              class: 'btn btn--play', type: 'button',
              onClick: () => openPlayer(resume.fileId, resume.position || 0),
            },
            icon('play'),
            resume.season
              ? `${resume.label} S${resume.season} E${resume.episode}`
              : resume.label)
          : el('button', { class: 'btn btn--play', type: 'button', disabled: true }, icon('play'), 'No playable file'),
        watchlistBtn,
        favouriteBtn,
        watchedBtn,
        rateBtn(1, 'thumbUp', 'I liked this'),
        rateBtn(-1, 'thumbDown', 'Not for me'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openNova(`Find me something like ${title.title}`),
        }, el('span', { class: 'nova-orb' }), 'More like this'),
        state.user?.is_admin
          ? el('button', {
              class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': 'Edit metadata', title: 'Edit metadata',
              onClick: () => EditMetadataModal(title),
            }, icon('edit'))
          : null
      )
    )
  );

  const left = el('div', {});
  if (title.overview) {
    left.append(
      el('div', { class: 'detail__section' },
        el('p', { class: 'detail__label' }, 'SYNOPSIS'),
        el('p', { class: 'detail__overview' }, title.overview))
    );
  }

  if (title.kind === 'series' && title.seasons?.length) {
    left.append(EpisodeBrowser(title));
  }

  if (title.cast?.length) {
    const people = title.castPhotos?.length
      ? title.castPhotos.slice(0, 12)
      : title.cast.slice(0, 12).map((name) => ({ name, photo: null }));
    left.append(
      el('div', { class: 'detail__section' },
        el('p', { class: 'detail__label' }, 'CAST'),
        el('div', { class: 'people' },
          people.map(({ name, photo }) =>
            el('a', { class: 'person', href: `#/person/${encodeURIComponent(name)}`, 'aria-label': `Everything with ${name}` },
              el('div', { class: 'person__face' },
                photo ? el('img', { src: photo, alt: '', loading: 'lazy' }) : initials(name)),
              el('p', { class: 'person__name' }, name)))))
    );
  }

  const facts = [];
  if (title.directors?.length) facts.push(['DIRECTOR', title.directors.join(', ')]);
  if (title.creators?.length) facts.push(['CREATED BY', title.creators.join(', ')]);
  if (title.writers?.length) facts.push(['WRITTEN BY', title.writers.join(', ')]);
  if (title.genres?.length) facts.push(['GENRES', title.genres.join(', ')]);
  if (title.studios?.length) facts.push(['STUDIO', title.studios.slice(0, 2).join(', ')]);
  if (title.countries?.length) facts.push(['COUNTRY', title.countries.join(', ')]);
  if (title.collection) facts.push(['PART OF', title.collection]);
  if (title.status) facts.push(['STATUS', title.status]);

  const right = el('aside', {},
    el('div', { class: 'factlist' },
      facts.map(([k, v]) => el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, k),
        el('div', { class: 'fact__v' }, v)))),
    VersionsBlock(title),
    TechnicalBlock(title));

  const page = el('div', { class: 'page' },
    hero,
    el('div', { class: 'detail__grid' }, left, right));

  if (title.similar?.length) {
    page.append(el('div', { style: { marginTop: '30px' } },
      Row({ id: 'similar', title: 'More like this', items: title.similar })));
  }

  outlet.append(page);
}

function EpisodeBrowser(title) {
  const seasons = title.seasons.filter((s) => s.episodes.length);
  if (!seasons.length) return el('div');

  // Default to the season the viewer is partway through.
  const resumeSeason = title.resume?.season;
  let activeIndex = Math.max(0, seasons.findIndex((s) => s.number === resumeSeason));

  const list = el('div', {});
  const bar = el('div', { class: 'seasonbar' },
    seasons.map((s, i) =>
      el('button', {
        type: 'button',
        class: i === activeIndex ? 'is-active' : '',
        onClick: (e) => {
          activeIndex = i;
          for (const b of bar.children) b.classList.remove('is-active');
          e.currentTarget.classList.add('is-active');
          renderSeason();
        },
      }, s.name || `Season ${s.number}`)));

  function renderSeason() {
    clear(list);
    for (const ep of seasons[activeIndex].episodes) {
      const progress = ep.position && ep.runtime ? ep.position / (ep.runtime * 60) : 0;
      const flag = ep.completed
        ? el('span', { class: 'episode__flag' }, '✓ Watched')
        : el('span', { class: 'episode__flag', hidden: true }, '✓ Watched');

      const row = el('button', {
        class: 'episode', type: 'button',
        disabled: !ep.fileId,
        onClick: () => ep.fileId && openPlayer(ep.fileId, ep.completed ? 0 : ep.position || 0),
      },
        el('div', { class: 'episode__num' }, String(ep.number)),
        el('div', { class: 'episode__still' },
          ep.still ? el('img', { src: ep.still, alt: '', loading: 'lazy' }) : null,
          progress > 0.02 && !ep.completed
            ? el('div', { class: 'card__progress', style: { position: 'absolute', bottom: 0, left: 0, right: 0 } },
                el('span', { style: { width: `${Math.min(100, progress * 100)}%` } }))
            : null),
        el('div', {},
          el('p', { class: 'episode__name' }, ep.name || `Episode ${ep.number}`, flag),
          el('p', { class: 'episode__desc' }, ep.overview || 'No synopsis available.')),
        el('div', { class: 'episode__time' }, ep.runtime ? formatRuntime(ep.runtime) : ''));

      list.append(ep.fileId
        ? el('div', { class: 'episode-line' }, row, WatchedToggle(ep, flag))
        : row);
    }
  }

  renderSeason();

  return el('div', { class: 'detail__section' },
    el('p', { class: 'detail__label' }, 'EPISODES'),
    bar,
    list);
}

/**
 * Mark something watched, or unwatched, by hand.
 *
 * The server has recorded this since the beginning and nothing could ever set
 * it: an episode watched somewhere else, or one ECLIPSE recorded wrongly
 * because a stream dropped, stayed that way for good. It is also how anyone
 * starts a series again from the top, which is otherwise impossible.
 *
 * A sibling of the episode row rather than a child, because the row is itself
 * a button and buttons do not nest.
 */
function WatchedToggle(ep, flag) {
  const btn = el('button', {
    class: `episode__watch${ep.completed ? ' is-on' : ''}`,
    type: 'button',
    title: ep.completed ? 'Mark as unwatched' : 'Mark as watched',
    'aria-label': `Mark episode ${ep.number} as ${ep.completed ? 'unwatched' : 'watched'}`,
    onClick: async (e) => {
      e.stopPropagation();
      const next = !ep.completed;
      btn.disabled = true;
      try {
        await api.setWatched(ep.fileId, next);
        ep.completed = next;
        btn.classList.toggle('is-on', next);
        btn.title = next ? 'Mark as unwatched' : 'Mark as watched';
        flag.hidden = !next;
        toast(next ? `Episode ${ep.number} marked watched` : `Episode ${ep.number} marked unwatched`);
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    },
  }, icon('check'));
  return btn;
}

/**
 * Admin-only: edit a title's metadata by hand, or point it at a different
 * TMDB match. Either path marks the title 'manual', so the next scan won't
 * quietly overwrite what was just typed in.
 */
function EditMetadataModal(title) {
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    modal.remove();
    document.body.classList.remove('is-locked');
    document.removeEventListener('keydown', onKey);
  };

  const field = (labelText, input) =>
    el('div', { class: 'modal__field' }, el('label', {}, labelText), input);

  const titleInput = el('input', { class: 'input', value: title.title });
  const yearInput = el('input', { class: 'input', type: 'number', value: title.year || '' });
  const taglineInput = el('input', { class: 'input', value: title.tagline || '' });
  const certInput = el('input', { class: 'input', value: title.certification || '', placeholder: 'e.g. 15, PG-13' });
  const genresInput = el('input', { class: 'input', value: (title.genres || []).join(', '), placeholder: 'Comma separated' });
  // A <textarea>'s initial text has to be a child node, not a "value"
  // attribute — the attribute is inert on this element.
  const overviewInput = el('textarea', { class: 'input' }, title.overview || '');
  const posterInput = el('input', { class: 'input', value: title.poster || '', placeholder: 'https://…' });
  const backdropInput = el('input', { class: 'input', value: title.backdrop || '', placeholder: 'https://…' });

  const applyMatch = async (tmdbId, btn) => {
    if (btn) btn.disabled = true;
    try {
      await api.adminMatchTitle(title.id, tmdbId);
      toast('Matched from TMDB');
      close();
      navigate(`/title/${title.id}`);
    } catch (err) {
      toast(err.message || 'Could not fetch that match');
      if (btn) btn.disabled = false;
    }
  };

  const searchInput = el('input', { class: 'input', value: title.title, placeholder: 'Search TMDB…' });
  const resultsBox = el('div', { class: 'modal__results' });

  const showResultsMessage = (text) =>
    clear(resultsBox).append(el('p', { class: 'modal__hint', style: { margin: 0 } }, text));

  async function runSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    showResultsMessage('Searching…');
    try {
      const { items } = await api.adminTmdbSearch(title.kind, q);
      if (!items.length) { showResultsMessage('No matches on TMDB for that search.'); return; }
      clear(resultsBox);
      for (const item of items) {
        resultsBox.append(
          el('button', {
            class: 'modal__result', type: 'button',
            onClick: (e) => applyMatch(item.tmdbId, e.currentTarget),
          },
            item.poster
              ? el('img', { src: item.poster, alt: '', loading: 'lazy' })
              : el('div', { class: 'modal__result-noart' }),
            el('div', {},
              el('p', { class: 'modal__result-title' }, item.title + (item.year ? ` (${item.year})` : '')),
              el('p', { class: 'modal__result-overview' }, item.overview || 'No synopsis available.')))
        );
      }
    } catch (err) {
      showResultsMessage(err.message || 'Search failed.');
    }
  }

  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
  const searchBtn = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: runSearch }, 'Search');

  const saveBtn = el('button', {
    class: 'btn btn--corona', type: 'button',
    onClick: async () => {
      saveBtn.disabled = true;
      try {
        await api.adminEditTitle(title.id, {
          title: titleInput.value,
          year: yearInput.value,
          tagline: taglineInput.value,
          certification: certInput.value,
          overview: overviewInput.value,
          poster: posterInput.value,
          backdrop: backdropInput.value,
          genres: genresInput.value.split(',').map((g) => g.trim()).filter(Boolean),
        });
        toast('Saved');
        close();
        navigate(`/title/${title.id}`);
      } catch (err) {
        toast(err.message || 'Could not save those changes');
      } finally {
        saveBtn.disabled = false;
      }
    },
  }, 'Save changes');

  // --- merging pieces of a split title back together ---
  // A season folder the scanner didn't recognise as one becomes its own
  // title, and a rescan won't undo that: a file deliberately stays attached
  // to the title it already has, so an edited title can't drift. Merging is
  // the only way back, which is why it lives here rather than nowhere.
  const mergeBox = el('div', { class: 'modal__results' });
  const chosen = new Set();

  const mergeBtn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', hidden: true,
    onClick: async () => {
      if (!chosen.size) return;
      mergeBtn.disabled = true;
      try {
        const r = await api.adminMergeTitles(title.id, [...chosen]);
        toast(`Merged ${r.merged} into this title — ${r.episodes} episode${r.episodes === 1 ? '' : 's'}, ${r.files} file${r.files === 1 ? '' : 's'}`);
        close();
        navigate(`/title/${title.id}`);
      } catch (err) {
        toast(err.message || 'Could not merge those');
        mergeBtn.disabled = false;
      }
    },
  }, 'Merge selected into this title');

  api.adminMergeCandidates(title.id)
    .then(({ candidates }) => {
      if (!candidates.length) {
        mergeBox.append(el('p', { class: 'modal__hint', style: { margin: 0 } },
          'Nothing on this server looks like another piece of this title.'));
        return;
      }
      // Spread, not an array: append() on a real DOM node stringifies an
      // array argument into "[object HTMLButtonElement]" rather than adding
      // its members. el() flattens its children; append() does not.
      clear(mergeBox).append(...candidates.map((c) =>
        el('button', {
          class: 'merge-option', type: 'button',
          onClick: (e) => {
            const on = chosen.has(c.id);
            if (on) chosen.delete(c.id); else chosen.add(c.id);
            e.currentTarget.classList.toggle('is-on', !on);
            mergeBtn.hidden = chosen.size === 0;
          },
        },
          el('span', {}, c.title, c.year ? ` (${c.year})` : ''),
          el('span', { class: 'merge-option__meta' },
            c.episodes ? `${c.episodes} episode${c.episodes === 1 ? '' : 's'}` : `${c.files} file${c.files === 1 ? '' : 's'}`))));
    })
    .catch(() => {
      mergeBox.append(el('p', { class: 'modal__hint', style: { margin: 0 } }, 'Could not look for related titles.'));
    });

  const modal = el(
    'div',
    { class: 'modal', onClick: (e) => { if (e.target === modal) close(); } },
    el(
      'div',
      { class: 'modal__card' },
      el('h2', { class: 'modal__title' }, 'Edit metadata'),
      el('p', { class: 'modal__hint' },
        `Search TMDB and pick the right match, or edit the fields below by hand. Either way, this title stops updating itself on future scans.`),

      el('div', { class: 'modal__search' }, searchInput, searchBtn),
      resultsBox,

      el('hr', { class: 'modal__divider' }),
      el('p', { class: 'modal__hint' }, 'Or edit the fields directly:'),

      field('Title', titleInput),
      el('div', { class: 'modal__row' },
        field('Year', yearInput),
        field('Certification', certInput)),
      field('Tagline', taglineInput),
      field('Genres', genresInput),
      field('Synopsis', overviewInput),
      field('Poster URL', posterInput),
      field('Backdrop URL', backdropInput),

      el('hr', { class: 'modal__divider' }),
      el('p', { class: 'modal__hint' },
        'If one series was scanned as several — a season folder the scanner read as a show of its own — pick the other pieces and fold them in. ',
        'Their episodes, files and everything anyone has watched move across; the empty titles go. Rename the result above afterwards.'),
      mergeBox,
      mergeBtn,

      el('div', { class: 'modal__actions' },
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, 'Cancel'),
        saveBtn)
    )
  );

  document.addEventListener('keydown', onKey);
  document.body.classList.add('is-locked');
  // The Fire TV back-button bridge in app.js can only reach this modal
  // generically (it has no import of this module) — exposing the real
  // close() on the node itself lets it run proper cleanup instead of
  // falling back to a bare .remove() that would leak the keydown listener
  // above for the rest of the session.
  modal.eclipseClose = close;
  document.body.append(modal);
  // Focusing anything only works once the node is actually connected to
  // the document — appending has to happen first, or this silently no-ops
  // on a detached tree and the cursor is left sitting on whatever opened
  // the modal instead.
  if (TV_MODE) focusFirstIn(modal);
  runSearch();

  return modal;
}

/**
 * Which copies of this film exist. Only shown when there's genuinely a
 * choice — one file is not a "version", it's just the film.
 */
function VersionsBlock(title) {
  const files = title.files || [];
  if (files.length < 2) return null;

  // Play uses one of these, and which one is not obvious from a list of
  // equals — so the one it would pick says so.
  const primaryId = title.primaryFile?.id;

  return el('div', { class: 'versions' },
    el('div', { class: 'fact__k' }, 'VERSIONS'),
    el('div', { class: 'versions__list' },
      files.map((f) =>
        el('button', {
          class: `version${f.id === primaryId ? ' is-current' : ''}`, type: 'button',
          onClick: () => openPlayer(f.id, f.completed ? 0 : f.position || 0),
        },
          el('span', { class: 'version__label' }, f.versionLabel || f.filename),
          el('span', { class: 'version__meta' },
            [
              f.id === primaryId ? 'Plays by default' : null,
              f.size ? formatBytes(f.size) : null,
              f.hdrFormat,
              f.directPlay ? null : 'needs converting',
            ].filter(Boolean).join(' · '))))));
}

/**
 * The technical panel: everything ECLIPSE read out of the file. Folded away
 * by default — it's for the person who wants to know why something is being
 * converted, not part of deciding what to watch.
 */
function TechnicalBlock(title) {
  const file = title.files?.[0] || title.seasons?.[0]?.episodes?.[0];
  if (!file || !file.id) return null;

  const body = el('div', { class: 'technical__body', hidden: true });
  let loaded = false;

  const toggle = el('button', {
    class: 'technical__toggle', type: 'button',
    onClick: async () => {
      body.hidden = !body.hidden;
      toggle.classList.toggle('is-open', !body.hidden);
      if (loaded || body.hidden) return;
      loaded = true;
      body.append(el('div', { class: 'skeleton', style: { height: '90px' } }));
      try {
        const ctx = await api.playbackContext(file.id);
        clear(body).append(TechnicalTable(ctx));
      } catch (err) {
        clear(body).append(el('p', { class: 'technical__row' }, err.message || 'Could not read this file.'));
      }
    },
  }, 'Technical details');

  return el('div', { class: 'technical' }, toggle, body);
}

function TechnicalTable(ctx) {
  const t = ctx.technical;
  if (!t) return el('p', { class: 'technical__row' }, 'Nothing has been read from this file yet.');

  const rows = [];
  const push = (k, v) => { if (v) rows.push([k, v]); };

  push('Container', t.container);
  push('Size', t.size ? formatBytes(t.size) : null);
  push('Bitrate', t.bitrate ? `${Math.round(t.bitrate / 1000)} kbps` : null);
  if (t.video) {
    push('Video', [t.video.codec?.toUpperCase(), t.video.profile].filter(Boolean).join(' · '));
    push('Resolution', [t.video.resolution, t.video.quality].filter(Boolean).join(' · '));
    push('Frame rate', t.video.frameRate ? `${t.video.frameRate} fps` : null);
    push('Bit depth', t.video.bitDepth ? `${t.video.bitDepth}-bit` : null);
    push('HDR', t.video.hdrFormat);
    push('Colour', [t.video.colorSpace, t.video.colorTransfer].filter(Boolean).join(' · '));
    push('Aspect', t.video.aspectRatio);
  }

  const table = el('div', { class: 'technical__table' },
    rows.map(([k, v]) => el('div', { class: 'technical__row' },
      el('span', { class: 'technical__k' }, k),
      el('span', { class: 'technical__v' }, v))));

  const streams = el('div', {});
  if (t.audio?.length) {
    streams.append(
      el('div', { class: 'technical__k technical__group' }, `Audio (${t.audio.length})`),
      ...t.audio.map((a) => el('div', { class: 'technical__stream' },
        [a.languageName || a.label, a.codec?.toUpperCase(), a.channelLabel,
          a.bitrate ? `${Math.round(a.bitrate / 1000)} kbps` : null,
          a.isCommentary ? 'commentary' : null, a.isDefault ? 'default' : null,
        ].filter(Boolean).join(' · '))));
  }
  if (t.subtitles?.length) {
    streams.append(
      el('div', { class: 'technical__k technical__group' }, `Subtitles (${t.subtitles.length})`),
      ...t.subtitles.map((s) => el('div', { class: 'technical__stream' },
        [s.languageName || s.label, s.format, s.isForced ? 'forced' : null,
          s.isHearingImpaired ? 'SDH' : null, s.isDefault ? 'default' : null,
        ].filter(Boolean).join(' · '))));
  }
  if (ctx.chapters?.length) {
    streams.append(el('div', { class: 'technical__k technical__group' }, `Chapters (${ctx.chapters.length})`));
  }

  // The file's own path, last — useful when a title is wrong and you need to
  // go and look at what it actually matched.
  const path = t.path
    ? el('div', { class: 'technical__path' }, t.path)
    : null;

  return el('div', {}, table, streams, path);
}
