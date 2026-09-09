import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * The transcoding pipeline: deciding what a device can actually play, and
 * getting it something it can.
 *
 * Three outcomes, cheapest first:
 *   direct    — hand over the file, the browser opens it as-is
 *   remux     — repackage into fragmented mp4, copying both streams untouched
 *   transcode — actually re-encode, because a codec or bitrate is out of reach
 *
 * Choosing remux over transcode wherever possible is the difference between
 * a NAS idling and a NAS pinned at 100% — the video stream is copied, not
 * re-compressed, so it costs almost nothing.
 */

/** Codecs a browser can decode natively, by container it can also demux. */
const BROWSER_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const BROWSER_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

/**
 * Hardware encoders worth trying, best first. Each is verified by actually
 * encoding a frame before it gets used — an encoder can be compiled into
 * ffmpeg and still fail on a machine with no such hardware, and finding that
 * out mid-playback means a black screen.
 */
const HW_ENCODERS = [
  { name: 'h264_nvenc', label: 'NVIDIA NVENC', extraArgs: ['-preset', 'p4', '-tune', 'hq'] },
  { name: 'h264_qsv', label: 'Intel Quick Sync', extraArgs: ['-preset', 'faster'] },
  { name: 'h264_vaapi', label: 'VAAPI', extraArgs: [], needsVaapiDevice: true },
  { name: 'h264_videotoolbox', label: 'Apple VideoToolbox', extraArgs: [] },
  { name: 'h264_v4l2m2m', label: 'V4L2 (Raspberry Pi)', extraArgs: [] },
];

let hardwareProbe = null;

/**
 * What this machine can encode with, verified rather than assumed. Probed
 * once and remembered — the answer can't change without restarting ffmpeg.
 */
export async function detectHardware() {
  if (hardwareProbe) return hardwareProbe;
  hardwareProbe = (async () => {
    if (!config.ffmpeg.enabled) return { available: false, encoder: null, label: 'Transcoding disabled', candidates: [] };
    if (config.ffmpeg.hwaccel === 'off') {
      return { available: false, encoder: null, label: 'Disabled in configuration', candidates: [] };
    }

    let encoders = '';
    try {
      const { stdout } = await execFileAsync(config.ffmpeg.bin, ['-hide_banner', '-encoders'], { timeout: 15000 });
      encoders = stdout;
    } catch {
      return { available: false, encoder: null, label: 'ffmpeg not available', candidates: [] };
    }

    const compiled = HW_ENCODERS.filter((e) => encoders.includes(e.name));
    const wanted = config.ffmpeg.hwaccel === 'auto' ? compiled : compiled.filter((e) => e.name === config.ffmpeg.hwaccel);

    for (const candidate of wanted) {
      if (await encoderWorks(candidate)) {
        return {
          available: true,
          encoder: candidate.name,
          label: candidate.label,
          extraArgs: candidate.extraArgs,
          candidates: compiled.map((c) => c.name),
        };
      }
    }

    return {
      available: false,
      encoder: null,
      label: compiled.length ? 'No working hardware encoder' : 'No hardware encoder compiled in',
      candidates: compiled.map((c) => c.name),
    };
  })();
  return hardwareProbe;
}

/** Encode one frame of a test pattern. Cheap, and it either works or it doesn't. */
function encoderWorks(candidate) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(candidate.needsVaapiDevice ? ['-vaapi_device', '/dev/dri/renderD128'] : []),
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=0.1',
      ...(candidate.needsVaapiDevice ? ['-vf', 'format=nv12,hwupload'] : []),
      '-c:v', candidate.name, '-frames:v', '1', '-f', 'null', '-',
    ];
    const ff = spawn(config.ffmpeg.bin, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { ff.kill('SIGKILL'); resolve(false); }, 12000);
    ff.on('error', () => { clearTimeout(timer); resolve(false); });
    ff.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/**
 * Can this device play this file untouched, and if not, how little work will
 * do? `capabilities` is what the client said it supports — a Fire TV WebView
 * and desktop Chrome genuinely differ here.
 */
