import { el, icon, clear, formatRuntime, formatTime, initials, toast } from '../ui.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { Row } from '../components/row.js';
import { openPlayer } from '../components/player.js';
import { openNova } from '../components/nova.js';
import { navigate } from '../router.js';

export async function TitleView({ params, outlet }) {
  const title = await api.title(Number(params.id));

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
        rateBtn(1, 'thumbUp', 'I liked this'),
        rateBtn(-1, 'thumbDown', 'Not for me'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openNova(`Find me something like ${title.title}`),
        }, el('span', { class: 'nova-orb' }), 'More like this'),
        state.user?.is_admin
          ? el('button', {
              class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': 'Edit metadata', title: 'Edit metadata',
              onClick: () => document.body.append(EditMetadataModal(title)),
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
    left.append(
      el('div', { class: 'detail__section' },
        el('p', { class: 'detail__label' }, 'CAST'),
        el('div', { class: 'people' },
          title.cast.slice(0, 12).map((name) =>
            el('div', { class: 'person' },
              el('div', { class: 'person__face' }, initials(name)),
              el('p', { class: 'person__name' }, name)))))
    );
  }

  const facts = [];
  if (title.directors?.length) facts.push(['DIRECTOR', title.directors.join(', ')]);
  if (title.creators?.length) facts.push(['CREATED BY', title.creators.join(', ')]);
  if (title.writers?.length) facts.push(['WRITTEN BY', title.writers.join(', ')]);
  if (title.genres?.length) facts.push(['GENRES', title.genres.join(', ')]);
  if (title.studios?.length) facts.push(['STUDIO', title.studios.slice(0, 2).join(', ')]);
  if (title.status) facts.push(['STATUS', title.status]);
  if (title.files?.[0]) {
    const f = title.files[0];
    const tech = [f.quality, f.videoCodec?.toUpperCase(), f.audioCodec?.toUpperCase()].filter(Boolean).join(' · ');
    if (tech) facts.push(['FILE', tech]);
  }

  const right = el('aside', {},
    el('div', { class: 'factlist' },
      facts.map(([k, v]) => el('div', { class: 'fact' },
        el('div', { class: 'fact__k' }, k),
        el('div', { class: 'fact__v' }, v)))));

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
      list.append(
        el('button', {
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
            el('p', { class: 'episode__name' },
              ep.name || `Episode ${ep.number}`,
              ep.completed ? el('span', { style: { color: 'var(--good)', marginLeft: '8px', fontSize: '11px' } }, '✓ Watched') : null),
            el('p', { class: 'episode__desc' }, ep.overview || 'No synopsis available.')),
          el('div', { class: 'episode__time' }, ep.runtime ? formatRuntime(ep.runtime) : ''))
      );
    }
  }

  renderSeason();

  return el('div', { class: 'detail__section' },
    el('p', { class: 'detail__label' }, 'EPISODES'),
    bar,
    list);
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

      el('div', { class: 'modal__actions' },
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, 'Cancel'),
        saveBtn)
    )
  );

  document.addEventListener('keydown', onKey);
  document.body.classList.add('is-locked');
  runSearch();

  return modal;
}
