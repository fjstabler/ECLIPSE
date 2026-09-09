import { el, initials, icon } from '../ui.js';
import { api } from '../api.js';
import { Card } from '../components/card.js';
import { navigate } from '../router.js';
import { ErrorState, EmptyState } from '../components/states.js';

const ROLE_LABELS = {
  cast: 'Actor', director: 'Director', creator: 'Creator', writer: 'Writer',
};

/**
 * Everything one person is in. Reached from a cast photo or a search result —
 * the answer to "what else have I got with them in it", which is otherwise a
 * question the library can't be asked.
 */
export async function PersonView({ params, outlet }) {
  const name = decodeURIComponent(params.name || '');

  let person;
  try {
    person = await api.person(name);
  } catch (err) {
    // "Nobody by that name" is worth saying in those words rather than as a
    // generic 404, since the name is the whole of what was asked for.
    outlet.append(el('div', { class: 'page page--padded' },
      err.status === 404
        ? EmptyState('Not in this library', `Nothing on this server credits ${name}.`,
            { label: 'Back to home', onClick: () => navigate('/') })
        : ErrorState(err, {
            retry: () => { outlet.replaceChildren(); PersonView({ params, outlet }); },
            home: true,
          })));
    return;
  }

  const roles = person.roles.map((r) => ROLE_LABELS[r] || r);
  const byKind = {
    movie: person.titles.filter((t) => t.kind === 'movie'),
    series: person.titles.filter((t) => t.kind === 'series'),
  };

  outlet.append(
    el('div', { class: 'page page--padded' },
      el('div', { class: 'person-head' },
        el('div', { class: 'person-head__face' },
          person.image
            ? el('img', { src: person.image, alt: '' })
            : el('span', {}, initials(person.name))),
        el('div', {},
          el('h1', { class: 'person-head__name' }, person.name),
          el('p', { class: 'person-head__meta' },
            [roles.join(' · '), `${person.titles.length} title${person.titles.length === 1 ? '' : 's'} here`]
              .filter(Boolean).join(' — ')))),

      ...['movie', 'series']
        .filter((kind) => byKind[kind].length)
        .map((kind) =>
          el('section', { class: 'person-section' },
            el('h2', { class: 'row__title' }, kind === 'movie' ? 'Films' : 'Series'),
            el('div', { class: 'grid' }, byKind[kind].map((t) => Card(t)))))
    )
  );
}
