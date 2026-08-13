/**
 * Grid-based remote navigation.
 *
 * A generic "focus whatever's nearest in that direction" search feels like
 * steering a mouse cursor with a D-pad — it can drift diagonally and land on
 * the wrong thing. Real ten-foot interfaces (Netflix, Fire TV's own apps)
 * use a stricter model: Left/Right move along the current shelf and never
 * change row; Up/Down jump to the shelf above/below and land on whichever
 * card lines up best horizontally. This builds that grid fresh on every
 * keypress from actual layout — no per-page bookkeeping to keep in sync.
 *
 * Enter/Space need nothing extra: the focused element is a real <button> or
 * <a>, and browsers already activate those on Enter or Space.
 */

// The shelf paging arrows are a mouse-hover convenience (invisible until
// :hover) — a remote can reach every card directly, so they'd only ever be
// focused as an invisible, confusing dead stop.
const FOCUSABLE = 'a[href], button:not([disabled]):not(.row__arrow), [tabindex]:not([tabindex="-1"]):not([disabled]), input:not([disabled]), select:not([disabled])';

const OVERLAP_SLACK = 2; // px — rows whose bands just graze each other still count as separate

function isVisible(el) {
  if (!el || el.disabled) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function candidates() {
  return Array.from(document.querySelectorAll(FOCUSABLE)).filter(isVisible);
}

function overlapsVertically(a, b) {
  return a.top < b.bottom - OVERLAP_SLACK && b.top < a.bottom - OVERLAP_SLACK;
}

/** Cluster elements into visual rows by shared vertical space, left-to-right within each. */
function groupIntoRows(elements) {
  const items = elements
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
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

function nearestByX(items, x) {
  let best = null;
  let bestDist = Infinity;
  for (const it of items) {
    const cx = it.rect.left + it.rect.width / 2;
    const dist = Math.abs(cx - x);
    if (dist < bestDist) { bestDist = dist; best = it; }
  }
  return best?.el || null;
}

function focus(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function moveFocus(key) {
  const all = candidates();
  if (!all.length) return;
  const rows = groupIntoRows(all);

  const pos = document.activeElement ? findPosition(rows, document.activeElement) : null;
  if (!pos) {
    focus(rows[0]?.items[0]?.el);
    return;
  }

  const { r, idx } = pos;
  const row = rows[r];

  if (key === 'ArrowLeft') {
    focus(row.items[idx - 1]?.el);
  } else if (key === 'ArrowRight') {
    focus(row.items[idx + 1]?.el);
  } else {
    const targetRow = rows[r + (key === 'ArrowUp' ? -1 : 1)];
    if (!targetRow) return;
    const currentX = row.items[idx].rect.left + row.items[idx].rect.width / 2;
    focus(nearestByX(targetRow.items, currentX));
  }
}

function focusFirstIfNeeded() {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active) && isVisible(active)) return;
    const all = candidates();
    if (all.length) all[0].focus({ preventScroll: true });
  });
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export function initTvNav() {
  document.addEventListener('keydown', (e) => {
    if (!ARROWS.has(e.key)) return;
    if (document.querySelector('.player')) return; // the player owns arrows for seek/volume

    const typing = e.target.matches('input, textarea, select, [contenteditable]');
    // Left/right still move the text cursor while typing; up/down do nothing
    // in a single-line field, so they're free to move focus instead.
    if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

    e.preventDefault();
    moveFocus(e.key);
  });

  window.addEventListener('hashchange', focusFirstIfNeeded);
  focusFirstIfNeeded();
}
