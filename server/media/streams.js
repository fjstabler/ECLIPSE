import { db } from '../db.js';
import { languageName, channelLabel } from './probe.js';

/**
 * Reading side of what the prober stored: the tracks a viewer can actually
 * choose between, the chapters they can jump to, and the technical truth
 * about the file behind it all.
 *
 * The rule running through this file is that nothing is invented. If a file
 * carries one Japanese subtitle track, the player is offered exactly one
 * Japanese subtitle track — not an English one that doesn't exist, and not a
 * generic "Subtitles" entry that turns out to be empty.
 */

const streamsFor = db.prepare(
  'SELECT * FROM media_streams WHERE media_file_id = ? ORDER BY kind, type_index'
);

export function getStreams(mediaFileId) {
  return streamsFor.all(mediaFileId);
}

/** Audio tracks in the order ffmpeg numbers them, which is what -map wants. */
export function getAudioTracks(mediaFileId) {
  return getStreams(mediaFileId)
    .filter((s) => s.kind === 'audio')
    .map((s) => ({
      id: `a-${s.type_index}`,
      trackIndex: s.type_index,
      streamIndex: s.stream_index,
      label: s.label || languageName(s.language) || `Track ${s.type_index + 1}`,
      language: s.language,
      languageName: languageName(s.language),
      codec: s.codec,
      channels: s.channels,
      channelLayout: s.channel_layout,
      channelLabel: channelLabel(s.channels),
      sampleRate: s.sample_rate,
      bitrate: s.bitrate,
      isDefault: s.is_default === 1,
      isCommentary: s.is_commentary === 1,
      isVisualImpaired: s.is_visual_impaired === 1,
    }));
}

/**
 * Every subtitle a viewer can pick, embedded and sidecar together, in one
 * list — because from the sofa there's no difference between a track inside
 * the file and a .srt sitting next to it.
 *
 * `extractable` is the honest part: picture-based subtitles (PGS, VobSub)
 * are images of words, and there's no way to turn them into a WebVTT track
 * without OCR. They're still listed, but flagged so the player can say they
 * need burning in rather than silently showing nothing.
 */
export function getSubtitleTracks(mediaFileId) {
  const embedded = getStreams(mediaFileId)
    .filter((s) => s.kind === 'subtitle')
    .map((s) => ({
      id: `e-${s.type_index}`,
      source: 'embedded',
      trackIndex: s.type_index,
      streamIndex: s.stream_index,
      label: s.label || languageName(s.language) || `Track ${s.type_index + 1}`,
      language: s.language,
      languageName: languageName(s.language),
      codec: s.codec,
      isDefault: s.is_default === 1,
      isForced: s.is_forced === 1,
      isHearingImpaired: s.is_hearing_impaired === 1,
      extractable: s.is_extractable === 1,
      requiresBurnIn: s.is_extractable !== 1,
    }));

  const sidecar = db
    .prepare('SELECT * FROM subtitles WHERE media_file_id = ? ORDER BY id')
    .all(mediaFileId)
    .map((s) => ({
      id: `s-${s.id}`,
      source: 'external',
      subtitleId: s.id,
      label: s.label || languageName(s.language) || 'Subtitles',
      language: s.language && s.language !== 'und' ? s.language : null,
      languageName: languageName(s.language && s.language !== 'und' ? s.language : null),
      codec: null,
      isDefault: false,
      isForced: s.forced === 1,
      isHearingImpaired: false,
      extractable: true,
      requiresBurnIn: false,
    }));

  return [...embedded, ...sidecar];
}

export function getChapters(mediaFileId) {
  return db
    .prepare('SELECT idx, title, start_time, end_time FROM chapters WHERE media_file_id = ? ORDER BY idx')
    .all(mediaFileId)
    .map((c) => ({
      index: c.idx,
      // A chapter with no name is still a useful jump point; numbering it is
      // more honest than inventing a name for it.
      title: c.title || `Chapter ${c.idx + 1}`,
      start: c.start_time,
      end: c.end_time,
    }));
}

