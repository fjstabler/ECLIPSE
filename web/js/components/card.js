import { el, icon, formatRuntime, initials } from '../ui.js';
import { navigate } from '../router.js';
import { openPlayer } from './player.js';

/**
 * A poster card. `variant: 'wide'` switches to a 16:9 still with a progress
 * bar, which is what "Continue watching" wants.
 */
export function Card(title, { variant = 'poster', showReason = false } = {}) {
  const wide = variant === 'wide';
  const resume = title.resume;
  const progress = resume?.progress ?? (resume?.duration ? resume.position / resume.duration : 0);

  const art = wide ? title.backdrop || title.poster : title.poster || title.backdrop;

  const badges = [];
  if (title.certification) badges.push(el('span', { class: 'badge' }, title.certification));
  if (isNew(title.added_at)) badges.push(el('span', { class: 'badge badge--new' }, 'NEW'));
  if (showReason && title.score != null) badges.push(el('span', { class: 'badge badge--nova' }, 'N.O.V.A.'));

  const node = el(
    'button',
    {
      class: `card${wide ? ' card--wide' : ''}`,
      type: 'button',
      'aria-label': `${title.title}${title.year ? `, ${title.year}` : ''}`,
      onClick: (e) => {
        // Clicking the play glyph starts playback; anywhere else opens details.
        if (e.target.closest('.card__play')) {
          e.stopPropagation();
          quickPlay(title);
          return;
        }
        navigate(`/title/${title.id}`);
      },
    },
    el(
      'div',
      { class: 'card__art', dataset: { initials: initials(title.title) } },
      el('img', {
        src: art || '',
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        // Cached artwork can go missing under ECLIPSE — a cleared cache, a
        // half-finished download. Falling back to the title's initials keeps
        // the tile readable instead of leaving a blank hole in the shelf.
        onError: (e) => {
          // Find the tile before detaching, not after — a removed node has no
          // ancestors to search.
          const art = e.target.closest('.card__art');
          e.target.remove();
          art?.classList.add('card__art--blank');
        },
      }),
      badges.length ? el('div', { class: 'card__badges' }, badges) : null,
      el('div', { class: 'card__overlay' }),
      el('div', { class: 'card__play' }, icon('play')),
      progress > 0.01 && progress < 0.97
        ? el('div', { class: 'card__progress' }, el('span', { style: { width: `${Math.round(progress * 100)}%` } }))
        : null
    ),
    el(
      'div',
      { class: 'card__body' },
      el('p', { class: 'card__name' }, title.title),
      el(
        'div',
        { class: 'card__sub' },
        title.year ? el('span', {}, String(title.year)) : null,
        resume?.season
          ? el('span', {}, `S${resume.season} E${resume.episode}`)
          : title.kind === 'series'
            ? el('span', {}, 'Series')
            : title.runtime
              ? el('span', {}, formatRuntime(title.runtime))
              : null
      ),
      showReason && title.reason ? el('p', { class: 'card__reason' }, title.reason) : null
    )
  );

  return node;
}

function isNew(addedAt) {
  if (!addedAt) return false;
  const added = new Date(addedAt.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - added < 7 * 86400_000;
}

async function quickPlay(title) {
  if (title.resume?.fileId) {
    openPlayer(title.resume.fileId, title.resume.position || 0);
    return;
  }
  // The card doesn't always carry resume info; the title endpoint does.
  const { api } = await import('../api.js');
  const detail = await api.title(title.id);
  const target = detail.resume || detail.primaryFile;
  if (!target) return;
  openPlayer(target.fileId ?? target.id, target.position || 0);
}
