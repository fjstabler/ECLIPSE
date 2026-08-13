import { el, icon } from '../ui.js';
import { Card } from './card.js';

/**
 * A horizontally-scrolling shelf. The arrows page by roughly one viewport of
 * cards and hide themselves at each end so they never sit there doing nothing.
 */
export function Row(row) {
  const isNova = row.kind === 'nova' || row.id === 'for-you';
  const wide = row.id === 'continue';

  const track = el(
    'div',
    { class: 'row__track' },
    row.items.map((item) => Card(item, { variant: wide ? 'wide' : 'poster', showReason: isNova }))
  );

  const prev = el('button', {
    class: 'row__arrow row__arrow--prev',
    type: 'button',
    'aria-label': 'Scroll left',
    hidden: true,
    onClick: () => track.scrollBy({ left: -pageSize(track), behavior: 'smooth' }),
  }, icon('chevronLeft'));

  const next = el('button', {
    class: 'row__arrow row__arrow--next',
    type: 'button',
    'aria-label': 'Scroll right',
    onClick: () => track.scrollBy({ left: pageSize(track), behavior: 'smooth' }),
  }, icon('chevronRight'));

  const updateArrows = () => {
    const max = track.scrollWidth - track.clientWidth;
    prev.hidden = track.scrollLeft < 12;
    next.hidden = track.scrollLeft > max - 12;
  };

  track.addEventListener('scroll', updateArrows, { passive: true });
  // Layout isn't settled on the first frame, so measure once it is.
  requestAnimationFrame(updateArrows);
  new ResizeObserver(updateArrows).observe(track);

  return el(
    'section',
    { class: 'row' },
    el(
      'div',
      { class: 'row__head' },
      el(
        'h2',
        { class: `row__title${isNova ? ' row__title--nova' : ''}` },
        isNova ? el('span', { class: 'nova-orb' }) : null,
        row.title
      ),
      row.genre ? el('a', { class: 'row__more', href: `#/browse?genre=${encodeURIComponent(row.genre)}` }, 'See all') : null
    ),
    el('div', { class: 'row__viewport' }, prev, track, next)
  );
}

function pageSize(track) {
  const card = track.querySelector('.card');
  const cardWidth = card ? card.offsetWidth + 12 : 200;
  const perPage = Math.max(1, Math.floor(track.clientWidth / cardWidth));
  return cardWidth * perPage;
}
