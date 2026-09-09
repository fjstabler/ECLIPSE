import { el } from '../ui.js';

/**
 * Subtitle rendering.
 *
 * The browser's own <track> rendering is the obvious choice and it's the
 * wrong one here: ::cue styling is inconsistent across engines, positioning
 * is barely controllable, and there is no way at all to shift timing — so
 * "subtitle delay" and "move the subtitles up above the controls" would both
 * be impossible. Parsing the cues and drawing them into a normal element
 * costs about eighty lines and makes every one of those a plain CSS problem.
 */

/**
 * WebVTT, reduced to what a subtitle track actually uses: a header, optional
 * cue identifiers, timing lines, and text. Everything else in the format
 * (regions, chapters, style blocks) is skipped rather than half-supported.
 */
export function parseVtt(text) {
  const cues = [];
  if (!text) return cues;

  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    // A cue identifier is an optional line before the timings.
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const timing = lines[timingIndex];
    const match = /([\d:.]+)\s*-->\s*([\d:.]+)/.exec(timing);
    if (!match) continue;

    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (start == null || end == null) continue;

    const body = lines.slice(timingIndex + 1).join('\n');
    if (!body) continue;

    // Position settings on the timing line say where the cue belongs — a sign
    // near the top of frame, most often. Only the vertical hint is honoured;
    // it's the one that matters for not covering something.
    const lineSetting = /\bline:(-?[\d.]+)%?/.exec(timing);
    cues.push({
      start,
      end,
      text: body,
      line: lineSetting ? Number(lineSetting[1]) : null,
    });
  }

  return cues.sort((a, b) => a.start - b.start);
}

function parseTimestamp(value) {
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const seconds = Number(parts.pop().replace(',', '.'));
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if ([seconds, minutes, hours].some((n) => !Number.isFinite(n))) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * A subtitle track on screen: the cues, how they look, and how far they're
 * shifted from the audio.
 */
export class SubtitleLayer {
  constructor(container) {
    this.node = el('div', { class: 'subs', 'aria-live': 'polite' });
    container.append(this.node);
    this.cues = [];
    this.delay = 0;
    this.visible = true;
    this.currentKey = null;
    this.style = {
      size: 100, colour: '#ffffff', background: 0.55, position: 88,
    };
  }

  setCues(cues) {
    this.cues = cues || [];
    this.currentKey = null;
    this.node.replaceChildren();
  }

  clear() {
    this.setCues([]);
  }

  setStyle(style = {}) {
    Object.assign(this.style, style);
    const { size, colour, background, position } = this.style;
    this.node.style.setProperty('--sub-size', `${size / 100}`);
    this.node.style.setProperty('--sub-colour', colour);
    this.node.style.setProperty('--sub-bg', `rgba(0, 0, 0, ${background})`);
    this.node.style.setProperty('--sub-position', `${position}%`);
  }

  setDelay(seconds) {
    this.delay = seconds;
    this.currentKey = null;
  }

  setVisible(visible) {
    this.visible = visible;
    this.node.hidden = !visible;
  }

  /**
   * Called on every frame the player ticks. Cheap on purpose: it walks the
   * cue list, and only touches the DOM when the visible text actually
   * changes — a subtitle that stays on screen for four seconds should not
   * cause 240 re-renders on a Fire TV stick.
   */
  render(currentTime) {
    if (!this.visible || !this.cues.length) return;
    const t = currentTime - this.delay;

    const active = [];
    for (const cue of this.cues) {
      if (cue.start > t) break;
      if (cue.end > t) active.push(cue);
    }

    const key = active.map((c) => `${c.start}:${c.text}`).join('|');
    if (key === this.currentKey) return;
    this.currentKey = key;

    this.node.replaceChildren();
    for (const cue of active) {
      const line = el('div', { class: 'subs__cue' });
      // A cue positioned in the top half of the frame is a sign or a caption
      // over the picture, not dialogue — it belongs where it was put.
      if (cue.line != null && cue.line < 50) line.classList.add('subs__cue--top');
      line.append(...renderCueText(cue.text));
      this.node.append(line);
    }
  }

  destroy() {
    this.node.remove();
  }
}

/**
 * Cue text with its inline markup. Only the tags subtitles genuinely use are
 * honoured, and the text itself is added as text nodes rather than HTML —
 * subtitle files come from wherever the media did, and are not trusted.
 */
function renderCueText(text) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    if (out.length) out.push(el('br', {}));
    const pattern = /<(\/?)([biu])>|<[^>]*>/g;
    const stack = [];
    let cursor = 0;
    let match;

    const append = (node) => {
      if (stack.length) stack[stack.length - 1].append(node);
      else out.push(node);
    };

    while ((match = pattern.exec(rawLine)) !== null) {
      const before = rawLine.slice(cursor, match.index);
      if (before) append(document.createTextNode(before));
      cursor = match.index + match[0].length;

      const [, closing, tag] = match;
      if (!tag) continue; // an unsupported tag — dropped, its text kept
      if (closing) {
        const done = stack.pop();
        if (done && stack.length) stack[stack.length - 1].append(done);
        else if (done) out.push(done);
      } else {
        stack.push(el(tag, {}));
      }
    }

    const rest = rawLine.slice(cursor);
    if (rest) append(document.createTextNode(rest));
    // An unclosed tag still has to reach the screen.
    while (stack.length) {
      const done = stack.pop();
      if (stack.length) stack[stack.length - 1].append(done);
      else out.push(done);
    }
  }
  return out;
}
