import { el, icon, clear, initials } from '../ui.js';
import { api } from '../api.js';
import { ErrorState } from '../components/states.js';
import { Card } from '../components/card.js';

/** Full-screen search overlay, opened with the toolbar button or "/". */
let overlay = null;

export function openSearch() {
  if (overlay) {
    overlay.querySelector('.searchbar__input').focus();
    return;
  }

  const results = el('div', { class: 'searchbar__body' });

  let timer = null;
  let lastQuery = '';

  const input = el('input', {
    class: 'searchbar__input',
    placeholder: 'Search films, series, actors, directors…',
    autocomplete: 'off',
    enterkeyhint: 'search',
    onInput: (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      // Debounce so a fast typist doesn't fire a request per keystroke.
      timer = setTimeout(() => run(q), 220);
    },
    onKeydown: (e) => { if (e.key === 'Escape') closeSearch(); },
  });

  async function run(q) {
    if (q === lastQuery) return;
    lastQuery = q;

    if (q.length < 2) {
      clear(results).append(hint());
      return;
    }

    let data;
    try {
      data = await api.search(q);
    } catch (err) {
      clear(results).append(ErrorState(err, { retry: () => run(q) }));
      return;
    }
    // A slower earlier request must not overwrite a newer one's results.
    if (q !== lastQuery) return;

    const { items = [], people = [], episodes = [], tags = [] } = data;
    clear(results);

    if (!items.length && !people.length && !episodes.length && !tags.length) {
      results.append(el('div', { class: 'empty' },
        el('h2', {}, `Nothing on this server matches "${q}"`),
        el('p', {}, 'Try a different spelling, or ask N.O.V.A. — it can search by mood as well as by name.')));
      return;
    }

    // People and tags first: they're navigation, and they're what turns a
    // search into a way of browsing sideways.
    if (people.length) {
      results.append(section('People',
        el('div', { class: 'search-people' },
          people.map((p) =>
            el('a', { class: 'search-person', href: `#/person/${encodeURIComponent(p.name)}` },
              el('div', { class: 'search-person__face' },
                p.image ? el('img', { src: p.image, alt: '' }) : el('span', {}, initials(p.name))),
              el('div', {},
                el('div', { class: 'search-person__name' }, p.name),
                el('div', { class: 'search-person__meta' },
                  `${roleLabel(p.role)} · ${p.count} title${p.count === 1 ? '' : 's'}`)))))));
    }

    if (tags.length) {
      results.append(section('Genres and collections',
        el('div', { class: 'pill-choice' },
          tags.map((t) =>
            el('a', {
              class: 'search-tag',
              href: t.type === 'genre' ? `#/browse?genre=${encodeURIComponent(t.value)}` : '#/',
            }, t.value, el('span', { class: 'search-tag__count' }, String(t.count)))))));
    }

    if (items.length) {
      results.append(section('Titles', el('div', { class: 'grid' }, items.map((item) => Card(item)))));
    }

    if (episodes.length) {
      results.append(section('Episodes',
        el('div', { class: 'search-episodes' },
          episodes.map((e) =>
            el('a', { class: 'search-episode', href: `#/title/${e.titleId}` },
              e.still
                ? el('img', { class: 'search-episode__still', src: e.still, alt: '', loading: 'lazy' })
                : el('div', { class: 'search-episode__still' }),
              el('div', {},
                el('div', { class: 'search-episode__name' }, e.name),
                el('div', { class: 'search-episode__meta' }, `${e.series} · S${e.season} E${e.number}`)))))));
    }
  }

  function section(title, body) {
    return el('section', { class: 'search-section' },
      el('h2', { class: 'search-section__title' }, title), body);
  }

  overlay = el('div', { class: 'searchbar' },
    el('div', { class: 'searchbar__head' },
      el('span', { style: { color: 'var(--text-faint)', display: 'flex' } }, icon('search')),
      input,
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close search', onClick: () => closeSearch() }, icon('close'))),
    results);

  results.append(hint());
  document.body.append(overlay);
  document.body.classList.add('is-locked');
  setTimeout(() => input.focus(), 40);

  // Clicking a result navigates, so close the overlay behind it.
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.card, .search-person, .search-episode, .search-tag')) setTimeout(closeSearch, 60);
  });
}

function hint() {
  return el('div', { class: 'empty' },
    el('p', {}, 'Search by title, episode, cast, director, genre or collection. Press Esc to close.'));
}

function roleLabel(role) {
  return { cast: 'Actor', director: 'Director', creator: 'Creator', writer: 'Writer' }[role] || role;
}

export function closeSearch() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.body.classList.remove('is-locked');
}

export function isSearchOpen() {
  return Boolean(overlay);
}
