import { el } from '../ui.js';
import { api } from '../api.js';
import { Card } from '../components/card.js';
import { navigate, currentPath } from '../router.js';
import { ErrorState, EmptyState, gridSkeleton } from '../components/states.js';

/** Films / Series / My list — a filterable grid. */
export async function BrowseView({ query, outlet }) {
  const path = currentPath();
  const preset = path === '/films' ? 'movie' : path === '/series' ? 'series' : null;
  const isList = path === '/my-list';

  const state = {
    kind: preset,
    genre: query.get('genre') || '',
    sort: query.get('sort') || 'added',
  };

  const grid = el('div', { class: 'grid' });
  const heading = isList ? 'Your list' : preset === 'movie' ? 'Films' : preset === 'series' ? 'Series' : 'Everything';

  const genreSelect = el('select', {
    class: 'select',
    onChange: (e) => { state.genre = e.target.value; load(); },
  }, el('option', { value: '' }, 'All genres'));

  const sortSelect = el('select', {
    class: 'select',
    onChange: (e) => { state.sort = e.target.value; load(); },
  },
    el('option', { value: 'added' }, 'Recently added'),
    el('option', { value: 'title' }, 'A–Z'),
    el('option', { value: 'year' }, 'Newest first'),
    el('option', { value: 'rating' }, 'Highest rated'));
  sortSelect.value = state.sort;

  const toolbar = el('div', { class: 'toolbar' },
    el('h1', { class: 'toolbar__title' }, heading),
    isList ? null : genreSelect,
    isList ? null : sortSelect);

  outlet.append(el('div', { class: 'page page--padded' }, toolbar, grid));

  if (!isList) {
    // The grid is the page; a genre list that doesn't arrive costs the
    // viewer one filter, not the whole screen, so it fails quietly.
    api.genres().then(({ genres }) => {
      for (const g of genres) {
        const opt = el('option', { value: g.name }, `${g.name} (${g.count})`);
        genreSelect.append(opt);
      }
      genreSelect.value = state.genre;
    }).catch(() => { genreSelect.disabled = true; });
  }

  async function load() {
    grid.replaceChildren(...gridSkeleton(12));

    let data;
    try {
      data = isList
        ? await api.watchlist()
        : await api.titles({
            kind: state.kind || '',
            genre: state.genre || '',
            sort: state.sort,
            limit: 200,
          });
    } catch (err) {
      // Without this the skeletons simply stayed forever, which reads as a
      // library that is still thinking rather than a server that is gone.
      grid.replaceChildren(el('div', { style: { gridColumn: '1 / -1' } },
        ErrorState(err, { retry: () => load(), home: true })));
      return;
    }

    grid.replaceChildren();

    if (!data.items.length) {
      grid.append(el('div', { style: { gridColumn: '1 / -1' } },
        EmptyState(
          isList ? 'Your list is empty' : 'Nothing here yet',
          isList
            ? 'Add titles from any detail page and they will wait for you here.'
            : 'Try a different filter, or add more media to your library folders.',
          { label: 'Back to home', onClick: () => navigate('/') }
        )));
      return;
    }

    for (const item of data.items) grid.append(Card(item));
  }

  load();
}
