import { el, icon, clear } from '../ui.js';
import { api } from '../api.js';
import { Card } from '../components/card.js';

/** Full-screen search overlay, opened with the toolbar button or "/". */
let overlay = null;

export function openSearch() {
  if (overlay) {
    overlay.querySelector('.searchbar__input').focus();
    return;
  }

  const results = el('div', { class: 'searchbar__body' });
  const grid = el('div', { class: 'grid' });
  results.append(grid);

  let timer = null;
  let lastQuery = '';

  const input = el('input', {
    class: 'searchbar__input',
    placeholder: 'Search films, series, actors, directors…',
    autocomplete: 'off',
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
      clear(grid);
      results.append(hint());
      return;
    }
    const hintNode = results.querySelector('.empty');
    if (hintNode) hintNode.remove();

    const { items } = await api.search(q);
    clear(grid);
    if (!items.length) {
      grid.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        el('h2', {}, `Nothing on this server matches "${q}"`),
        el('p', {}, 'Try a different spelling, or ask NOVA — it can search by mood as well as by name.')));
      return;
    }
    for (const item of items) grid.append(Card(item));
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
    if (e.target.closest('.card')) setTimeout(closeSearch, 60);
  });
}

function hint() {
  return el('div', { class: 'empty' },
    el('p', {}, 'Search by title, cast or director. Press Esc to close.'));
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
