import { el, icon, clear, formatTime, toast } from '../ui.js';
import { api } from '../api.js';
import { focusFirstIn } from '../tvnav.js';

// Set once, synchronously, before this module (or any other) ever runs —
// see index.html. A real Fire TV remote has no keyboard and no mouse, so in
// tv-mode the player defers its own arrow-key handling to tvnav.js for
// button-row navigation instead (see the TV_MODE checks in bindKeys()).
const TV_MODE = document.documentElement.classList.contains('tv-mode');

/**
 * The playback surface.
 *
 * Two paths: direct play (a plain <video src> with HTTP range seeking, used
 * whenever the browser can open the container) and a remuxed fallback for
 * everything else. The remux is a piped fragmented mp4, so it can't be
 * byte-seeked — seeking restarts the pipe at an offset instead, which the
 * player hides by tracking the offset itself.
 */

let active = null;

export function openPlayer(fileId, startAt = 0) {
  if (active) closePlayer();
  active = new Player(fileId, startAt);
  return active;
}

export function closePlayer() {
  if (active) {
    active.destroy();
    active = null;
  }
}

class Player {
  constructor(fileId, startAt) {
    this.fileId = fileId;
    this.startAt = startAt;
    this.mode = 'direct';
    this.transcodeOffset = 0;
    this.audioTrackIndex = null; // null = server/browser default
    this.watchedSeconds = 0;
    this.lastTick = 0;
    this.destroyed = false;

    this.root = el('div', { class: 'player' });
    document.body.append(this.root);
    document.body.classList.add('is-locked');

    this.video = el('video', {
      autoplay: true,
      playsinline: true,
      preload: 'metadata',
    });

    this.root.append(this.video, el('div', { class: 'player__loading' }));

    this.bindKeys();
    this.load();
  }

  async load() {
    try {
      this.ctx = await api.playbackContext(this.fileId);
    } catch (err) {
      this.showError('Could not load this title.', err.message);
      return;
    }

    if (this.startAt === 0 && this.ctx.position > 30) this.startAt = this.ctx.position;

    this.mode = this.ctx.file.directPlay ? 'direct' : 'transcode';
    this.buildUI();
    this.attachSource(this.startAt);
    this.bindVideo();
  }

  attachSource(position) {
    if (this.mode === 'direct') {
      this.transcodeOffset = 0;
      this.video.src = `/api/stream/direct/${this.fileId}`;
      this.video.currentTime = 0;
      // Seeking before metadata arrives is ignored, so wait for it.
      if (position > 0) {
        this.video.addEventListener(
          'loadedmetadata',
          () => { this.video.currentTime = position; },
          { once: true }
        );
      }
    } else {
      // The remux starts at the requested offset, so the element's own clock
      // begins at zero and we add the offset back when displaying time.
      this.transcodeOffset = position;
      const audio = this.audioTrackIndex != null ? `&audio=${this.audioTrackIndex}` : '';
      this.video.src = `/api/stream/transcode/${this.fileId}?t=${Math.floor(position)}${audio}`;
    }
    this.video.load();
    const p = this.video.play();
    if (p) p.catch(() => { /* autoplay blocked; the user can press play */ });
  }

  get currentTime() {
    return this.transcodeOffset + (this.video.currentTime || 0);
  }

