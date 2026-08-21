import { el, icon, clear, formatTime, toast } from '../ui.js';
import { api } from '../api.js';

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

    this.playBtn = el('button', { class: 'pbtn pbtn--big', type: 'button', onClick: () => this.toggle() }, icon('play'));
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

    this.muteBtn = el('button', { class: 'pbtn', type: 'button', onClick: () => this.toggleMute() }, icon('volume'));
    this.fsBtn = el('button', { class: 'pbtn', type: 'button', onClick: () => this.toggleFullscreen() }, icon('fullscreen'));

    const subs = this.ctx.subtitles || [];
    const subBtn = subs.length
      ? el('button', { class: 'pbtn', type: 'button', title: 'Subtitles', onClick: () => this.cycleSubtitles() },
          el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 14h4M13 14h4" stroke-linecap="round"/></svg>' }))
      : null;

    // Hidden until we actually know there's more than one track — for a
    // remux that's immediate (ffprobe already knows); for direct play it
    // depends on what the browser itself finds once the file loads.
    this.audioBtn = el(
      'button',
      { class: 'pbtn', type: 'button', title: 'Audio language', hidden: true, onClick: () => this.cycleAudioTrack() },
      icon('language')
    );
    if (this.mode === 'transcode') this.audioBtn.hidden = (this.ctx.audioTracks || []).length < 2;

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
          subBtn,
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

    v.addEventListener('loadedmetadata', () => {
      // Direct play never touches the server for this — the browser's own
      // demuxer either exposes multiple tracks or it doesn't, and that's
      // only known once the file has actually loaded.
      if (this.mode === 'direct') this.audioBtn.hidden = (v.audioTracks?.length || 0) < 2;
    });
    v.addEventListener('play', () => { this.playBtn.innerHTML = ''; this.playBtn.append(icon('pause')); });
    v.addEventListener('pause', () => { this.playBtn.innerHTML = ''; this.playBtn.append(icon('play')); });
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
    this.volumeInput.value = this.video.muted ? 0 : this.video.volume;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.root.requestFullscreen();
      this.fsBtn.innerHTML = '';
      this.fsBtn.append(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'));
    } catch {
      toast('Fullscreen was blocked by the browser');
    }
  }

  cycleSubtitles() {
    const tracks = [...this.video.textTracks];
    if (!tracks.length) return;
    const activeIndex = tracks.findIndex((t) => t.mode === 'showing');
    for (const t of tracks) t.mode = 'disabled';
    const nextIndex = activeIndex + 1;
    if (nextIndex < tracks.length) {
      tracks[nextIndex].mode = 'showing';
      toast(`Subtitles: ${tracks[nextIndex].label}`);
    } else {
      toast('Subtitles off');
    }
  }

  /**
   * Direct play switches instantly, through the browser's own AudioTrack
   * list (Chromium-based browsers; not universally supported, hence the
   * length check rather than assuming it exists). A remux has no such API —
   * the choice has to be baked into the stream itself, so it restarts the
   * pipe at the current position with a different track mapped in, the same
   * way seeking already does.
   */
  cycleAudioTrack() {
    if (this.mode === 'direct') {
      const tracks = this.video.audioTracks;
      if (!tracks || tracks.length < 2) return;
      const arr = Array.from(tracks);
      const activeIndex = Math.max(0, arr.findIndex((t) => t.enabled));
      const nextIndex = (activeIndex + 1) % arr.length;
      arr.forEach((t, i) => { t.enabled = i === nextIndex; });
      const t = arr[nextIndex];
      toast(`Audio: ${t.label || t.language || `Track ${nextIndex + 1}`}`);
      return;
    }

    const tracks = this.ctx.audioTracks || [];
    if (tracks.length < 2) return;
    const currentIndex = Math.max(0, tracks.findIndex((t) => t.trackIndex === this.audioTrackIndex));
    const next = tracks[(currentIndex + 1) % tracks.length];
    this.audioTrackIndex = next.trackIndex;
    toast(`Audio: ${next.label}`);
    this.attachSource(this.currentTime);
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
    this.root.addEventListener('mousemove', reset);
    this.root.addEventListener('touchstart', reset, { passive: true });
    this.video.addEventListener('click', () => this.toggle());
    reset();
  }

  bindKeys() {
    this.keyHandler = (e) => {
      if (e.target.matches('input, textarea')) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); this.toggle(); break;
        case 'ArrowLeft': case 'j': e.preventDefault(); this.skip(-10); break;
        case 'ArrowRight': case 'l': e.preventDefault(); this.skip(10); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); break;
        case 'f': this.toggleFullscreen(); break;
        case 'm': this.toggleMute(); break;
        case 'c': this.cycleSubtitles(); break;
        case 'a': this.cycleAudioTrack(); break;
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
    // Detach the source so the browser stops pulling bytes immediately.
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    document.body.classList.remove('is-locked');
  }
}
