/**
 * Grid-based remote navigation.
 *
 * Three things make a D-pad feel like a D-pad instead of a mouse dragged
 * across the screen:
 *
 * 1. Movement is instant. `scrollIntoView({behavior: 'auto'})` sounds like
 *    "no animation," but per spec 'auto' means "do whatever the element's
 *    CSS `scroll-behavior` says" — and .row__track sets `scroll-behavior:
 *    smooth` on purpose, for mouse users clicking the paging arrows. Under
 *    a remote's key-repeat that same smooth animation stacks call after
 *    call, each one interrupting the last, which is exactly what turns a
 *    crisp row of hops into the laggy, drifting scroll the fix request
 *    described. `behavior: 'instant'` is the only value that actually
 *    overrides the CSS and snaps immediately.
 *
 * 2. Rows are built from document-relative position, not viewport-relative
 *    position. The nav bar is `position: fixed`, so getBoundingClientRect()
 *    always reports it at roughly y=0–68 no matter how far the page has
 *    scrolled — which meant that at just the right scroll offset, the nav's
 *    band would coincidentally overlap whatever scrolled content also
 *    landed near y=0 and the two would get clustered into one row. Once
 *    that happened, "up" had nowhere left to go — the nav had stopped being
 *    its own row — and the cursor would just stick. Treating the nav as
 *    permanently at the top of the document (it visually is, from the
 *    user's point of view) and everything else at its real scrolled
 *    position fixes that at the source.
 *
 * 3. Activation doesn't depend on the browser's native "Enter clicks the
 *    focused button" behavior. That behavior needs Android's hardware
 *    focus and the DOM's focus to agree about which element is current,
 *    and in an Android WebView driven by JS-called .focus() those two can
 *    drift apart — which is what "some play buttons don't work" looks
 *    like from the sofa. So this tracks its own cursor and clicks it
 *    directly on Enter, never relying on the browser to do that step.
 */

// The shelf paging arrows are a mouse-hover convenience (invisible until
// :hover) — a remote can reach every card directly, so they'd only ever be
// focused as an invisible, confusing dead stop. The brand mark links home,
// which from home is a no-op — selectable-but-does-nothing is worse than
// not selectable, so it's excluded the same way. A row's "See all" link
// sits in the row's *header*, well above its cards — a genuinely separate
// document position, not just a visual quirk — so every row grouping this
// module could ever draw would put it in its own band, one full row above
// the cards it belongs to. That turned "press Down once to reach the next
// shelf" into "press Down twice, past a stop that reads as nothing
// happening" on every single genre row, which is most of them. Genre
// browsing is still fully reachable with a remote (Films/Series → the
// genre dropdown), just not as a per-row detour through its own header.
const FOCUSABLE = 'a[href]:not(.brand):not(.row__more), button:not([disabled]):not(.row__arrow), [tabindex]:not([tabindex="-1"]):not([disabled]), input:not([disabled]), select:not([disabled])';

const OVERLAP_SLACK = 2; // px — rows whose bands just graze each other still count as separate

let cursor = null;

function isTvMode() {
  return document.documentElement.classList.contains('tv-mode');
}