  get duration() {
    // A piped remux reports Infinity, so fall back to the probed duration.
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0 && this.mode === 'direct') return d;
    return this.ctx?.file?.duration || (Number.isFinite(d) ? d : 0);
  }

  buildUI() {
    const { title, episode, next } = this.ctx;

    this.playBtn = el('button', { class: 'pbtn pbtn--big', type: 'button', 'aria-label': 'Play', onClick: () => this.toggle() }, icon('play'));
    this.timeLabel = el('span', { class: 'player__time' }, '0:00 / 0:00');
    this.played = el('div', { class: 'player__played', style: { width: '0%' } });
    this.buffer = el('div', { class: 'player__buffer', style: { width: '0%' } });
    this.knob = el('div', { class: 'player__knob', style: { left: '0%' } });

    this.scrub = el(
      'div',
      { class: 'player__scrub', onClick: (e) => this.seekFromEvent(e), onMousemove: (e) => this.hoverScrub(e) },
      el('div', { class: 'player__track' }, this.buffer, this.played, this.knob)
    );

    this.volumeInput = el('input', {
      type: 'range', min: '0', max: '1', step: '0.02', value: '1',
      'aria-label': 'Volume',
      onInput: (e) => { this.video.volume = Number(e.target.value); this.video.muted = Number(e.target.value) === 0; },
    });

    this.muteBtn = el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Mute', onClick: () => this.toggleMute() }, icon('volume'));
    this.fsBtn = el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Fullscreen', onClick: () => this.toggleFullscreen() }, icon('fullscreen'));

    const subs = this.ctx.subtitles || [];
    this.subBtn = subs.length
      ? el('button', { class: 'pbtn', type: 'button', title: 'Subtitles', onClick: (e) => this.toggleSubtitleMenu(e.currentTarget) },
          el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 14h4M13 14h4" stroke-linecap="round"/></svg>' }))
      : null;

    // ffprobe already knows every audio track a file has, direct-play or
    // not, so this doesn't need to wait on anything the way subtitles used
    // to wait on the browser's own track list.
    this.audioBtn = el(
      'button',
      { class: 'pbtn', type: 'button', title: 'Audio language', hidden: (this.ctx.audioTracks || []).length < 2, onClick: (e) => this.toggleAudioMenu(e.currentTarget) },
      icon('language')
    );

    this.ui = el(
      'div',
      { class: 'player__ui' },
      el(
        'div',
        { class: 'player__top' },
        el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Close', onClick: () => closePlayer() }, icon('close')),
        el(
          'div',
          { class: 'player__meta' },
          el('h1', { class: 'player__title' }, title.title),
          episode
            ? el('p', { class: 'player__sub' }, `S${episode.season} E${episode.number} · ${episode.name || ''}`)
            : this.mode === 'transcode'
              ? el('p', { class: 'player__sub' }, 'Converting for your browser')
              : null
        )
      ),
      el(
        'div',
        { class: 'player__bottom' },
        this.scrub,
        el(
          'div',
          { class: 'player__controls' },
          this.playBtn,
          el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Back 10 seconds', onClick: () => this.skip(-10) }, icon('back10')),
          el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Forward 10 seconds', onClick: () => this.skip(10) }, icon('fwd10')),
          this.timeLabel,
          el('div', { class: 'player__spacer' }),
          this.audioBtn,
          this.subBtn,
          el('div', { class: 'player__volume' }, this.muteBtn, this.volumeInput),
          this.fsBtn
        )
      )
    );

    clear(this.root);
    this.root.append(this.video, this.ui);

    // Attach sidecar subtitle tracks.
    for (const [i, s] of subs.entries()) {
      const track = el('track', {
        kind: 'subtitles',
        label: s.label || s.language,
        srclang: s.language || 'und',
        src: `/api/stream/subtitles/${s.id}`,
      });
      if (i === 0) track.default = true;
      this.video.append(track);
    }

    this.bindIdle();
    if (next) this.nextEpisode = next;
  }

  bindVideo() {
    const v = this.video;

    v.addEventListener('play', () => { this.playBtn.innerHTML = ''; this.playBtn.append(icon('pause')); this.playBtn.setAttribute('aria-label', 'Pause'); });
    v.addEventListener('pause', () => { this.playBtn.innerHTML = ''; this.playBtn.append(icon('play')); this.playBtn.setAttribute('aria-label', 'Play'); });
    v.addEventListener('timeupdate', () => this.tick());
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => this.root.classList.add('is-buffering'));
    v.addEventListener('playing', () => this.root.classList.remove('is-buffering'));
    v.addEventListener('ended', () => this.onEnded());

    v.addEventListener('error', () => {
      // The single most common failure on a home server: an .mkv the browser
      // refuses. Fall back to the remux rather than showing a dead player.
      if (this.mode === 'direct') {
        toast('Converting this file for your browser…');
        this.mode = 'transcode';
        this.attachSource(this.currentTime || this.startAt);
        return;
      }
      this.showError(
        'This file could not be played.',
        'Your browser cannot open this format and on-the-fly conversion is unavailable. Install ffmpeg on the server, or convert the file to MP4/H.264.'
      );
    });
  }

  tick() {
    const cur = this.currentTime;
    const dur = this.duration;
    if (dur > 0) {
      const pct = Math.min(100, (cur / dur) * 100);
      this.played.style.width = `${pct}%`;
      this.knob.style.left = `${pct}%`;
    }
    this.timeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;

    // Report progress every 5 seconds rather than 4 times a second.
    const now = Date.now();
    if (now - this.lastTick > 5000) {
      this.watchedSeconds += (now - (this.lastTick || now)) / 1000;
      this.lastTick = now;
      this.reportProgress();
    }

    // Offer the next episode in the last 40 seconds.
    if (this.nextEpisode && dur > 0 && dur - cur < 40 && !this.nextCard) this.showNextCard();
  }

  updateBuffer() {
    const dur = this.duration;
    if (!dur || !this.video.buffered.length) return;
    const end = this.video.buffered.end(this.video.buffered.length - 1) + this.transcodeOffset;
    this.buffer.style.width = `${Math.min(100, (end / dur) * 100)}%`;
  }

  seekFromEvent(e) {
    const rect = this.scrub.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.seekTo(ratio * this.duration);
  }

  hoverScrub(e) {
    if (e.buttons !== 1) return;
    this.seekFromEvent(e);
  }

  seekTo(seconds) {
    const target = Math.max(0, Math.min(seconds, this.duration || seconds));
    if (this.mode === 'direct') {
      this.video.currentTime = target;
    } else {
      // Restart the pipe at the new offset — there's nothing to seek within.
      this.attachSource(target);
    }
  }

  skip(delta) {
    this.seekTo(this.currentTime + delta);
  }

  toggle() {
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this.muteBtn.innerHTML = '';
    this.muteBtn.append(icon(this.video.muted ? 'muted' : 'volume'));
    this.muteBtn.setAttribute('aria-label', this.video.muted ? 'Unmute' : 'Mute');
    this.volumeInput.value = this.video.muted ? 0 : this.video.volume;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.root.requestFullscreen();
      this.fsBtn.innerHTML = '';
      this.fsBtn.append(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'));
      this.fsBtn.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
    } catch {
      toast('Fullscreen was blocked by the browser');
    }
  }

  toggleSubtitleMenu(anchor) {
    const tracks = [...this.video.textTracks];
    if (!tracks.length) return;
    const current = tracks.findIndex((t) => t.mode === 'showing') + 1; // 0 = Off
    const labels = ['Off', ...tracks.map((t) => t.label)];
    this.openTrackMenu('subtitle', anchor, labels, current, (i) => {
      for (const t of tracks) t.mode = 'disabled';
      if (i === 0) { toast('Subtitles off'); return; }
      tracks[i - 1].mode = 'showing';
      toast(`Subtitles: ${tracks[i - 1].label}`);
    });
  }

  /**
   * The browser's own AudioTrack API (used here in an earlier version) only
   * reliably works for adaptive streaming, not a plain progressive <video
   * src>— toggling .enabled on a direct-play file's tracks routinely does
   * nothing in Chromium, which is exactly the "the button doesn't actually
   * change anything" bug report this replaced. Every track switch now goes
   * through the server: attachSource restarts the stream as a remux with
   * the chosen track mapped in, the same mechanism seeking already uses,
   * even for a file that would otherwise have played directly.
   */
  toggleAudioMenu(anchor) {
    const tracks = this.ctx.audioTracks || [];
    if (tracks.length < 2) return;
    const current = this.audioTrackIndex != null
      ? tracks.findIndex((t) => t.trackIndex === this.audioTrackIndex)
      : Math.max(0, tracks.findIndex((t) => t.isDefault));
    this.openTrackMenu('audio', anchor, tracks.map((t) => t.label), current, (i) => {
      const next = tracks[i];
      this.audioTrackIndex = next.trackIndex;
      this.mode = 'transcode';
      toast(`Audio: ${next.label}`);
      this.attachSource(this.currentTime);
    });
  }

  /** A small floating list above whichever button opened it — Jellyfin-style
   * track picker rather than a blind cycle-and-hope-you-notice button. */
  openTrackMenu(key, anchor, labels, currentIndex, onSelect) {
    if (this.menuFor === key) { this.closeTrackMenu(); return; }
    this.closeTrackMenu();
    this.menuFor = key;

    const menu = el(
      'div',
      { class: 'player__menu' },
      labels.map((label, i) =>
        el('button', {
          class: `player__menu-item${i === currentIndex ? ' is-active' : ''}`, type: 'button',
          onClick: () => { this.closeTrackMenu(); onSelect(i); },
        }, label)
      )
    );

    const rect = anchor.getBoundingClientRect();
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 260))}px`;

    document.body.append(menu);
    this.trackMenu = menu;
    // On a remote there's no hover/first-arrow-press to reveal where the
    // cursor is — land it on the current track immediately so the menu
    // reads as already-focused, not blank until the first D-pad press.
    if (TV_MODE) focusFirstIn(menu);

    // The click that opened this menu is still bubbling; listening for the
    // next one would close it immediately.
    setTimeout(() => {
      this.menuOutsideHandler = (e) => { if (!menu.contains(e.target)) this.closeTrackMenu(); };
      document.addEventListener('click', this.menuOutsideHandler);
    }, 0);
    this.menuKeyHandler = (e) => { if (e.key === 'Escape') this.closeTrackMenu(); };
    document.addEventListener('keydown', this.menuKeyHandler);
  }

  closeTrackMenu() {
    if (!this.trackMenu) return;
    this.trackMenu.remove();
    this.trackMenu = null;
    this.menuFor = null;
    if (this.menuOutsideHandler) { document.removeEventListener('click', this.menuOutsideHandler); this.menuOutsideHandler = null; }
    if (this.menuKeyHandler) { document.removeEventListener('keydown', this.menuKeyHandler); this.menuKeyHandler = null; }
  }

  showNextCard() {
    const n = this.nextEpisode;
    this.nextCard = el(
      'div',
      { class: 'player__next' },
      el(
        'div',
        {},
        el('p', { style: { margin: '0 0 4px', fontSize: '11px', letterSpacing: '0.1em', color: 'var(--text-faint)' } }, 'UP NEXT'),
        el('p', { style: { margin: 0, fontSize: '14px', fontWeight: '600' } }, `S${n.season} E${n.episode} · ${n.name || ''}`)
      ),
      el('button', { class: 'btn btn--play btn--sm', type: 'button', onClick: () => this.playNext() }, icon('play'), 'Play')
    );
    this.ui.append(this.nextCard);
  }

  playNext() {
    const n = this.nextEpisode;
    if (!n) return;
    const fileId = n.fileId;
    closePlayer();
    openPlayer(fileId, 0);
  }

  onEnded() {
    this.reportProgress(true);
    if (this.nextEpisode) this.playNext();
    else closePlayer();
  }

  async reportProgress(completed = false) {
    if (this.destroyed) return;
    try {
      await api.progress({
        fileId: this.fileId,
        position: completed ? this.duration : this.currentTime,
        duration: this.duration,
      });
    } catch { /* the viewer doesn't need to know about a dropped ping */ }
  }

  bindIdle() {
    const reset = () => {
      this.root.classList.remove('is-idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.video.paused) this.root.classList.add('is-idle');
      }, 3000);
    };
    // Exposed so bindKeys() can un-hide the OSD on a D-pad press too — a
    // remote has no mousemove to fall back on, and without this a press
    // while idle would silently act on controls the viewer can't see.
    this.resetIdle = reset;
    this.root.addEventListener('mousemove', reset);
    this.root.addEventListener('touchstart', reset, { passive: true });
    this.video.addEventListener('click', () => this.toggle());
    reset();
  }

  /** Whether a D-pad cursor currently sits on one of the player's own
   * buttons — once it does, Left/Right hand off to tvnav for moving
   * between them instead of seeking directly. */
  controlsActive() {
    return !!this.ui?.querySelector('.tv-cursor');
  }

  bindKeys() {
    this.keyHandler = (e) => {
      // A track menu owns the keyboard while it's open — tvnav.js takes
      // over arrow/Enter navigation of its items (see the scoping in
      // tvnav.js), and its own Escape handler closes just the menu.
      if (this.trackMenu) return;
      if (e.target.matches('input, textarea')) return;

      // Any key press reveals a hidden OSD — a remote has no mousemove to
      // fall back on, and without this a D-pad press while idle would act
      // on controls the viewer can't see.
      this.resetIdle?.();

      // A real Fire TV remote has no keyboard shortcut letters and no
      // mouse — the only way it can reach the audio/subtitle/fullscreen/
      // mute/close buttons is by D-pad-navigating tvnav's own cursor onto
      // them (see tvnav.js's ambient .player__ui scoping). Up/Down always
      // hand off there in tv-mode; Left/Right only once a control is
      // already focused — until then they stay a direct seek, exactly
      // like the desktop keyboard shortcut.
      const handingOffToTvnav = TV_MODE && (
        e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ') && this.controlsActive())
      );
      if (handingOffToTvnav) return;

      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); this.toggle(); break;
        case 'ArrowLeft': case 'j': e.preventDefault(); this.skip(-10); break;
        case 'ArrowRight': case 'l': e.preventDefault(); this.skip(10); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); break;
        case 'f': this.toggleFullscreen(); break;
        case 'm': this.toggleMute(); break;
        case 'c': if (this.subBtn) this.toggleSubtitleMenu(this.subBtn); break;
        case 'a': if (this.audioBtn) this.toggleAudioMenu(this.audioBtn); break;
        case 'Escape': if (!document.fullscreenElement) closePlayer(); break;
        default: break;
      }
    };
    document.addEventListener('keydown', this.keyHandler);
  }

  showError(headline, detail) {
    clear(this.root);
    this.root.append(
      el(
        'div',
        { class: 'player__error' },
        el('h2', { style: { fontSize: '20px', margin: 0 } }, headline),
        el('p', { style: { color: 'var(--text-faint)', maxWidth: '440px', lineHeight: '1.6', margin: 0 } }, detail || ''),
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => closePlayer() }, 'Close')
      )
    );
  }

  destroy() {
    this.destroyed = true;
    this.reportProgress();
    api
      .stopped({ fileId: this.fileId, secondsWatched: this.watchedSeconds, completed: false })
      .catch(() => {});
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.idleTimer);
    this.closeTrackMenu();
    // Detach the source so the browser stops pulling bytes immediately.
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    document.body.classList.remove('is-locked');
  }
}

/** For the Fire TV back-button bridge — close just an open track menu
 * before it falls through to closing the whole player. */
export function closeActiveTrackMenu() {
  if (active?.trackMenu) { active.closeTrackMenu(); return true; }
  return false;
}