export function getMarkers(mediaFileId) {
  return db
    .prepare('SELECT kind, start_time, end_time, source FROM media_markers WHERE media_file_id = ?')
    .all(mediaFileId)
    .map((m) => ({ kind: m.kind, start: m.start_time, end: m.end_time, source: m.source }));
}

/**
 * The technical panel's payload: what this file is, in the terms someone
 * who cares about that would actually use. Anything the probe couldn't
 * determine is left out rather than filled with "Unknown".
 */
export function technicalInfo(file) {
  if (!file) return null;
  const streams = getStreams(file.id);
  const video = streams.find((s) => s.kind === 'video');

  return {
    container: containerName(file),
    size: file.size,
    duration: file.duration,
    bitrate: file.bitrate,
    path: file.path,
    filename: file.filename,
    streamCount: file.stream_count ?? streams.length,
    scannedAt: file.scanned_at,
    video: video
      ? {
          codec: video.codec,
          codecLong: video.codec_long,
          profile: video.profile,
          width: video.width,
          height: video.height,
          resolution: video.width && video.height ? `${video.width} × ${video.height}` : null,
          quality: qualityLabel(video.height),
          frameRate: video.frame_rate,
          bitrate: video.bitrate || file.video_bitrate,
          bitDepth: video.bit_depth,
          pixelFormat: file.pixel_format,
          colorSpace: file.color_space,
          colorTransfer: file.color_transfer,
          colorPrimaries: file.color_primaries,
          hdrFormat: file.hdr_format,
          aspectRatio: file.aspect_ratio,
        }
      : null,
    audio: streams
      .filter((s) => s.kind === 'audio')
      .map((s) => ({
        label: s.label,
        language: s.language,
        languageName: languageName(s.language),
        codec: s.codec,
        channels: s.channels,
        channelLabel: channelLabel(s.channels),
        channelLayout: s.channel_layout,
        sampleRate: s.sample_rate,
        bitrate: s.bitrate,
        isDefault: s.is_default === 1,
        isCommentary: s.is_commentary === 1,
      })),
    subtitles: streams
      .filter((s) => s.kind === 'subtitle')
      .map((s) => ({
        label: s.label,
        language: s.language,
        languageName: languageName(s.language),
        codec: s.codec,
        format: s.is_text === 1 ? 'Text' : 'Image',
        isDefault: s.is_default === 1,
        isForced: s.is_forced === 1,
        isHearingImpaired: s.is_hearing_impaired === 1,
      })),
  };
}

/**
 * ffprobe calls a .webm "matroska" because WebM is a Matroska subset — true,
 * and not what anyone looking at a technical panel expects to read about the
 * file they can see is called .webm.
 */
const CONTAINER_NAMES = {
  matroska: 'Matroska', webm: 'WebM', mov: 'MP4', mp4: 'MP4', avi: 'AVI',
  mpegts: 'MPEG-TS', asf: 'ASF', flv: 'FLV', ogg: 'Ogg',
};

function containerName(file) {
  const ext = (file.extension || '').replace('.', '').toLowerCase();
  if (ext === 'webm') return 'WebM';
  if (ext === 'mkv') return 'Matroska';
  const raw = (file.container || ext || '').toLowerCase();
  return CONTAINER_NAMES[raw] || raw.toUpperCase() || null;
}

/**
 * The label people recognise, and the real height when there isn't one.
 * Rounding a 540-line file up to "576p" would be claiming something about
 * the file that isn't true.
 */
export function qualityLabel(height) {
  if (!height) return null;
  if (height >= 2000) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 400) return `${height}p`;
  return 'SD';
}

/**
 * How a version of a title is described in a picker when there's more than
 * one of it — "4K HDR · HEVC · 12.4 GB". Built from what the file actually
 * is, so two versions never end up with the same label unless they really
 * are the same.
 */
export function versionLabel(file) {
  const parts = [];
  const quality = qualityLabel(file.height);
  if (quality) parts.push(quality);
  if (file.hdr_format) parts.push(file.hdr_format);
  if (file.video_codec) parts.push(file.video_codec.toUpperCase());
  if (file.audio_codec && !file.hdr_format) parts.push(file.audio_codec.toUpperCase());
  if (!parts.length && file.filename) return file.filename;
  return parts.join(' · ');
}
