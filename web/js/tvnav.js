/**
 * Arrow-key spatial navigation.
 *
 * The interface is built from real buttons and links, so Tab already reaches
 * everything — but a TV remote's D-pad sends arrow keys, not Tab, and there's
 * no such thing as pointing and clicking from the sofa. This turns arrow keys
 * into "move focus to whatever's nearest in that direction," which is what
 * every ten-foot interface (and the Fire TV WebView this also runs in) needs.
 *
 * Enter/Space need nothing extra: the focused element is a real <button> or
 * <a>, and browsers already activate those on Enter or Space.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]), input:not([disabled]), select:not([disabled])';

const DIRS = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

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

/** Nearest candidate in the pressed direction, weighted against drifting off-axis. */
function moveFocus(key) {
  const { dx, dy } = DIRS[key];
  const all = candidates();
  if (!all.length) return;

  const active = document.activeElement;
  if (!active || active === document.body || !all.includes(active)) {
    all[0].focus({ preventScroll: true });
    all[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }

  const from = active.getBoundingClientRect();
  const fromCenter = { x: from.left + from.width / 2, y: from.top + from.height / 2 };

  let best = null;
  let bestScore = Infinity;

  for (const el of all) {
    if (el === active) continue;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const vx = center.x - fromCenter.x;
    const vy = center.y - fromCenter.y;

    const primary = dx !== 0 ? vx * dx : vy * dy;
    if (primary <= 1) continue; // behind or level — not "that way"

    const perpendicular = dx !== 0 ? Math.abs(vy) : Math.abs(vx);
    const score = primary + perpendicular * 2.5;

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
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

export function initTvNav() {
  document.addEventListener('keydown', (e) => {
    if (!DIRS[e.key]) return;
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
