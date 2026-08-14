import { el, icon, clear, initials } from './ui.js';
import { api } from './api.js';
import { state } from './state.js';
import { defineRoute, setOutlet, render, navigate, currentPath } from './router.js';
import { HomeView } from './views/home.js';
import { TitleView } from './views/title.js';
import { BrowseView } from './views/browse.js';
import { SettingsView } from './views/settings.js';
import { AuthView } from './views/auth.js';
import { openSearch, closeSearch, isSearchOpen } from './views/search.js';
import { toggleNova, openNova, closeNova, isNovaOpen } from './components/nova.js';
import { closePlayer } from './components/player.js';
import { initTvNav } from './tvnav.js';

const app = document.getElementById('app');

async function boot() {
  let info;
  try {
    info = await api.me();
  } catch {
    clear(app).append(
      el('div', { class: 'empty', style: { paddingTop: '25vh' } },
        el('h2', {}, 'Cannot reach the ECLIPSE server'),
        el('p', {}, 'The server may still be starting up. Refresh in a moment.'))
    );
    return;
  }

  state.features = info.features || state.features;

  if (!info.user) {
    clear(app).append(AuthView({ onSignedIn: () => boot() }));
    return;
  }

  state.user = info.user;
  mountShell();
}

// Signing out and back in — switching profiles, which every household
// member does on the same long-lived Fire TV session — calls boot() again.
// Routes and document-level listeners must only ever be wired up once, or
// every one of them fires twice per keypress on the second pass: two
// listeners moving the cursor for a single ArrowDown looks exactly like
// "it randomly jumps two."
let shellInitialized = false;

function mountShell() {
  const outlet = el('main', { id: 'outlet' });
  clear(app).append(Nav(), outlet);
  setOutlet(outlet);

  if (!shellInitialized) {
    shellInitialized = true;
    defineRoute('/', HomeView);
    defineRoute('/films', BrowseView);
    defineRoute('/series', BrowseView);
    defineRoute('/my-list', BrowseView);
    defineRoute('/browse', BrowseView);
    defineRoute('/title/:id', TitleView);
    defineRoute('/settings', SettingsView);

    bindGlobalKeys();
    initTvNav();
    bindTvBack();
  }

  if (!location.hash) location.hash = '#/';
  render();

  bindScroll();
}

/**
 * A TV remote's Back button isn't a keyboard Escape — there's no key event
 * for the Fire TV app's WebView shell to forward, so the native side calls
 * this directly to ask "is there an overlay you'd like to close first?"
 * before it falls back to page history or exiting. Closing the player,
 * search and N.O.V.A. are all safe to call even when that layer isn't open.
 */
function bindTvBack() {
  window.eclipseTvBack = () => {
    if (document.querySelector('.player')) { closePlayer(); return true; }
    if (isSearchOpen()) { closeSearch(); return true; }
    if (isNovaOpen()) { closeNova(); return true; }
    return false;
  };
}

function Nav() {
  const links = [
    { path: '/', label: 'Home' },
    { path: '/films', label: 'Films' },
    { path: '/series', label: 'Series' },
    { path: '/my-list', label: 'My list' },
  ];

  const linkNodes = links.map((l) =>
    el('a', {
      class: 'nav__link',
      href: `#${l.path}`,
      dataset: { path: l.path },
    }, l.label)
  );

  const menu = el('div', {
    style: {
      position: 'absolute', top: '54px', right: '0', minWidth: '200px',
      background: 'var(--surface-2)', border: '1px solid var(--hairline)',
      borderRadius: 'var(--radius)', padding: '6px', display: 'none',
      boxShadow: 'var(--shadow-pop)', zIndex: '120',
    },
  },
    el('div', { style: { padding: '10px 12px', borderBottom: '1px solid var(--hairline)', marginBottom: '4px' } },
      el('div', { style: { fontSize: '14px', fontWeight: '600' } }, state.user.display_name),
      el('div', { style: { fontSize: '11.5px', color: 'var(--text-faint)' } },
        state.user.is_admin ? 'Administrator' : 'Viewer')),
    menuItem('Settings', () => { menu.style.display = 'none'; navigate('/settings'); }),
    menuItem('Sign out', async () => {
      await api.logout();
      closeNova();
      closePlayer();
      location.hash = '';
      boot();
    })
  );

  const avatar = el('button', {
    class: 'avatar',
    style: { background: state.user.avatar_color },
    'aria-label': 'Your profile',
    onClick: (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    },
  }, initials(state.user.display_name));

  document.addEventListener('click', () => { menu.style.display = 'none'; });

  const nav = el('header', { class: 'nav' },
    el('a', { class: 'brand', href: '#/' },
      el('span', { class: 'brand__mark' }),
      el('span', { class: 'brand__word' }, 'ECLIPSE')),
    el('nav', { class: 'nav__links' }, linkNodes),
    el('div', { class: 'nav__tools' },
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Search', onClick: () => openSearch() }, icon('search')),
      el('button', { class: 'nav__nova', type: 'button', onClick: () => toggleNova() },
        el('span', { class: 'nova-orb' }), 'N.O.V.A.'),
      el('div', { style: { position: 'relative' } }, avatar, menu))
  );

  // Keep the active link in step with the route.
  const sync = () => {
    const path = currentPath();
    for (const node of linkNodes) {
      const p = node.dataset.path;
      node.classList.toggle('is-active', p === path || (p === '/browse' && path === '/browse'));
    }
  };
  window.addEventListener('hashchange', sync);
  sync();

  return nav;
}

function menuItem(label, onClick) {
  return el('button', {
    type: 'button',
    style: {
      display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
      background: 'none', border: 0, borderRadius: '8px', cursor: 'pointer',
      color: 'var(--text-dim)', fontSize: '13.5px',
    },
    onClick,
    onMouseenter: (e) => { e.target.style.background = 'var(--surface-3)'; e.target.style.color = 'var(--text)'; },
    onMouseleave: (e) => { e.target.style.background = 'none'; e.target.style.color = 'var(--text-dim)'; },
  }, label);
}

function bindScroll() {
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.player')) return; // the player owns the keyboard

    // Escape is a universal dismiss, so it has to work while typing — that's
    // precisely when you want to shut the panel you're typing into.
    if (e.key === 'Escape') {
      if (isSearchOpen()) closeSearch();
      else closeNova();
      return;
    }

    // Everything else would collide with typing.
    if (e.target.matches('input, textarea, [contenteditable]')) return;

    if (e.key === '/') {
      e.preventDefault();
      openSearch();
    } else if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) {
      toggleNova();
    }
  });
}

boot();
