import { el } from '../ui.js';
import { api } from '../api.js';
import { Card } from '../components/card.js';
import { navigate, currentPath } from '../router.js';

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
    api.genres().then(({ genres }) => {
      for (const g of genres) {
        const opt = el('option', { value: g.name }, `${g.name} (${g.count})`);
        genreSelect.append(opt);
      }
      genreSelect.value = state.genre;
    });
  }

  async function load() {
    grid.replaceChildren(
      ...Array.from({ length: 12 }, () => el('div', { class: 'skeleton', style: { aspectRatio: '2/3' } }))
    );

    const data = isList
      ? await api.watchlist()
      : await api.titles({
          kind: state.kind || '',
          genre: state.genre || '',
          sort: state.sort,
          limit: 200,
        });

    grid.replaceChildren();

    if (!data.items.length) {
      grid.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        el('h2', {}, isList ? 'Your list is empty' : 'Nothing here yet'),
        el('p', {}, isList
          ? 'Add titles from any detail page and they will wait for you here.'
          : 'Try a different filter, or add more media to your library folders.'),
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => navigate('/') }, 'Back to home')));
      return;
    }

    for (const item of data.items) grid.append(Card(item));
  }

  load();
}
