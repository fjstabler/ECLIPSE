import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { LANGUAGE_NAMES } from '../util/parse.js';

const execFileAsync = promisify(execFile);

/**
 * Everything ECLIPSE knows about an actual file on disk.
 *
 * This is deliberately the only place that talks to ffprobe. What comes back
 * describes the file as it really is — every stream it actually contains, in
 * the order ffmpeg itself numbers them — because every playback decision made
 * later (can this direct play, which audio track is "-map 0:a:2", is that
 * subtitle extractable as text or does it have to be burned in) is only as
 * honest as this is.
 *
 * Bump PROBE_VERSION whenever this returns something new. The scanner re-reads
 * any file probed by an older version, so an upgrade backfills itself on the
 * next scan instead of leaving half the library described in the old shape.
 */
export const PROBE_VERSION = 2;

/** Subtitle codecs that are actual text, and can therefore become WebVTT. */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'stl', 'subviewer', 'subviewer1', 'microdvd',
]);

/**
 * Picture-based subtitles. These are images, not words — there is no honest
 * way to turn them into a WebVTT track without OCR, so the player is told
 * they exist but can only show them by burning them into the video.
 */
const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvbsub', 'pgssub',
]);

export async function probeFile(filePath) {
  if (!config.ffmpeg.enabled) return null;
  let data;
  try {
    const { stdout } = await execFileAsync(
      config.ffmpeg.probeBin,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        filePath,
      ],
      { timeout: 60000, maxBuffer: 24 * 1024 * 1024 }
    );
    data = JSON.parse(stdout);
  } catch {
    return null;
  }

  const format = data.format || {};
  const allStreams = data.streams || [];

  // ffmpeg addresses streams per type ("-map 0:a:1" is the second *audio*
  // stream, not stream index 1), so each stream carries both its absolute
  // index and its position within its own kind. Getting these two confused
  // is what makes a player select the wrong language.
  const perKindCount = { video: 0, audio: 0, subtitle: 0 };
  const streams = [];

  for (const s of allStreams) {
    const kind = s.codec_type;
    if (kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') continue;
    // Cover art inside an audio-less container shows up as a video stream of
    // still images; treating it as the feature video would report a film as
    // being 600x900 and one frame long.
    if (kind === 'video' && isAttachedPicture(s)) continue;

    const typeIndex = perKindCount[kind]++;
    streams.push(describeStream(s, kind, typeIndex));
  }

  const video = streams.find((s) => s.kind === 'video') || null;
  const audio = streams.find((s) => s.kind === 'audio') || null;

  return {
    probeVersion: PROBE_VERSION,
    container: (format.format_name || '').split(',')[0] || null,
    containerLong: format.format_long_name || null,
    duration: numberOrNull(format.duration),
    size: numberOrNull(format.size),
    bitrate: numberOrNull(format.bit_rate),
    streamCount: streams.length,

    // Flattened headline properties, so the common "what is this file" question
    // never has to walk the stream list.
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec ?? null,
    audioCodec: audio?.codec ?? null,
    frameRate: video?.frameRate ?? null,
    videoBitrate: video?.bitrate ?? null,
    bitDepth: video?.bitDepth ?? null,
    pixelFormat: video?.pixelFormat ?? null,
    colorSpace: video?.colorSpace ?? null,
    colorTransfer: video?.colorTransfer ?? null,
    colorPrimaries: video?.colorPrimaries ?? null,
    hdrFormat: video?.hdrFormat ?? null,
    aspectRatio: video?.aspectRatio ?? null,
    videoProfile: video?.profile ?? null,

    streams,
    chapters: (data.chapters || []).map((c, i) => ({
      index: i,
      title: c.tags?.title || null,
      start: numberOrNull(c.start_time) ?? 0,
      end: numberOrNull(c.end_time),
    })),
  };
}

