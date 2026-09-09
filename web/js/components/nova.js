import { el, icon, clear, miniMarkdown } from '../ui.js';
import { isOffline } from './states.js';
import { api, novaChat } from '../api.js';
import { Card } from './card.js';

/**
 * N.O.V.A.'s chat panel. Slides in from the right and streams replies token by
 * token, showing which tool it is using while it thinks.
 */

let panel = null;
let scrim = null;
let logNode = null;
let inputNode = null;
let sendBtn = null;
let busy = false;
let loaded = false;

const STARTERS = [
  'What should I watch tonight?',
  "Something short and funny — I've got 90 minutes",
  'Find me a series to start this weekend',
  "I loved the last thing I watched. What's next?",
];

export function initNova() {
  if (panel) return;

  scrim = el('div', { class: 'scrim', onClick: () => closeNova() });

  logNode = el('div', { class: 'nova__log' });

  inputNode = el('textarea', {
    class: 'nova__input',
    rows: '1',
    placeholder: 'Ask N.O.V.A. what to watch…',
    // Without this, Android's on-screen keyboard has no way to know this
    // single field isn't part of a multi-step form — it defaults to a
    // "Next" action that just tries to tab to another field (there isn't
    // one, so it does nothing and the keyboard stays open) instead of
    // submitting. "send" gets the right label and makes it actually
    // dispatch the Enter the onKeydown handler below is listening for.
    enterkeyhint: 'send',
    onInput: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
      sendBtn.disabled = busy || !e.target.value.trim();
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
  });

  sendBtn = el('button', { class: 'nova__send', type: 'button', disabled: true, 'aria-label': 'Send', onClick: () => send() }, icon('send'));

  panel = el(
    'aside',
    { class: 'nova', 'aria-label': 'N.O.V.A.' },
    el(
      'div',
      { class: 'nova__head' },
      el('span', { class: 'nova-orb' }),
      el(
        'div',
        { class: 'nova__title' },
        el('p', { class: 'nova__name' }, 'N.O.V.A.'),
        el('p', { class: 'nova__sub' }, 'Your curator')
      ),
      el('button', {
        class: 'iconbtn', type: 'button', 'aria-label': 'Clear conversation', title: 'Clear conversation',
        onClick: async () => { await api.novaClear(); renderEmpty(); },
      }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>' })),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onClick: () => closeNova() }, icon('close'))
    ),
    logNode,
    el('div', { class: 'nova__compose' }, inputNode, sendBtn)
  );

  document.body.append(scrim, panel);
  renderEmpty();
}

export async function openNova(seed) {
  initNova();
  panel.classList.add('is-open');
  scrim.classList.add('is-open');

  if (!loaded) {
    loaded = true;
    try {
      const { messages } = await api.novaConversation();
      if (messages.length) {
        clear(logNode);
        for (const m of messages) {
          appendMessage(m.role === 'user' ? 'user' : 'nova', m.content, m.refs);
        }
        scrollToEnd();
      }
    } catch { /* keep the empty state */ }
  }

  if (seed) {
    inputNode.value = seed;
    sendBtn.disabled = false;
    send();
  } else {
    setTimeout(() => inputNode.focus(), 380);
  }
}

export function closeNova() {
  if (!panel) return;
  panel.classList.remove('is-open');
  scrim.classList.remove('is-open');
}

export function toggleNova() {
  if (panel?.classList.contains('is-open')) closeNova();
  else openNova();
}

export function isNovaOpen() {
  return Boolean(panel?.classList.contains('is-open'));
}

function renderEmpty() {
  clear(logNode);
  logNode.append(
    el(
      'div',
      { class: 'nova__empty' },
      el('div', { class: 'nova__orb-lg' }),
      el('h3', {}, 'What are you in the mood for?'),
      el('p', {}, 'I know everything on this server and what you have been watching. Tell me the mood, the time you have, or just ask.'),
      el(
        'div',
        { class: 'nova__starters' },
        STARTERS.map((s) =>
          el('button', { class: 'nova__starter', type: 'button', onClick: () => { inputNode.value = s; send(); } }, s)
        )
      )
    )
  );
}

function appendMessage(role, content, refs = []) {
  const bubble = el('div', { class: 'msg__bubble', html: miniMarkdown(content) });
  const msg = el('div', { class: `msg msg--${role}` }, bubble);

  if (refs?.length) {
    const cards = el('div', { class: 'msg__cards' }, refs.map((t) => Card(t)));
    msg.append(cards);
  }
  logNode.append(msg);
  return { msg, bubble };
}

function scrollToEnd() {
  logNode.scrollTop = logNode.scrollHeight;
}

async function send() {
  const text = inputNode.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  inputNode.value = '';
  inputNode.style.height = 'auto';

  // First message replaces the empty state.
  if (logNode.querySelector('.nova__empty')) clear(logNode);

  appendMessage('user', text);
  scrollToEnd();

  const { msg, bubble } = appendMessage('nova', '');
  const toolLine = el('div', { class: 'msg__tool' }, 'Thinking…');
  msg.insertBefore(toolLine, bubble);
  scrollToEnd();

  let buffer = '';
  // A reply streams in dozens of small chunks a second. Re-parsing the
  // whole buffer as markdown and rebuilding the bubble's DOM on every
  // single one of them — plus forcing a layout via scrollHeight each
  // time — is cheap enough to hide on a desktop CPU but adds up to real,
  // visible stutter on a Fire TV Stick's much weaker one, especially
  // once the reply gets long (each pass re-parses the whole thing, so
  // the total cost grows with the square of the reply length). Coalescing
  // into one paint per animation frame keeps what's on screen just as
  // current — nothing streams faster than the display can show it anyway
  // — while cutting the actual work to a fraction of the per-token rate.
  let renderRaf = null;
  const render = () => {
    renderRaf = null;
    bubble.innerHTML = miniMarkdown(buffer);
    scrollToEnd();
  };
  const scheduleRender = () => { if (!renderRaf) renderRaf = requestAnimationFrame(render); };
  const cancelRender = () => { if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = null; } };

  try {
    await novaChat(text, (event) => {
      switch (event.type) {
        case 'text':
          buffer += event.text;
          toolLine.remove();
          scheduleRender();
          break;
        case 'tool':
          toolLine.textContent = event.label || 'Working…';
          scrollToEnd();
          break;
        case 'refs':
          if (event.titles?.length) {
            msg.append(el('div', { class: 'msg__cards' }, event.titles.map((t) => Card(t))));
            scrollToEnd();
          }
          break;
        case 'error':
          cancelRender();
          toolLine.remove();
          bubble.innerHTML = miniMarkdown(event.message);
          bubble.style.borderColor = 'rgba(255,90,104,0.35)';
          break;
        case 'done':
          cancelRender();
          toolLine.remove();
          bubble.innerHTML = miniMarkdown(buffer || event.content || '');
          scrollToEnd();
          break;
        default:
          break;
      }
    });
  } catch (err) {
    cancelRender();
    toolLine.remove();
    // "Failed to fetch" tells a viewer nothing they can act on.
    bubble.textContent = isOffline(err)
      ? 'N.O.V.A. could not reach the server. Check it is running and this device is on the same network.'
      : `N.O.V.A. could not reply: ${err.message}`;
  } finally {
    cancelRender();
    toolLine.remove();
    busy = false;
    sendBtn.disabled = !inputNode.value.trim();
    // Deliberately not refocusing the input here. On a TV, the field is
    // behind an on-screen keyboard overlay — re-focusing it immediately
    // after sending re-triggers that keyboard, which is why it looked
    // like it "wouldn't close until I pressed back": this line was
    // pulling it right back open every time. A desktop user can just
    // click back in if they want to keep typing.
    scrollToEnd();
  }
}
