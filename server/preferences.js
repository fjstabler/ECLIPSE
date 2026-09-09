import { db } from './db.js';

/**
 * Per-viewer playback settings.
 *
 * Kept apart from taste_profiles on purpose: that's what N.O.V.A. reads to
 * decide what to suggest, this is how the player behaves once something is
 * chosen. Mixing them would mean "I like subtitles large" ending up as an
 * input to a recommendation.
 */

const DEFAULTS = {
  autoplayNext: true,
  skipIntro: 'ask',
  skipCredits: 'ask',
  audioLanguage: null,
  subtitleLanguage: null,
  subtitlesDefault: false,
  subtitleSize: 100,
  subtitleColour: '#ffffff',
  subtitleBackground: 0.55,
  subtitlePosition: 88,
  playbackSpeed: 1,
  maxHeight: 0,
  maxBitrate: 0,
};

export function getPreferences(userId) {
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  if (!row) return { ...DEFAULTS };
  return {
    autoplayNext: row.autoplay_next === 1,
    skipIntro: row.skip_intro,
    skipCredits: row.skip_credits,
    audioLanguage: row.audio_language,
    subtitleLanguage: row.subtitle_language,
    subtitlesDefault: row.subtitles_default === 1,
    subtitleSize: row.subtitle_size,
    subtitleColour: row.subtitle_colour,
    subtitleBackground: row.subtitle_background,
    subtitlePosition: row.subtitle_position,
    playbackSpeed: row.playback_speed,
    maxHeight: row.max_height,
    maxBitrate: row.max_bitrate,
  };
}

export function savePreferences(userId, patch = {}) {
  const current = getPreferences(userId);
  const next = { ...current, ...patch };

  // Every value is clamped rather than trusted — these come straight from a
  // settings form, and a subtitle size of 4000% would make the player useless
  // with no obvious way back.
  const clean = {
    user_id: userId,
    autoplay_next: next.autoplayNext ? 1 : 0,
    skip_intro: ['ask', 'auto', 'off'].includes(next.skipIntro) ? next.skipIntro : 'ask',
    skip_credits: ['ask', 'auto', 'off'].includes(next.skipCredits) ? next.skipCredits : 'ask',
    audio_language: next.audioLanguage || null,
    subtitle_language: next.subtitleLanguage || null,
    subtitles_default: next.subtitlesDefault ? 1 : 0,
    subtitle_size: clamp(next.subtitleSize, 50, 250, 100),
    subtitle_colour: /^#[0-9a-f]{6}$/i.test(next.subtitleColour || '') ? next.subtitleColour : '#ffffff',
    subtitle_background: clamp(next.subtitleBackground, 0, 1, 0.55),
    subtitle_position: clamp(next.subtitlePosition, 50, 98, 88),
    playback_speed: clamp(next.playbackSpeed, 0.25, 3, 1),
    max_height: clamp(next.maxHeight, 0, 4320, 0),
    max_bitrate: clamp(next.maxBitrate, 0, 200_000_000, 0),
  };

  db.prepare(`
    INSERT INTO user_preferences (user_id, autoplay_next, skip_intro, skip_credits, audio_language,
      subtitle_language, subtitles_default, subtitle_size, subtitle_colour, subtitle_background,
      subtitle_position, playback_speed, max_height, max_bitrate, updated_at)
    VALUES (@user_id, @autoplay_next, @skip_intro, @skip_credits, @audio_language,
      @subtitle_language, @subtitles_default, @subtitle_size, @subtitle_colour, @subtitle_background,
      @subtitle_position, @playback_speed, @max_height, @max_bitrate, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      autoplay_next=@autoplay_next, skip_intro=@skip_intro, skip_credits=@skip_credits,
      audio_language=@audio_language, subtitle_language=@subtitle_language,
      subtitles_default=@subtitles_default, subtitle_size=@subtitle_size,
      subtitle_colour=@subtitle_colour, subtitle_background=@subtitle_background,
      subtitle_position=@subtitle_position, playback_speed=@playback_speed,
      max_height=@max_height, max_bitrate=@max_bitrate, updated_at=datetime('now')
  `).run(clean);

  return getPreferences(userId);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Which audio track and subtitle a viewer should land on for this file,
 * given what they've said they prefer and what the file actually contains.
 *
 * The forced-subtitle rule is the interesting one: when the audio isn't in
 * the language you asked for, or the file marks a track forced, that's the
 * track carrying the signs and foreign dialogue — the one you want on even
 * with subtitles otherwise off.
 */
export function pickTracks(prefs, { audioTracks = [], subtitles = [] }) {
  const audio = pickAudio(prefs, audioTracks);
  const subtitle = pickSubtitle(prefs, subtitles, audio);
  return { audio, subtitle };
}

function pickAudio(prefs, tracks) {
  if (!tracks.length) return null;
  const wanted = prefs.audioLanguage;
  if (wanted) {
    // Commentary tracks share a language with the feature audio and are never
    // what someone means by "play this in English".
    const match = tracks.find((t) => sameLanguage(t.language, wanted) && !t.isCommentary && !t.isVisualImpaired);
    if (match) return match;
  }
  return tracks.find((t) => t.isDefault) || tracks[0];
}

function pickSubtitle(prefs, subtitles, audio) {
  if (!subtitles.length) return null;
  const usable = subtitles.filter((s) => s.extractable);
  if (!usable.length) return null;

  const wanted = prefs.subtitleLanguage || prefs.audioLanguage;

  if (prefs.subtitlesDefault) {
    const match = wanted && usable.find((s) => sameLanguage(s.language, wanted) && !s.isForced);
    if (match) return match;
    return usable.find((s) => s.isDefault) || usable[0];
  }

  // Subtitles are off, but a forced track in the language being read is
  // still wanted — that's the one that translates the signs.
  const audioLanguage = audio?.language || null;
  const forced = usable.find((s) => s.isForced && (!wanted || sameLanguage(s.language, wanted) || sameLanguage(s.language, audioLanguage)));
  return forced || null;
}

/** "en" and "eng" are the same language written two ways. */
function sameLanguage(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.slice(0, 2) === y.slice(0, 2);
}
