import { el } from '../ui.js';
import { navigate } from '../router.js';

/**
 * The three things a screen can be when it isn't showing what you came for:
 * loading, empty, or broken.
 *
 * These were written three times over in three different tones — a bare
 * "Failed to fetch" in one place, a properly explained "check the server is
 * running" in another — which meant the quality of the answer depended on
 * which page you happened to be on when the Wi-Fi dropped. One version, used
 * everywhere, so it doesn't.
 */

/**
 * Whether a failure is the network rather than the server saying no.
 *
 * `navigator.onLine` is only trustworthy in the negative — a browser that
 * says it is online may still be on a network that goes nowhere — so the
 * fetch failure itself is the better signal, and a TypeError from fetch is
 * what a dropped connection looks like from here.
 */
export function isOffline(err) {
  if (!navigator.onLine) return true;
  return /failed to fetch|networkerror|load failed|network request failed/i.test(err?.message || '');
}

/**
 * Something went wrong. Says which kind of wrong, in words that suggest what
 * to do about it, and offers the one action that might help.
 *
 * The message is set as text, never as markup: it can carry a server's own
 * words, and those are not ours to trust.
 */
export function ErrorState(err, { retry = null, home = false, compact = false } = {}) {
  const offline = isOffline(err);
  const status = err?.status;

  let heading = 'That did not load';
  let detail = err?.message || 'Something went wrong.';

  if (offline) {
    heading = 'Cannot reach the server';
    detail = 'ECLIPSE is not responding. Check the server is running and this device is on the same network.';
  } else if (status === 401) {
    heading = 'Signed out';
    detail = 'This session has expired. Sign in again to carry on.';
  } else if (status === 403) {
    heading = 'Not available on this profile';
    detail = 'A parental limit on this profile covers this title.';
  } else if (status === 404) {
    heading = 'Not here any more';
    detail = 'This is no longer in the library. It may have been removed or renamed.';
  } else if (status >= 500) {
    heading = 'The server had a problem';
    detail = 'Something went wrong at the ECLIPSE end. The server log under Settings → Server will say what.';
  }

  return el('div', { class: `empty${compact ? ' empty--compact' : ''}` },
    el('h2', {}, heading),
    el('p', {}, detail),
    el('div', { class: 'empty__actions' },
      retry ? el('button', { class: 'btn btn--play btn--sm', type: 'button', onClick: () => retry() }, 'Try again') : null,
      home ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => navigate('/') }, 'Back to home') : null));
}

/**
 * Nothing to show, which is not the same as something being broken — so it
 * reads as a state of the library rather than as a failure, and points at
 * whatever would change it.
 */
export function EmptyState(heading, detail, action = null) {
  return el('div', { class: 'empty' },
    el('h2', {}, heading),
    detail ? el('p', {}, detail) : null,
    action
      ? el('div', { class: 'empty__actions' },
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => action.onClick() }, action.label))
      : null);
}

/**
 * Placeholder cards for a grid. Returns the cards themselves rather than a
 * wrapper, so they become children of the caller's existing grid instead of
 * one nested grid squeezed into a single column of it.
 */
export function gridSkeleton(count = 12) {
  return Array.from({ length: count }, () => el('div', { class: 'skeleton skeleton--card' }));
}
