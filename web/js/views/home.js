import { el, icon, formatRuntime } from '../ui.js';
import { api } from '../api.js';
import { Row } from '../components/row.js';
import { openPlayer } from '../components/player.js';
import { navigate } from '../router.js';
import { ErrorState } from '../components/states.js';

export async function HomeView({ outlet }) {
  outlet.append(skeleton());

  let data;
  try {
    data = await api.home();
  } catch (err) {
    // Home is where a TV lands on wake, so this is the screen most likely to
    // meet a server that isn't up yet. Retrying in place beats sending the
    // viewer back to a router-level error for the page they were already on.
    outlet.replaceChildren(ErrorState(err, { retry: () => { outlet.replaceChildren(); HomeView({ outlet }); } }));
    return;
  }
  outlet.replaceChildren();

  if (!data.rows.length) {
    outlet.append(data.filteredByRating ? nothingPermitted() : emptyLibrary());
    return;
  }

  if (data.hero) outlet.append(Hero(data.hero));
  const page = el('div', { class: 'page' }, data.rows.map((row) => Row(row)));
  outlet.append(page);
}

function Hero(title) {
  const resume = title.resume;
  const meta = [];
  if (title.year) meta.push(el('span', {}, String(title.year)));
  if (title.certification) meta.push(el('span', { class: 'chip chip--cert' }, title.certification));
  if (title.rating) meta.push(el('span', { class: 'chip chip--rating' }, `★ ${title.rating.toFixed(1)}`));
  if (title.kind === 'series') meta.push(el('span', {}, `${title.seasons?.length || 0} seasons`));
  else if (title.runtime) meta.push(el('span', {}, formatRuntime(title.runtime)));
  if (title.genres?.length) meta.push(el('span', {}, title.genres.slice(0, 3).join(' · ')));

  return el(
    'section',
    { class: 'hero' },
    el(
      'div',
      { class: 'hero__media' },
      el('img', { src: title.backdrop || title.poster || '', alt: '' })
    ),
    el('div', { class: 'hero__scrim' }),
    el(
      'div',
      { class: 'hero__body' },
      title.logo
        ? el('img', { class: 'hero__logo', src: title.logo, alt: title.title })
        : el('h1', { class: 'hero__title' }, title.title),
      el('div', { class: 'hero__meta' }, meta),
      title.overview ? el('p', { class: 'hero__overview' }, title.overview) : null,
      el(
        'div',
        { class: 'hero__actions' },
        resume
          ? el('button', {
              class: 'btn btn--play', type: 'button',
              onClick: () => openPlayer(resume.fileId, resume.position || 0),
            }, icon('play'), resume.label || 'Play')
          : null,
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          onClick: () => navigate(`/title/${title.id}`),
        }, icon('info'), 'More info')
      ),
      // Plain caption, not a button — the N.O.V.A. button in the nav already
      // does this, so a second D-pad stop here (previously its own row,
      // bold and highlightable) was redundant and, for anyone scrolling
      // past the hero, an extra press just to get back up to it.
      el(
        'div',
        { class: 'hero__nova' },
        el('span', { class: 'nova-orb' }),
        el('span', {}, 'Not feeling this one? Ask N.O.V.A. for something else.')
      )
    )
  );
}

function skeleton() {
  return el(
    'div',
    { class: 'page' },
    el('div', { class: 'skeleton', style: { height: '70vh', margin: '0 0 40px', borderRadius: '0' } }),
    [0, 1, 2].map(() =>
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'row__head' }, el('div', { class: 'skeleton', style: { height: '22px', width: '200px' } })),
        el(
          'div',
          { class: 'row__track', style: { overflow: 'hidden' } },
          Array.from({ length: 8 }, () =>
            el('div', { class: 'skeleton card', style: { aspectRatio: '2/3', height: '250px' } })
          )
        )
      )
    )
  );
}

/**
 * There is plenty here — this profile just isn't allowed to see any of it.
 * Usually an age limit on a server whose titles have no certification,
 * since unrated counts as blocked.
 */
function nothingPermitted() {
  return el('div', { class: 'page page--padded' },
    el('div', { class: 'empty' },
      el('h2', {}, 'Nothing here is available on this profile'),
      el('p', {},
        'This profile has an age limit, and nothing in the library is rated within it. ',
        'Titles ECLIPSE could not classify count as blocked, so a library without ratings will look empty. ',
        'An administrator can change the limit under Settings → Profiles.'),
      el('div', { class: 'empty__actions' },
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => navigate('/settings') }, 'Open settings'))));
}

function emptyLibrary() {
  return el(
    'div',
    { class: 'page page--padded' },
    el(
      'div',
      { class: 'empty' },
      el('div', { class: 'nova__orb-lg', style: { marginBottom: '26px' } }),
      el('h2', {}, 'Your library is empty'),
      el(
        'p',
        {},
        'Point ECLIPSE at a folder of films or series and it will pick them up automatically. ',
        'Set ',
        el('code', {}, 'ECLIPSE_MOVIES_DIR'),
        ' and ',
        el('code', {}, 'ECLIPSE_SERIES_DIR'),
        ' in your ',
        el('code', {}, '.env'),
        ' file, then restart the server.'
      ),
      el('button', { class: 'btn btn--corona', type: 'button', onClick: () => navigate('/settings') }, 'Open settings')
    )
  );
}
