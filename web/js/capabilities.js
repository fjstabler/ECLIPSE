/**
 * What this device can actually decode.
 *
 * Without this the server has to assume the lowest common denominator — the
 * codecs every browser has always had — which means a phone that decodes
 * HEVC in hardware gets a full re-encode of a file it could have played
 * untouched. On a two-core box that is the difference between a library that
 * plays instantly and one that stutters.
 *
 * The answers come from the media element itself rather than from sniffing
 * the user agent: `canPlayType` is what the browser will honour when the
 * stream arrives, and a Fire TV WebView, iPhone Safari and desktop Chrome all
 * genuinely differ. When it lies, the player's fallback ladder still catches
 * it — a failed remux becomes a full encode — so an optimistic answer costs
 * one retry, never a dead player.
 */

/**
 * Probes, in the codec names ffprobe uses (which is what the server stores).
 * Each entry is tried until one is playable.
 */
const VIDEO_PROBES = [
  { codec: 'h264', types: ['video/mp4; codecs="avc1.640029"', 'video/mp4; codecs="avc1.42E01E"'] },
  { codec: 'hevc', types: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'] },
  { codec: 'vp8', types: ['video/webm; codecs="vp8"'] },
  { codec: 'vp9', types: ['video/mp4; codecs="vp09.00.10.08"', 'video/webm; codecs="vp9"'] },
  { codec: 'av1', types: ['video/mp4; codecs="av01.0.08M.08"'] },
];

/**
 * The same codecs at 10 bits per sample, asked separately.
 *
 * Bit depth is not a detail here: h264 High 10 is a profile no browser
 * decodes even though plain h264 is universal, and a device that reports
 * HEVC without Main 10 would choke on most modern encodes. The server only
 * copies a 10-bit stream through if the codec appears in this second list.
 */
const VIDEO_10BIT_PROBES = [
  { codec: 'h264', types: ['video/mp4; codecs="avc1.6E0033"'] },
  { codec: 'hevc', types: ['video/mp4; codecs="hvc1.2.4.L120.B0"', 'video/mp4; codecs="hev1.2.4.L120.B0"'] },
  { codec: 'vp9', types: ['video/mp4; codecs="vp09.02.10.10"', 'video/webm; codecs="vp9.2"'] },
  { codec: 'av1', types: ['video/mp4; codecs="av01.0.08M.10"'] },
];

const AUDIO_PROBES = [
  { codec: 'aac', types: ['audio/mp4; codecs="mp4a.40.2"'] },
  { codec: 'mp3', types: ['audio/mp4; codecs="mp4a.40.34"', 'audio/mpeg'] },
  { codec: 'ac3', types: ['audio/mp4; codecs="ac-3"'] },
  { codec: 'eac3', types: ['audio/mp4; codecs="ec-3"'] },
  { codec: 'flac', types: ['audio/mp4; codecs="flac"', 'audio/flac'] },
  { codec: 'opus', types: ['audio/mp4; codecs="opus"', 'audio/webm; codecs="opus"'] },
  { codec: 'vorbis', types: ['audio/webm; codecs="vorbis"'] },
];

let cached = null;

function playable(probe, types) {
  return types.some((t) => {
    // "maybe" is the browser saying it can't tell without the bytes. Taking
    // it as yes is the right bet: the fallback ladder handles the miss, and
    // treating it as no would re-encode HEVC on every device that hedges.
    const answer = probe.canPlayType(t);
    return answer === 'probably' || answer === 'maybe';
  });
}

/** Everything this device claims, worked out once and remembered. */
export function capabilities() {
  if (cached) return cached;

  let probe;
  try {
    probe = document.createElement('video');
  } catch {
    return { video: [], video10: [], audio: [] };
  }
  if (typeof probe.canPlayType !== 'function') return { video: [], video10: [], audio: [] };

  const video = VIDEO_PROBES.filter((p) => playable(probe, p.types)).map((p) => p.codec);
  const audio = AUDIO_PROBES.filter((p) => playable(probe, p.types)).map((p) => p.codec);
  const video10 = VIDEO_10BIT_PROBES
    .filter((p) => video.includes(p.codec) && playable(probe, p.types))
    .map((p) => p.codec);

  cached = { video, video10, audio };
  return cached;
}

/**
 * The capability set as query parameters, ready to be merged into a stream
 * URL. Empty when nothing could be probed, which leaves the server on its
 * safe defaults rather than claiming this device can play nothing.
 */
export function capabilityParams() {
  const caps = capabilities();
  const params = new URLSearchParams();
  if (caps.video.length) params.set('video', caps.video.join(','));
  if (caps.video10.length) params.set('video10', caps.video10.join(','));
  if (caps.audio.length) params.set('audio_codecs', caps.audio.join(','));
  return params;
}

/** The same thing as a query string, with no leading `?`. */
export function capabilityQuery() {
  return capabilityParams().toString();
}