function describeStream(s, kind, typeIndex) {
  const d = s.disposition || {};
  const tags = normaliseTags(s.tags);
  const title = tags.title || null;
  const language = normaliseLanguage(tags.language);
  const lowerTitle = (title || '').toLowerCase();

  // Disposition flags are the reliable signal, but plenty of real-world files
  // carry nothing but a title like "English (SDH)" or "Commentary — director",
  // so the title is read as a fallback rather than trusted blindly.
  const forced = d.forced === 1 || /\bforced\b/.test(lowerTitle);
  const hearingImpaired = d.hearing_impaired === 1 || /\b(sdh|cc)\b/.test(lowerTitle);
  const visualImpaired = d.visual_impaired === 1 || /\b(audio description|described|ad)\b/.test(lowerTitle);
  const commentary = d.comment === 1 || /\bcommentar/.test(lowerTitle);

  const base = {
    kind,
    streamIndex: s.index ?? 0,
    typeIndex,
    codec: s.codec_name || null,
    codecLong: s.codec_long_name || null,
    language,
    title,
    isDefault: d.default === 1,
    isForced: forced,
    isHearingImpaired: hearingImpaired,
    isVisualImpaired: visualImpaired,
    isCommentary: commentary,
    bitrate: numberOrNull(s.bit_rate) ?? numberOrNull(tags['bps-eng']) ?? numberOrNull(tags.bps),
    profile: s.profile || null,
  };

  if (kind === 'video') {
    const colorTransfer = s.color_transfer || null;
    return {
      ...base,
      width: s.width || null,
      height: s.height || null,
      frameRate: parseFrameRate(s.avg_frame_rate) ?? parseFrameRate(s.r_frame_rate),
      bitDepth: numberOrNull(s.bits_per_raw_sample) ?? bitDepthFromPixelFormat(s.pix_fmt),
      pixelFormat: s.pix_fmt || null,
      colorSpace: s.color_space || null,
      colorTransfer,
      colorPrimaries: s.color_primaries || null,
      hdrFormat: detectHdr(s, colorTransfer),
      aspectRatio: s.display_aspect_ratio || null,
      level: s.level ?? null,
      label: videoLabel(s),
      channels: null,
      channelLayout: null,
      sampleRate: null,
      isText: false,
      isExtractable: false,
    };
  }

  if (kind === 'audio') {
    return {
      ...base,
      channels: s.channels || null,
      channelLayout: s.channel_layout || null,
      sampleRate: numberOrNull(s.sample_rate),
      width: null,
      height: null,
      frameRate: null,
      bitDepth: numberOrNull(s.bits_per_raw_sample) || null,
      label: audioLabel({ title, language, channels: s.channels, codec: s.codec_name, commentary, visualImpaired, typeIndex }),
      isText: false,
      isExtractable: false,
    };
  }

  // Subtitles
  const codec = (s.codec_name || '').toLowerCase();
  const isText = TEXT_SUBTITLE_CODECS.has(codec);
  const isBitmap = BITMAP_SUBTITLE_CODECS.has(codec);
  return {
    ...base,
    channels: null,
    channelLayout: null,
    sampleRate: null,
    width: null,
    height: null,
    frameRate: null,
    bitDepth: null,
    isText,
    // Anything not recognised as a picture format is worth attempting as text;
    // the extraction endpoint fails loudly rather than the track being hidden.
    isExtractable: isText || !isBitmap,
    label: subtitleLabel({ title, language, forced, hearingImpaired, isBitmap, typeIndex }),
  };
}

/**
 * A still image packaged as a video stream — album art, an embedded poster.
 * Real footage never carries this disposition.
 */
function isAttachedPicture(s) {
  if (s.disposition?.attached_pic === 1) return true;
  return ['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes((s.codec_name || '').toLowerCase());
}

/**
 * HDR10 and HLG are identifiable from the transfer characteristics alone.
 * Dolby Vision and HDR10+ carry their own side data, which is the only place
 * that distinction actually lives.
 */
function detectHdr(s, colorTransfer) {
  const sideData = s.side_data_list || [];
  const sideTypes = sideData.map((x) => (x.side_data_type || '').toLowerCase());

  if (sideTypes.some((t) => t.includes('dovi') || t.includes('dolby vision'))) return 'Dolby Vision';
  if (sideTypes.some((t) => t.includes('hdr dynamic metadata') || t.includes('smpte2094'))) return 'HDR10+';

  const transfer = (colorTransfer || '').toLowerCase();
  if (transfer === 'arib-std-b67') return 'HLG';
  if (transfer === 'smpte2084' || transfer === 'smpte-st-2084') return 'HDR10';
  return null;
}

/** "24000/1001" is 23.976fps; ffprobe never gives a plain decimal here. */
function parseFrameRate(value) {
  if (!value || typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 1000) / 1000;
}

/** yuv420p10le carries its depth in the name when bits_per_raw_sample is absent. */
function bitDepthFromPixelFormat(pixFmt) {
  if (!pixFmt) return null;
  const match = /(\d{1,2})(le|be)?$/.exec(pixFmt);
  if (!match) return pixFmt.includes('p') ? 8 : null;
  const depth = Number(match[1]);
  return depth >= 8 && depth <= 16 ? depth : 8;
}

/** Matroska writes tag keys in mixed case; MP4 tends to lowercase them. */
function normaliseTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * "und" is ffprobe's way of saying the file never said. Reporting that as a
 * language would put a meaningless "UND" in the track picker.
 */
function normaliseLanguage(raw) {
  const lang = (raw || '').toLowerCase().trim();
  if (!lang || lang === 'und' || lang === 'unknown') return null;
  return lang;
}

export function languageName(code) {
  if (!code) return null;
  return LANGUAGE_NAMES[code] || code.toUpperCase();
}

function videoLabel(s) {
  const height = s.height;
  const quality = height >= 2000 ? '4K' : height >= 1400 ? '1440p' : height >= 1000 ? '1080p' : height >= 700 ? '720p' : height ? `${height}p` : null;
  return [quality, (s.codec_name || '').toUpperCase()].filter(Boolean).join(' · ') || 'Video';
}

/**
 * What the viewer sees in the track picker. The file's own title wins when it
 * has one — whoever made the release usually described it better than a
 * generated string can.
 */
function audioLabel({ title, language, channels, codec, commentary, visualImpaired, typeIndex }) {
  if (title) return title;
  const parts = [];
  parts.push(languageName(language) || `Track ${typeIndex + 1}`);
  if (channels) parts.push(channelLabel(channels));
  if (codec) parts.push(codec.toUpperCase());
  if (commentary) parts.push('Commentary');
  if (visualImpaired) parts.push('Audio description');
  return parts.join(' · ');
}

export function channelLabel(channels) {
  if (!channels) return null;
  return { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[channels] || `${channels}ch`;
}

function subtitleLabel({ title, language, forced, hearingImpaired, isBitmap, typeIndex }) {
  if (title) return title;
  const parts = [languageName(language) || `Track ${typeIndex + 1}`];
  if (forced) parts.push('Forced');
  if (hearingImpaired) parts.push('SDH');
  if (isBitmap) parts.push('Image');
  return parts.join(' · ');
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
