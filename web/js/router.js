/** Hash router. No build step, no history-API server config to get wrong. */

import { cancelScrollAnimation } from './tvnav.js';

const routes = [];
let outlet = null;
let currentCleanup = null;

export function defineRoute(pattern, handler) {
  // "/title/:id" -> /^\/title\/([^/]+)$/
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    })}$`
  );
  routes.push({ regex, keys, handler });
}

export function setOutlet(node) {
  outlet = node;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) {
    render();
    return;
  }
  if (replace) location.replace(target);
  else location.hash = target;
}

export function currentPath() {
  const raw = location.hash.slice(1) || '/';
  return raw.split('?')[0];
}

export function currentQuery() {
  const raw = location.hash.slice(1);
  const qIndex = raw.indexOf('?');
  return new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : '');
}

export async function render() {
  if (!outlet) return;

  if (currentCleanup) {
    try { currentCleanup(); } catch { /* a view teardown shouldn't block navigation */ }
    currentCleanup = null;
  }

  const path = currentPath();
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (!match) continue;

    const params = {};
    route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });

    outlet.replaceChildren();
    try {
      const cleanup = await route.handler({ params, query: currentQuery(), outlet });
      if (typeof cleanup === 'function') currentCleanup = cleanup;
    } catch (err) {
      console.error('[route]', err);
      outlet.replaceChildren(errorView(err));
    }
    // A row-to-row glide left running from the outgoing page would otherwise
    // fight this for a frame or two, since it keeps calling scrollTo itself.
    cancelScrollAnimation();
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }

  navigate('/', { replace: true });
}

function errorView(err) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `<h2>That didn't load</h2><p>${err.message}</p>`;
  return wrap;
}

window.addEventListener('hashchange', render);
