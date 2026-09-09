import { el, icon, clear, formatTime, formatBytes, toast } from '../ui.js';
import { api } from '../api.js';
import { focusFirstIn, focusElement } from '../tvnav.js';
import { parseVtt, SubtitleLayer } from './subtitles.js';

// Set once, synchronously, before this module (or any other) ever runs —
// see index.html. A real Fire TV remote has no keyboard and no mouse, so in
// tv-mode the player defers its own arrow-key handling to tvnav.js for
// button-row navigation instead (see the TV_MODE checks in bindKeys()).
const TV_MODE = document.documentElement.classList.contains('tv-mode');

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * The playback surface.
 *
 * Three paths, and the server decides which: direct play (a plain <video src>
 * with HTTP range seeking), a remux for containers the browser can't open,
 * and a real re-encode when a codec is genuinely out of reach. The remux and
 * the encode are both piped fragmented mp4, so they can't be byte-seeked —
 * seeking restarts the pipe at an offset, which the player hides by tracking
 * that offset itself.
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
    this.audioTrackIndex = null;   // null = whatever the file defaults to
    this.subtitleTrackId = null;   // null = off
    this.burnSubtitle = null;      // set only for picture-based tracks
    this.subtitleDelay = 0;
    this.speed = 1;
    this.watchedSeconds = 0;
    this.lastTick = 0;
    this.dismissedMarkers = new Set();
    this.destroyed = false;

    // Where the cursor was when the player opened, so closing can put it back
    // on the thing that was pressed rather than at the top of the page.
    this.openedFrom = TV_MODE ? document.querySelector('.tv-cursor') : null;

    this.root = el('div', { class: 'player' });
    document.body.append(this.root);
    document.body.classList.add('is-locked');

    this.video = el('video', { autoplay: true, playsinline: true, preload: 'metadata' });
    this.subtitleLayer = new SubtitleLayer(this.root);

    this.root.append(this.video, el('div', { class: 'player__loading' }));

    this.bindKeys();
    this.load();
  }

  async load() {
    try {
      this.ctx = await api.playbackContext(this.fileId);
    } catch (err) {
      // Distinguishing "the server is unreachable" from "this file is gone"
      // is the difference between waiting and going to look for it.
      const offline = !navigator.onLine || /failed to fetch|networkerror/i.test(err.message || '');
      this.showError(
        offline ? 'Cannot reach the server' : 'This title could not be opened',
        offline
          ? 'ECLIPSE is not responding. Check the server is running and this device is on the same network.'
          : err.message,
        { retry: true }
      );
      return;
    }

    this.prefs = this.ctx.preferences || {};
    this.chapters = this.ctx.chapters || [];
    this.markers = this.ctx.markers || [];
    this.speed = this.prefs.playbackSpeed || 1;

    if (this.startAt === 0 && this.ctx.position > 30) this.startAt = this.ctx.position;

    // The server has already worked out which audio track and subtitle this
    // viewer should land on, including the forced-subtitle rule — every
    // client agreeing on that beats each one reimplementing it.
    const defaults = this.ctx.defaults || {};
    if (defaults.audio && !defaults.audio.isDefault) this.audioTrackIndex = defaults.audio.trackIndex;
    this.pendingSubtitle = defaults.subtitle?.id || null;

    this.mode = this.ctx.file.directPlay ? 'direct' : 'transcode';
    this.buildUI();
    this.applySubtitleStyle();
    this.attachSource(this.startAt);
    this.bindVideo();

    if (this.pendingSubtitle) this.selectSubtitle(this.pendingSubtitle, { quiet: true });
  }

  // --- source -----------------------------------------------------------

  attachSource(position) {
    if (this.mode === 'direct') {
      this.transcodeOffset = 0;
      this.video.src = `/api/stream/direct/${this.fileId}`;
      this.video.currentTime = 0;
      // Seeking before metadata arrives is ignored, so wait for it.
      if (position > 0) {
        this.video.addEventListener('loadedmetadata', () => { this.video.currentTime = position; }, { once: true });
      }
    } else {
      // The stream starts at the requested offset, so the element's own clock
      // begins at zero and the offset is added back when displaying time.
      this.transcodeOffset = position;
      const params = new URLSearchParams({ t: String(Math.floor(position)) });
      if (this.audioTrackIndex != null) params.set('audio', String(this.audioTrackIndex));
      if (this.burnSubtitle != null) params.set('burn', String(this.burnSubtitle));
      if (this.forceFullEncode) params.set('mode', 'full');
      if (this.prefs?.maxHeight) params.set('maxHeight', String(this.prefs.maxHeight));
      if (this.prefs?.maxBitrate) params.set('maxBitrate', String(this.prefs.maxBitrate));
      this.video.src = `/api/stream/transcode/${this.fileId}?${params}`;
    }
    this.video.load();
    this.video.playbackRate = this.speed;
    const p = this.video.play();
    if (p) p.catch(() => { /* autoplay blocked; the user can press play */ });
  }

  get currentTime() {
    return this.transcodeOffset + (this.video.currentTime || 0);
  }

  get duration() {
    // A piped stream reports Infinity, so fall back to the probed duration.
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0 && this.mode === 'direct') return d;
    return this.ctx?.file?.duration || (Number.isFinite(d) ? d : 0);
  }

  // --- interface --------------------------------------------------------

  buildUI() {
    const { title, episode, next, previous } = this.ctx;

    this.playBtn = el('button', { class: 'pbtn pbtn--big', type: 'button', 'aria-label': 'Play', onClick: () => this.toggle() }, icon('play'));
    this.timeLabel = el('span', { class: 'player__time' }, '0:00 / 0:00');
    this.played = el('div', { class: 'player__played', style: { width: '0%' } });
    this.buffer = el('div', { class: 'player__buffer', style: { width: '0%' } });
    this.knob = el('div', { class: 'player__knob', style: { left: '0%' } });

    this.scrub = el(
      'div',
      { class: 'player__scrub', onClick: (e) => this.seekFromEvent(e), onMousemove: (e) => this.hoverScrub(e) },
      el('div', { class: 'player__track' }, this.buffer, this.played, this.chapterTicks(), this.knob)
    );

    this.volumeInput = el('input', {
      type: 'range', min: '0', max: '1', step: '0.02', value: '1',
      'aria-label': 'Volume',
      onInput: (e) => { this.video.volume = Number(e.target.value); this.video.muted = Number(e.target.value) === 0; },
    });

    this.muteBtn = el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Mute', onClick: () => this.toggleMute() }, icon('volume'));
    this.fsBtn = el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Fullscreen', onClick: () => this.toggleFullscreen() }, icon('fullscreen'));

    const subs = this.ctx.subtitles || [];
    this.subBtn = el(
      'button',
      {
        class: 'pbtn', type: 'button', title: 'Subtitles', 'aria-label': 'Subtitles',
        hidden: subs.length === 0,
        onClick: (e) => this.openSubtitleMenu(e.currentTarget),
      },
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 14h4M13 14h4" stroke-linecap="round"/></svg>' })
    );

    // ffprobe already knows every audio track a file has, direct-play or not,
    // so this doesn't wait on anything the way subtitles used to wait on the
    // browser's own track list.
    this.audioBtn = el(
      'button',
      { class: 'pbtn', type: 'button', title: 'Audio', 'aria-label': 'Audio track', hidden: (this.ctx.audioTracks || []).length < 2, onClick: (e) => this.openAudioMenu(e.currentTarget) },
      icon('language')
    );

    this.chapterBtn = el(
      'button',
      { class: 'pbtn', type: 'button', title: 'Chapters', 'aria-label': 'Chapters', hidden: this.chapters.length < 2, onClick: (e) => this.openChapterMenu(e.currentTarget) },
      icon('chapters')
    );

    this.settingsBtn = el(
      'button',
      { class: 'pbtn', type: 'button', title: 'Playback settings', 'aria-label': 'Playback settings', onClick: (e) => this.openSettingsMenu(e.currentTarget) },
      icon('settings')
    );

    // Picture-in-picture only exists on some browsers, and never inside the
    // Fire TV WebView — a button that does nothing is worse than no button.
    const pipSupported = document.pictureInPictureEnabled && !TV_MODE;
    this.pipBtn = pipSupported
      ? el('button', { class: 'pbtn', type: 'button', title: 'Picture in picture', 'aria-label': 'Picture in picture', onClick: () => this.togglePip() }, icon('pip'))
      : null;

    this.prevBtn = previous
      ? el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Previous episode', title: 'Previous episode', onClick: () => this.playEpisode(previous) }, icon('prev'))
      : null;
    this.nextBtn = next
      ? el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Next episode', title: 'Next episode', onClick: () => this.playEpisode(next) }, icon('next'))
      : null;

    this.methodLabel = el('p', { class: 'player__sub' }, '');

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
            ? el('p', { class: 'player__sub' }, `S${episode.season} E${episode.number}${episode.name ? ` · ${episode.name}` : ''}`)
            : null,
          this.methodLabel
        )
      ),
      el('div', { class: 'player__skip' }),
      el(
        'div',
        { class: 'player__bottom' },
        this.scrub,
        el(
          'div',
          { class: 'player__controls' },
          this.playBtn,
          this.prevBtn,
          el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Back 10 seconds', onClick: () => this.skip(-10) }, icon('back10')),
          el('button', { class: 'pbtn', type: 'button', 'aria-label': 'Forward 10 seconds', onClick: () => this.skip(10) }, icon('fwd10')),
          this.nextBtn,
          this.timeLabel,
          el('div', { class: 'player__spacer' }),
          this.chapterBtn,
          this.audioBtn,
          this.subBtn,
          this.settingsBtn,
          this.pipBtn,
          el('div', { class: 'player__volume' }, this.muteBtn, this.volumeInput),
          this.fsBtn
        )
      )
    );

    this.skipZone = this.ui.querySelector('.player__skip');

    clear(this.root);
    this.root.append(this.video, this.subtitleLayer.node, this.ui);

    this.bindIdle();
    this.nextEpisode = next;

    // The player covers the page it was opened from, so the cursor has to come
    // with it. Left behind, it sits on a button nobody can see any more:
    // arrow presses walk around a hidden page, the controls in front of the
    // viewer never light up, and there is no way back without the remote's
    // Back button. Bring it to the play button, which is where a viewer
    // reaching for the remote expects to already be.
    if (TV_MODE) focusFirstIn(this.ui.querySelector('.player__controls'));
  }

  /** Chapter boundaries drawn onto the scrub bar, so they can be aimed at. */
  chapterTicks() {
    if (this.chapters.length < 2 || !this.ctx.file.duration) return null;
    const duration = this.ctx.file.duration;
    return el(
      'div',
      { class: 'player__chapters' },
      this.chapters
        .filter((c) => c.start > 0)
        .map((c) => el('span', { class: 'player__chapter-tick', style: { left: `${(c.start / duration) * 100}%` }, title: c.title }))
    );
  }

  applySubtitleStyle() {
    this.subtitleLayer.setStyle({
      size: this.prefs.subtitleSize ?? 100,
      colour: this.prefs.subtitleColour ?? '#ffffff',
      background: this.prefs.subtitleBackground ?? 0.55,
      position: this.prefs.subtitlePosition ?? 88,
    });
  }

  // --- playback ---------------------------------------------------------

  bindVideo() {
    const v = this.video;

    v.addEventListener('play', () => { clear(this.playBtn); this.playBtn.append(icon('pause')); this.playBtn.setAttribute('aria-label', 'Pause'); });
    v.addEventListener('pause', () => { clear(this.playBtn); this.playBtn.append(icon('play')); this.playBtn.setAttribute('aria-label', 'Play'); });
    v.addEventListener('timeupdate', () => this.tick());
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => this.root.classList.add('is-buffering'));
    v.addEventListener('playing', () => {
      this.root.classList.remove('is-buffering');
      this.video.playbackRate = this.speed;
    });
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('error', () => this.onVideoError());

    // The subtitle layer redraws off the video clock rather than a timer, so
    // it stays in step through seeks, pauses and speed changes for free.
    const paint = () => {
      if (this.destroyed) return;
      this.subtitleLayer.render(this.currentTime);
      this.rafId = requestAnimationFrame(paint);
    };
    this.rafId = requestAnimationFrame(paint);
  }

  /**
   * The single most common failure on a home server is an .mkv the browser
   * refuses. Each step here is one rung down the ladder rather than a dead
   * player: direct play falls back to a remux, a remux to a full re-encode,
   * and only then does it admit defeat.
   */
  async onVideoError() {
    if (this.destroyed) return;

    if (this.mode === 'direct') {
      toast('Converting this file for your browser…');
      this.mode = 'transcode';
      this.attachSource(this.currentTime || this.startAt);
      return;
    }

    if (!this.forceFullEncode) {
      this.forceFullEncode = true;
      toast('Re-encoding for this device…');
      this.attachSource(this.currentTime || this.startAt);
      return;
    }

    // Ask the server what it made of this file — a busy transcoder and a
    // codec nothing can play need different words and different buttons.
    let detail = 'This device cannot play this file, and converting it did not work either.';
    let busy = false;
    try {
      const decision = await api.playbackDecision(this.fileId);
      busy = Boolean(decision.busy);
      if (busy) detail = 'The server is already converting as many streams as it can handle. Try again in a moment.';
      else if (decision.reasons?.length) detail = `${detail} ${decision.reasons.join('. ')}.`;
    } catch { /* the fallback wording stands */ }

    this.showError(busy ? 'The server is busy' : 'This file could not be played', detail, { retry: true });
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

    this.updateSkipButton(cur);

    // Report progress every 5 seconds rather than 4 times a second.
    const now = Date.now();
    if (now - this.lastTick > 5000) {
      this.watchedSeconds += (now - (this.lastTick || now)) / 1000;
      this.lastTick = now;
      this.reportProgress();
    }

    // Offer the next episode over the closing minute.
    if (this.nextEpisode && dur > 0 && dur - cur < 40 && !this.nextCard) this.showNextCard();
  }

  /**
   * "Skip intro" only appears while an intro is actually playing, and only
   * when the file said where one is. Nothing here is guessed — see the
   * marker derivation in the scanner.
   */
  updateSkipButton(currentTime) {
    const marker = this.markers.find(
      (m) => currentTime >= m.start && currentTime < m.end - 1 && !this.dismissedMarkers.has(m.kind)
    );

    if (!marker) {
      if (this.skipBtn) { this.removeSkipButton(); }
      return;
    }
    if (this.skipKind === marker.kind) return;

    const mode = marker.kind === 'credits' ? this.prefs.skipCredits : this.prefs.skipIntro;
    if (mode === 'off') return;

    // "auto" skips it once and doesn't ask again for this file.
    if (mode === 'auto') {
      this.dismissedMarkers.add(marker.kind);
      this.seekTo(marker.end);
      return;
    }

    const label = { intro: 'Skip intro', credits: 'Skip credits', recap: 'Skip recap' }[marker.kind];
    if (this.skipBtn) this.removeSkipButton();
    this.skipKind = marker.kind;
    this.skipBtn = el(
      'button',
      {
        class: 'player__skip-btn', type: 'button',
        onClick: () => { this.dismissedMarkers.add(marker.kind); this.seekTo(marker.end); },
      },
      label
    );
    this.skipZone.append(this.skipBtn);
  }

  /**
   * The skip button comes and goes with the section it skips, and on a TV the
   * D-pad cursor may well be sitting on it when it goes. A cursor pointing at
   * a removed element is invisible to controlsActive(), which made the player
   * read the next Left/Right as a seek instead of navigation — the viewer
   * pressed right to reach Subtitles and jumped ten seconds forward instead.
   * Handing the cursor back to the control row first keeps that from
   * happening.
   */
  removeSkipButton() {
    if (!this.skipBtn) return;
    const heldCursor = this.skipBtn.classList.contains('tv-cursor');
    this.skipBtn.remove();
    this.skipBtn = null;
    this.skipKind = null;
    if (heldCursor && TV_MODE && this.playBtn?.isConnected) focusFirstIn(this.playBtn.parentElement);
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
    this.subtitleLayer.currentKey = null;
  }

  skip(delta) {
    this.seekTo(this.currentTime + delta);
  }

  jumpChapter(direction) {
    if (!this.chapters.length) return;
    const now = this.currentTime;
    if (direction < 0) {
      // Matching every player ever made: "previous" within the first few
      // seconds of a chapter means the one before it, otherwise the start of
      // this one.
      const current = [...this.chapters].reverse().find((c) => c.start <= now - 3);
      this.seekTo(current ? current.start : 0);
    } else {
      const next = this.chapters.find((c) => c.start > now + 1);
      if (next) this.seekTo(next.start);
    }
  }

  toggle() {
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    clear(this.muteBtn);
    this.muteBtn.append(icon(this.video.muted ? 'muted' : 'volume'));
    this.muteBtn.setAttribute('aria-label', this.video.muted ? 'Unmute' : 'Mute');
    this.volumeInput.value = this.video.muted ? 0 : this.video.volume;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.root.requestFullscreen();
      clear(this.fsBtn);
      this.fsBtn.append(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'));
      this.fsBtn.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
    } catch {
      toast('Fullscreen was blocked by the browser');
    }
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      toast('Picture in picture is not available for this video');
    }
  }

  setSpeed(speed) {
    this.speed = speed;
    this.video.playbackRate = speed;
    toast(speed === 1 ? 'Normal speed' : `Speed ${speed}×`);
  }

  // --- track selection --------------------------------------------------

  openAudioMenu(anchor) {
    const tracks = this.ctx.audioTracks || [];
    if (tracks.length < 2) return;
    const current = this.audioTrackIndex != null
      ? tracks.findIndex((t) => t.trackIndex === this.audioTrackIndex)
      : Math.max(0, tracks.findIndex((t) => t.isDefault));

    const labels = tracks.map((t) => {
      const extra = [t.channelLabel, t.codec?.toUpperCase()].filter(Boolean).join(' · ');
      return { label: t.label, hint: extra };
    });

    this.openMenu('audio', anchor, labels, current, (i) => {
      const next = tracks[i];
      this.audioTrackIndex = next.trackIndex;
      // Switching track means the server has to remap the stream, which means
      // this stops being a direct play even for a file that could have been.
      this.mode = 'transcode';
      toast(`Audio: ${next.label}`);
      this.attachSource(this.currentTime);
    });
  }

  openSubtitleMenu(anchor) {
    const subs = this.ctx.subtitles || [];
    if (!subs.length) return;

    const currentIndex = this.subtitleTrackId
      ? subs.findIndex((s) => s.id === this.subtitleTrackId) + 1
      : 0;

    const items = [
      { label: 'Off' },
      ...subs.map((s) => ({
        label: s.label,
        hint: [
          s.source === 'external' ? 'File' : null,
          s.isForced ? 'Forced' : null,
          s.isHearingImpaired ? 'SDH' : null,
          s.requiresBurnIn ? 'Burned in' : null,
        ].filter(Boolean).join(' · '),
      })),
    ];

    this.openMenu('subtitle', anchor, items, currentIndex, (i) => {
      if (i === 0) this.selectSubtitle(null);
      else this.selectSubtitle(subs[i - 1].id);
    });
  }

  /**
   * Turning a subtitle on. Text tracks are fetched and drawn locally; picture
   * tracks have to go back through the server to be burned into the video,
   * which is a whole re-encode and worth saying out loud.
   */
  async selectSubtitle(trackId, { quiet = false } = {}) {
    const subs = this.ctx.subtitles || [];

    if (!trackId) {
      this.subtitleTrackId = null;
      this.subtitleLayer.clear();
      this.subtitleLayer.setVisible(true);
      if (this.burnSubtitle != null) {
        this.burnSubtitle = null;
        this.attachSource(this.currentTime);
      }
      if (!quiet) toast('Subtitles off');
      return;
    }

    const track = subs.find((s) => s.id === trackId);
    if (!track) return;

    if (track.requiresBurnIn) {
      if (track.trackIndex == null) {
        toast('That subtitle track cannot be displayed');
        return;
      }
      this.subtitleTrackId = trackId;
      this.subtitleLayer.clear();
      this.burnSubtitle = track.trackIndex;
      this.mode = 'transcode';
      toast(`Subtitles: ${track.label} — burning in, this may take a moment`);
      this.attachSource(this.currentTime);
      return;
    }

    // Swapping from a burned-in track back to a text one has to drop the
    // burn, otherwise both would end up on screen.
    if (this.burnSubtitle != null) {
      this.burnSubtitle = null;
      this.attachSource(this.currentTime);
    }

    try {
      const vtt = await api.subtitleTrack(this.fileId, trackId);
      this.subtitleTrackId = trackId;
      this.subtitleLayer.setCues(parseVtt(vtt));
      this.subtitleLayer.setVisible(true);
      if (!quiet) toast(`Subtitles: ${track.label}`);
    } catch (err) {
      this.subtitleTrackId = null;
      this.subtitleLayer.clear();
      toast(err.message || 'That subtitle track could not be loaded');
    }
  }

  openChapterMenu(anchor) {
    if (!this.chapters.length) return;
    const now = this.currentTime;
    let current = 0;
    this.chapters.forEach((c, i) => { if (c.start <= now) current = i; });

    const items = this.chapters.map((c) => ({ label: c.title, hint: formatTime(c.start) }));
    this.openMenu('chapters', anchor, items, current, (i) => {
      this.seekTo(this.chapters[i].start);
      toast(this.chapters[i].title);
    });
  }

  /** Speed, subtitle delay, and which version of the file is playing. */
  openSettingsMenu(anchor) {
    const versions = this.ctx.versions || [];
    const items = [
      { label: 'Playback speed', hint: this.speed === 1 ? 'Normal' : `${this.speed}×`, action: (a) => this.openSpeedMenu(a) },
      ...(this.subtitleTrackId
        ? [{ label: 'Subtitle delay', hint: `${this.subtitleDelay > 0 ? '+' : ''}${this.subtitleDelay.toFixed(1)}s`, action: (a) => this.openDelayMenu(a) }]
        : []),
      ...(versions.length > 1
        ? [{ label: 'Version', hint: versions.find((v) => v.id === this.fileId)?.versionLabel || '', action: (a) => this.openVersionMenu(a) }]
        : []),
      { label: 'Technical info', hint: '', action: () => this.showTechnical() },
    ];

    this.openMenu('settings', anchor, items, -1, (i) => {
      const chosen = items[i];
      // Re-opening from the same button keeps the submenu anchored sensibly.
      setTimeout(() => chosen.action(anchor), 0);
    });
  }

  openSpeedMenu(anchor) {
    const items = SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×` }));
    this.openMenu('speed', anchor, items, SPEEDS.indexOf(this.speed), (i) => this.setSpeed(SPEEDS[i]));
  }

  openDelayMenu(anchor) {
    const steps = [-3, -2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 3];
    const items = steps.map((s) => ({ label: s === 0 ? 'In sync' : `${s > 0 ? '+' : ''}${s}s` }));
    this.openMenu('delay', anchor, items, steps.indexOf(this.subtitleDelay), (i) => {
      this.subtitleDelay = steps[i];
      this.subtitleLayer.setDelay(steps[i]);
      toast(steps[i] === 0 ? 'Subtitles in sync' : `Subtitles ${steps[i] > 0 ? 'delayed' : 'advanced'} ${Math.abs(steps[i])}s`);
    });
  }

  openVersionMenu(anchor) {
    const versions = this.ctx.versions || [];
    const items = versions.map((v) => ({
      label: v.versionLabel || v.filename,
      hint: v.size ? formatBytes(v.size) : '',
    }));
    this.openMenu('version', anchor, items, versions.findIndex((v) => v.id === this.fileId), (i) => {
      const chosen = versions[i];
      if (chosen.id === this.fileId) return;

      // Two versions of the same film are not always the same length — an
      // extended cut against a theatrical one, a PAL transfer against an NTSC
      // one. Carrying the position across unclamped starts the new file past
      // its own end, which reads as the player closing itself the instant you
      // pick a version.
      let at = this.currentTime;
      if (chosen.duration && at > chosen.duration - 10) {
        at = Math.max(0, chosen.duration - 10);
      }
      closePlayer();
      openPlayer(chosen.id, at);
    });
  }

  showTechnical() {
    const t = this.ctx.technical;
    if (!t) return;
    const rows = [
      ['Container', t.container],
      ['Video', [t.video?.codec?.toUpperCase(), t.video?.resolution, t.video?.frameRate ? `${t.video.frameRate}fps` : null, t.video?.bitDepth ? `${t.video.bitDepth}-bit` : null].filter(Boolean).join(' · ')],
      ['HDR', t.video?.hdrFormat],
      ['Audio', t.audio?.map((a) => [a.languageName || a.label, a.codec?.toUpperCase(), a.channelLabel].filter(Boolean).join(' ')).join(', ')],
      ['Subtitles', t.subtitles?.length ? t.subtitles.map((s) => `${s.languageName || s.label} (${s.format})`).join(', ') : 'None'],
      ['Playing via', this.mode === 'direct' ? 'Direct play' : this.forceFullEncode ? 'Transcoding' : 'Remuxing'],
      ['Size', t.size ? formatBytes(t.size) : null],
    ].filter(([, v]) => v);

    this.openMenu(
      'technical',
      this.settingsBtn,
      rows.map(([k, v]) => ({ label: k, hint: String(v) })),
      -1,
      () => {}
    );
  }

  /**
   * A floating list above whichever button opened it — a proper picker
   * rather than a blind cycle-and-hope-you-notice button.
   */
  openMenu(key, anchor, items, currentIndex, onSelect) {
    if (this.menuFor === key) { this.closeTrackMenu(); return; }
    this.closeTrackMenu();
    this.menuFor = key;

    const menu = el(
      'div',
      { class: 'player__menu' },
      items.map((item, i) =>
        el(
          'button',
          {
            class: `player__menu-item${i === currentIndex ? ' is-active' : ''}`, type: 'button',
            onClick: () => { this.closeTrackMenu(); onSelect(i); },
          },
          el('span', { class: 'player__menu-label' }, item.label),
          item.hint ? el('span', { class: 'player__menu-hint' }, item.hint) : null
        )
      )
    );

    const rect = anchor.getBoundingClientRect();
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;

    document.body.append(menu);
    this.trackMenu = menu;
    // Remembered so closing the menu can put the cursor back where it came
    // from. On a remote there is nowhere else for it to go: the menu is gone,
    // and a cursor that was inside it goes with it.
    this.menuAnchor = anchor;
    // On a remote there's no hover or first-arrow-press to reveal where the
    // cursor is — land it on the current item immediately so the menu reads
    // as already-focused, not blank until the first D-pad press.
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
    const heldCursor = Boolean(this.trackMenu.querySelector('.tv-cursor'));
    this.trackMenu.remove();
    this.trackMenu = null;
    this.menuFor = null;
    if (this.menuOutsideHandler) { document.removeEventListener('click', this.menuOutsideHandler); this.menuOutsideHandler = null; }
    if (this.menuKeyHandler) { document.removeEventListener('keydown', this.menuKeyHandler); this.menuKeyHandler = null; }

    // The cursor was in the list that just disappeared. Hand it back to the
    // button that opened it, rather than leaving the screen with nothing
    // focused and the next D-pad press landing somewhere unpredictable.
    const anchor = this.menuAnchor;
    this.menuAnchor = null;
    if (heldCursor && TV_MODE) focusElement(anchor);
  }

  // --- what comes next --------------------------------------------------

  showNextCard() {
    const n = this.nextEpisode;
    const autoplay = this.prefs.autoplayNext !== false;

    this.nextCard = el(
      'div',
      { class: 'player__next' },
      el(
        'div',
        {},
        el('p', { class: 'player__next-label' }, 'UP NEXT'),
        el('p', { class: 'player__next-title' }, `S${n.season} E${n.episode}${n.name ? ` · ${n.name}` : ''}`)
      ),
      el('button', { class: 'btn btn--play btn--sm', type: 'button', onClick: () => this.playEpisode(n) }, icon('play'), 'Play'),
      autoplay
        ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => this.cancelAutoplay() }, 'Stay here')
        : null
    );
    this.ui.append(this.nextCard);
  }

  cancelAutoplay() {
    this.autoplayCancelled = true;
    this.nextCard?.remove();
    this.nextCard = null;
  }

  playEpisode(target) {
    if (!target) return;
    const fileId = target.fileId;
    closePlayer();
    openPlayer(fileId, 0);
  }

  onEnded() {
    this.reportProgress(true);
    const autoplay = this.prefs.autoplayNext !== false && !this.autoplayCancelled;
    if (this.nextEpisode && autoplay) this.playEpisode(this.nextEpisode);
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

  // --- chrome -----------------------------------------------------------

  bindIdle() {
    const reset = () => {
      this.root.classList.remove('is-idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        // A menu is a deliberate interaction: reading down a list of audio
        // tracks takes longer than three seconds, and hiding the controls
        // underneath it — along with the mouse pointer — while the viewer is
        // still choosing is a way of punishing them for deciding slowly.
        if (this.trackMenu) return reset();
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

  /**
   * Whether a D-pad cursor currently sits on one of the player's own buttons
   * — once it does, Left/Right hand off to tvnav for moving between them
   * instead of seeking directly.
   *
   * A cursor that has gone stale (its element was removed) counts as being on
   * the controls too. Handing off re-seats it somewhere real; treating it as
   * "nothing focused" would turn the viewer's next press into an unrequested
   * ten-second jump.
   */
  controlsActive() {
    if (this.ui?.querySelector('.tv-cursor')) return true;
    return !document.querySelector('.tv-cursor');
  }

  bindKeys() {
    this.keyHandler = (e) => {
      // A menu owns the keyboard while it's open — tvnav.js takes over
      // arrow/Enter navigation of its items, and its own Escape handler
      // closes just the menu.
      if (this.trackMenu) return;
      if (e.target.matches('input, textarea')) return;

      this.resetIdle?.();

      // A real Fire TV remote has no keyboard shortcut letters and no mouse —
      // the only way it can reach the audio/subtitle/settings buttons is by
      // D-pad-navigating tvnav's cursor onto them. Up/Down always hand off in
      // tv-mode; Left/Right only once a control is already focused, so until
      // then they stay a direct seek exactly like the desktop shortcut.
      const handingOffToTvnav = TV_MODE && (
        e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ') && this.controlsActive())
      );
      if (handingOffToTvnav) return;

      switch (e.key) {
        case ' ': case 'k': case 'MediaPlayPause': e.preventDefault(); this.toggle(); break;
        case 'ArrowLeft': case 'j': e.preventDefault(); this.skip(-10); break;
        case 'ArrowRight': case 'l': e.preventDefault(); this.skip(10); break;
        case 'MediaRewind': e.preventDefault(); this.skip(-30); break;
        case 'MediaFastForward': e.preventDefault(); this.skip(30); break;
        case 'MediaTrackPrevious': this.jumpChapter(-1); break;
        case 'MediaTrackNext': this.jumpChapter(1); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); break;
        case 'p': this.jumpChapter(-1); break;
        case 'n': this.jumpChapter(1); break;
        case 'f': this.toggleFullscreen(); break;
        case 'm': this.toggleMute(); break;
        case 'i': this.showTechnical(); break;
        case 'c': if (!this.subBtn.hidden) this.openSubtitleMenu(this.subBtn); break;
        case 'a': if (!this.audioBtn.hidden) this.openAudioMenu(this.audioBtn); break;
        case '<': this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.speed) - 1)]); break;
        case '>': this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.speed) + 1)]); break;
        case 'Escape': if (!document.fullscreenElement) closePlayer(); break;
        default: break;
      }
    };
    document.addEventListener('keydown', this.keyHandler);
  }

  showError(headline, detail, { retry = false } = {}) {
    clear(this.root);
    this.root.append(
      el(
        'div',
        { class: 'player__error' },
        el('h2', { class: 'player__error-title' }, headline),
        el('p', { class: 'player__error-detail' }, detail || ''),
        el(
          'div',
          { class: 'player__error-actions' },
          retry
            ? el('button', {
                class: 'btn btn--play btn--sm', type: 'button',
                onClick: () => { const id = this.fileId; const at = this.startAt; closePlayer(); openPlayer(id, at); },
              }, 'Try again')
            : null,
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => closePlayer() }, 'Close')
        )
      )
    );
    if (TV_MODE) focusFirstIn(this.root);
  }

  destroy() {
    this.destroyed = true;
    this.reportProgress();
    api.stopped({ fileId: this.fileId, secondsWatched: this.watchedSeconds, completed: false }).catch(() => {});
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.idleTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.closeTrackMenu();
    this.subtitleLayer.destroy();
    // Detach the source so the browser stops pulling bytes immediately, which
    // is also what tells the server to stop encoding.
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    document.body.classList.remove('is-locked');

    // Hand the cursor back to whatever opened the player. Without this the
    // page behind is left with nothing focused, and the next press has to
    // guess where to start.
    if (TV_MODE) focusElement(this.openedFrom);
  }
}

/**
 * For the Fire TV back-button bridge — close just an open menu before it
 * falls through to closing the whole player.
 */
export function closeActiveTrackMenu() {
  if (active?.trackMenu) { active.closeTrackMenu(); return true; }
  return false;
}