function isVisible(el) {
  if (!el || el.disabled) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  // N.O.V.A. stays mounted after closing — closeNova() only drops the
  // .is-open class that slides it off-screen via transform, which doesn't
  // touch offsetParent or give it a zero-size box, so without this its
  // buttons would silently stay reachable (and re-activatable) forever
  // after the first time it's ever opened.
  if (el.closest('.nova:not(.is-open)')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

// Every place content floats on top of the rest of the page while it's
// open — highest z-index first. The background stays fully in the DOM,
// just visually covered, so without this the cursor could wander behind
// whichever of these is open right into content the viewer can't even see.
const OVERLAY_SELECTORS = ['.player__menu', '.modal', '.nova.is-open', '.searchbar'];

function activeOverlay() {
  for (const sel of OVERLAY_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function candidates() {
  const overlay = activeOverlay();
  if (overlay) return Array.from(overlay.querySelectorAll(FOCUSABLE)).filter(isVisible);

  // With no overlay open, a TV remote still needs some way to reach the
  // player's own buttons (audio, subtitles, fullscreen, mute, close) — on
  // desktop those are mouse-clickable and this scoping doesn't apply.
  if (isTvMode()) {
    const playerUi = document.querySelector('.player__ui');
    if (playerUi) return Array.from(playerUi.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  return Array.from(document.querySelectorAll(FOCUSABLE)).filter(isVisible);
}

/** Move the D-pad cursor straight to the first item in a just-opened
 * overlay, so the menu/modal reads as already-focused rather than waiting
 * for a first arrow press to land somewhere. Desktop-only overlays (opened
 * by mouse) are untouched unless this is actually called. */
export function focusFirstIn(container) {
  const items = Array.from(container.querySelectorAll(FOCUSABLE)).filter(isVisible);
  if (items.length) setCursor(groupIntoRows(items)[0]?.items[0]?.el || items[0]);
}

/** Position used for row clustering — real document position, except the
 * fixed nav, which is pinned to the top of every row calculation because
 * that's where it always visually is, regardless of scroll offset. */
function trackPosition(el) {
  const rect = el.getBoundingClientRect();
  if (el.closest('.nav')) return rect;
  return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, left: rect.left, width: rect.width };
}

function overlapsVertically(a, b) {
  return a.top < b.bottom - OVERLAP_SLACK && b.top < a.bottom - OVERLAP_SLACK;
}

/** Cluster elements into visual rows by shared vertical space, left-to-right within each. */
function groupIntoRows(elements) {
  const items = elements
    .map((el) => ({ el, rect: trackPosition(el) }))
    .sort((a, b) => a.rect.top - b.rect.top);

  const rows = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && overlapsVertically(row.band, item.rect)) {
      row.items.push(item);
      row.band = { top: Math.min(row.band.top, item.rect.top), bottom: Math.max(row.band.bottom, item.rect.bottom) };
    } else {
      rows.push({ band: { top: item.rect.top, bottom: item.rect.bottom }, items: [item] });
    }
  }
  for (const row of rows) row.items.sort((a, b) => a.rect.left - b.rect.left);
  return rows;
}

function findPosition(rows, active) {
  for (let r = 0; r < rows.length; r++) {
    const idx = rows[r].items.findIndex((it) => it.el === active);
    if (idx !== -1) return { r, idx };
  }
  return null;
}

function setCursor(el) {
  if (!el || el === cursor) return;
  if (cursor) cursor.classList.remove('tv-cursor');
  cursor = el;
  cursor.classList.add('tv-cursor');
  // .focus() is still worth calling — real keyboards get a real :focus-visible
  // ring from it, and screen readers get a real focus event — but nothing
  // here depends on it succeeding. Activation goes through `cursor` instead.
  try { cursor.focus({ preventScroll: true }); } catch { /* not focusable is fine, it's still clickable */ }

  // scrollIntoView is a no-op on a position:fixed element — it's always
  // technically "in view" regardless of page scroll — so reaching the nav
  // needs an explicit scroll back to the top instead.
  if (cursor.closest('.nav')) {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  } else {
    cursor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
}

function moveFocus(key) {
  // The player's own control row (no explicit menu/modal open over it) is
  // "ambient" rather than something the viewer deliberately opened — Left
  // and Right stay reserved for the player's direct ±10s seek there until
  // a control is already D-pad-focused, so a plain seek press doesn't
  // silently drop a cursor onto a button nobody asked to navigate to. Up
  // and Down have no such direct meaning on a TV remote (volume is normally
  // hardware/CEC-controlled), so they always engage control navigation.
  if (!activeOverlay() && isTvMode()) {
    const playerUi = document.querySelector('.player__ui');
    const engaged = playerUi && cursor && playerUi.contains(cursor);
    if (playerUi && !engaged && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
  }

  const all = candidates();
  if (!all.length) return;
  const rows = groupIntoRows(all);

  const currentEl = cursor && all.includes(cursor) ? cursor : document.activeElement;
  const pos = currentEl ? findPosition(rows, currentEl) : null;
  if (!pos) {
    setCursor(rows[0]?.items[0]?.el);
    return;
  }

  const { r, idx } = pos;
  const row = rows[r];

  if (key === 'ArrowLeft') {
    setCursor(row.items[idx - 1]?.el);
  } else if (key === 'ArrowRight') {
    setCursor(row.items[idx + 1]?.el);
  } else {
    const targetRow = rows[r + (key === 'ArrowUp' ? -1 : 1)];
    if (!targetRow) return;
    // Always the row's first (leftmost) item, not whatever happens to sit
    // nearest the old X position — a shelf you'd scrolled into landing you
    // deep into the *next* shelf too reads as arbitrary, and means the new
    // row doesn't visibly start from its own beginning the way every real
    // streaming app's row-to-row navigation does.
    setCursor(targetRow.items[0]?.el);
  }
}

function focusFirstIfNeeded() {
  requestAnimationFrame(() => {
    if (cursor && document.contains(cursor) && isVisible(cursor)) return;
    if (cursor) cursor.classList.remove('tv-cursor');
    cursor = null;
    const all = candidates();
    if (all.length) setCursor(groupIntoRows(all)[0]?.items[0]?.el || all[0]);
  });
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ACTIVATE_KEYS = new Set(['Enter', ' ']);

// The actual cause of "one press moved two rows" turned out to be a
// duplicate event listener (fixed at the source in app.js — mountShell()
// was re-binding it on every profile switch), not the remote double-firing
// a press. This window is now only a backstop against a genuinely
// same-tick duplicate dispatch, not a general debounce — anything longer
// risks swallowing a real fast press, which is its own bug (reported as
// "I press down and it doesn't move, then I have to press it again").
const MIN_MOVE_INTERVAL_MS = 40;
let lastMoveAt = 0;

export function initTvNav() {
  document.addEventListener('keydown', (e) => {
    // On desktop, the player owns arrows/Enter directly for seek/volume/play
    // — except while its own audio/subtitle menu is open, when this takes
    // over navigating that menu's items instead (candidates() scopes to
    // just the menu for this). A TV remote has no other way to reach the
    // player's own buttons at all (no mouse, no keyboard shortcut letters),
    // so in tv-mode this stays in control the whole time the player is
    // open — player.js itself skips the keys this owns there (see the
    // TV_MODE checks in player.js's own keydown handler), so the two never
    // fight over the same press.
    if (!isTvMode() && document.querySelector('.player') && !document.querySelector('.player__menu')) return;

    const typing = e.target.matches('input, textarea, select, [contenteditable]');

    if (ARROWS.has(e.key)) {
      // Left/right still move the text cursor while typing; up/down do
      // nothing in a single-line field, so they're free to move focus.
      if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastMoveAt < MIN_MOVE_INTERVAL_MS) return;
      lastMoveAt = now;
      moveFocus(e.key);
      return;
    }

    // Checked against the current scope, not just "still in the DOM" — an
    // overlay opening on top of the page (the player, a modal, ...) leaves
    // whatever was focused before it underneath, still technically in the
    // document; without this a stray Select press could reach right through
    // the overlay and re-activate something the viewer can no longer see.
    if (ACTIVATE_KEYS.has(e.key) && !typing && cursor && candidates().includes(cursor)) {
      e.preventDefault();
      cursor.click();
    }
  });

  window.addEventListener('hashchange', focusFirstIfNeeded);
  // A click (mouse, touch, or a real Tab focus) should also become the
  // cursor, so the two ways of pointing at something never disagree.
  document.addEventListener(
    'focusin',
    (e) => {
      if (e.target.matches(FOCUSABLE) && e.target !== cursor) {
        if (cursor) cursor.classList.remove('tv-cursor');
        cursor = e.target;
        cursor.classList.add('tv-cursor');
      }
    },
    true
  );

  focusFirstIfNeeded();
}