export function decidePlayback(file, capabilities = {}, options = {}) {
  const reasons = [];
  const videoCodec = (file.video_codec || '').toLowerCase();
  const audioCodec = (file.audio_codec || '').toLowerCase();

  const supportedVideo = capabilities.videoCodecs?.length ? capabilities.videoCodecs : BROWSER_VIDEO;
  const supportedAudio = capabilities.audioCodecs?.length ? capabilities.audioCodecs : BROWSER_AUDIO;

  const videoOk = !videoCodec || supportedVideo.includes(videoCodec);
  const audioOk = !audioCodec || supportedAudio.includes(audioCodec);
  const containerOk = file.direct_play === 1;

  if (!videoOk) reasons.push(`${videoCodec.toUpperCase()} video is not supported by this device`);
  if (!audioOk) reasons.push(`${audioCodec.toUpperCase()} audio is not supported by this device`);
  if (!containerOk && videoOk && audioOk) reasons.push(`${(file.container || file.extension || '').replace('.', '')} containers need repackaging`);

  // A quality cap or a burned-in subtitle forces a real encode no matter how
  // playable the file is on its own.
  const maxHeight = options.maxHeight || capabilities.maxHeight || 0;
  const maxBitrate = options.maxBitrate || capabilities.maxBitrate || 0;
  const overResolution = maxHeight > 0 && file.height > maxHeight;
  const overBitrate = maxBitrate > 0 && file.bitrate > maxBitrate;
  if (overResolution) reasons.push(`Limited to ${maxHeight}p by playback settings`);
  if (overBitrate) reasons.push(`Limited to ${Math.round(maxBitrate / 1000)}kbps by playback settings`);
  if (options.burnSubtitle != null) reasons.push('A picture-based subtitle track has to be burned in');

  const needsVideoEncode = !videoOk || overResolution || overBitrate || options.burnSubtitle != null;

  let method = 'direct';
  if (needsVideoEncode) method = 'transcode';
  else if (!containerOk || !audioOk || options.audioTrack != null) method = 'remux';

  return {
    method,
    reasons,
    needsVideoEncode,
    needsAudioEncode: !audioOk,
    targetHeight: overResolution ? maxHeight : file.height || null,
    targetBitrate: overBitrate ? maxBitrate : null,
  };
}

/**
 * The ffmpeg command for a playback session. Video is copied unless the
 * decision above says it genuinely can't be.
 */
export async function buildArgs({ file, decision, startAt = 0, audioTrack = null, burnSubtitle = null }) {
  const hw = decision.needsVideoEncode ? await detectHardware() : { available: false };
  const args = ['-hide_banner', '-loglevel', 'error'];

  // Seeking before -i lets ffmpeg jump straight to a keyframe instead of
  // decoding everything up to that point and throwing it away — except when
  // subtitles are being burned in. The subtitles filter reads timings from the
  // start of the file regardless of where the video was seeked to, so an input
  // seek would put every line minutes out of sync. Output seeking is slower to
  // start and correct, which is the right trade when the alternative is
  // subtitles that don't match the picture.
  const burningIn = burnSubtitle != null;
  if (startAt > 0 && !burningIn) args.push('-ss', String(startAt));

  if (hw.available && hw.encoder === 'h264_vaapi') args.push('-vaapi_device', '/dev/dri/renderD128');
  args.push('-i', file.path);
  if (startAt > 0 && burningIn) args.push('-ss', String(startAt));

  // Stream selection. A burned-in subtitle rules out -map for video because
  // the filter chain produces the video stream instead.
  args.push('-map', '0:v:0');
  args.push('-map', audioTrack != null ? `0:a:${audioTrack}` : '0:a:0?');

  if (decision.needsVideoEncode) {
    const filters = [];
    if (burnSubtitle != null) {
      // ffmpeg's subtitles filter wants the path escaped for its own parser.
      filters.push(`subtitles=${escapeFilterPath(file.path)}:si=${burnSubtitle}`);
    }
    if (decision.targetHeight && file.height && decision.targetHeight < file.height) {
      filters.push(`scale=-2:${decision.targetHeight}`);
    }

    const isVaapi = hw.available && hw.encoder === 'h264_vaapi';
    if (isVaapi) filters.push('format=nv12', 'hwupload');
    if (filters.length) args.push('-vf', filters.join(','));

    if (hw.available) {
      args.push('-c:v', hw.encoder, ...(hw.extraArgs || []));
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.1');
    }

    // H.264 High profile is an 8-bit format, so a 10-bit source — every 4K HDR
    // release and a great deal of anime — fails outright without this
    // ("high profile doesn't support a bit depth of 10"). Converting down is
    // not a loss here: no browser decodes High10 h264 either, so 8-bit is the
    // only thing that was ever going to play. VAAPI is excluded because its
    // filter chain has already converted to nv12 on the GPU.
    if (!isVaapi) args.push('-pix_fmt', 'yuv420p');
    if (decision.targetBitrate) {
      args.push('-b:v', String(decision.targetBitrate), '-maxrate', String(decision.targetBitrate), '-bufsize', String(decision.targetBitrate * 2));
    }
  } else {
    args.push('-c:v', 'copy');
  }

  // Audio gets copied whenever the browser can decode it as-is. Re-encoding
  // an AAC 5.1 track down to stereo just to repackage the container throws
  // away the surround mix for no reason — the browser downmixes on playback
  // if the output device needs it.
  const audioCodec = (file.audio_codec || '').toLowerCase();
  if (BROWSER_AUDIO.includes(audioCodec)) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  }
  args.push('-sn');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return { args, hardware: hw };
}

/**
 * ffmpeg parses the filter graph as its own mini-language, so a Windows drive
 * letter or a comma in a folder name would otherwise end the argument early.
 */
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

export { BROWSER_VIDEO, BROWSER_AUDIO };
