export const CODECS = ['H264', 'VP8', 'VP9', 'AV1', 'H265'];
export const CODEC_LABEL = { H264: 'H.264', H265: 'H.265', VP8: 'VP8', VP9: 'VP9', AV1: 'AV1' };
export const CODEC_MIME = { VP8: 'video/VP8', VP9: 'video/VP9', H264: 'video/H264', AV1: 'video/AV1', H265: 'video/H265' };

export const RESOLUTIONS = [720, 1080, 1440, 2160];
export const RES_W = { 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 };
export const FPS_OPTIONS = [30, 60];

export const DECODER_MODES = {
  auto: { label: 'Auto', help: 'Hardware decoder, software fallback (what a normal app does)' },
  hw: { label: 'Hardware only', help: 'MediaCodec hardware decoders only' },
  sw: { label: 'Software only', help: 'libvpx / dav1d on the TV CPU' },
};

export const RENDER_MODES = {
  native: { label: 'Full-res', help: 'TV draws into a surface at the stream resolution (true 4K output)' },
  scaled: { label: 'Display-res', help: 'TV draws into a surface at its UI resolution; the GPU downscales while drawing' },
  none: { label: 'Decode only', help: 'Frames are decoded but not drawn: pure decoder throughput' },
};

/**
 * Chromium hardware-encodes H.264 Baseline/High but only software-encodes Constrained
 * Baseline, the one profile Android's WebRTC decoder factory advertises. For the GPU
 * profiles the TV is told "Constrained Baseline" and the PC is told the real profile;
 * MediaCodec decodes either.
 */
export const H264_PROFILES = {
  baseline: { label: 'Baseline · GPU', prefix: '4200', help: 'Encoded on the PC GPU; signalled to the TV as Constrained Baseline' },
  high: { label: 'High · GPU', prefix: '6400', help: 'Encoded on the PC GPU with CABAC/8x8; heavier to decode' },
  cb: { label: 'Constrained Baseline · CPU', prefix: '42e0', help: 'Strict negotiation; Chromium encodes it in software (OpenH264)' },
};

export const TRANSPORTS = {
  webrtc: { label: 'WebRTC', short: 'WebRTC', help: 'Chromium WebRTC sender → Android WebRTC receiver' },
  native: { label: 'Native NVENC', short: 'Native', help: 'wbsend.exe (NVENC, RTP/UDP, no pacer) → TV low-latency MediaCodec decoder' },
};
export const NATIVE_CODECS = ['H264', 'H265'];

export const PLAYOUT_MODES = {
  standard: { label: 'Adaptive', help: 'WebRTC default: the TV jitter buffer grows with network jitter for smooth playback' },
  low: { label: 'Low latency', help: 'Playout delay forced to 0 on the TV: frames are shown as soon as they decode (cloud-gaming style)' },
};

/**
 * WebRTC latency profile. "gaming" is what a cloud-gaming client wants: frames pushed straight
 * into the track, libwebrtc's pacer loosened (needs an app restart, it is a launch-time field
 * trial), playout delay 0 on the TV, and H.264/H.265 decoded by the low-latency MediaCodec
 * decoder straight onto the screen instead of through WebRTC's texture renderer.
 */
export const LATENCY_PROFILES = {
  standard: { label: 'Standard', help: 'WebRTC as a browser or a stock Android app ships it' },
  gaming: { label: 'Cloud gaming', help: 'Push frames straight to the encoder, loose pacer, zero playout delay, low-latency decoder straight to the screen' },
};

export const PACING_MODES = {
  vsync: { label: 'Vsync-locked', help: "Native: the TV steers the PC's frame clock so each frame is ready just before the display picks it up (less waiting, no doubled or skipped frames)" },
  off: { label: 'Free-running', help: "Native: the PC sends on its own clock; each frame waits a random part of a refresh on the TV" },
};

export const BITRATE_PRESETS = {
  low: { label: 'Low', mult: 0.5 },
  normal: { label: 'Normal', mult: 1 },
  high: { label: 'High', mult: 2 },
};

const BASE_KBPS = { 720: 4000, 1080: 8000, 1440: 14000, 2160: 25000 };

export function kbpsFor(height, fps, preset) {
  return Math.round(BASE_KBPS[height] * (fps > 30 ? 1.5 : 1) * (BITRATE_PRESETS[preset]?.mult ?? 1));
}

export const DEFAULT_SETTINGS = {
  video: 'bbb-2160p60',
  codecs: ['H264', 'VP8', 'VP9', 'AV1', 'H265'],
  resolutions: [720, 1080, 1440, 2160],
  fpsList: [30, 60],
  decoder: 'auto',
  bitrate: 'normal',
  warmupSec: 5,
  measureSec: 10,
  pipeline: 'canvas',
  tvOverlay: true,
  render: 'native',
  h264Profile: 'baseline',
  adbTelemetry: true,
  playout: 'standard',
  measureLatency: true,
  transports: ['webrtc'],
  pacing: 'vsync',
  latencyProfile: 'standard',
  gamingSender: 'nvenc', // cloud gaming: 'nvenc' = wbsend encodes, WebRTC carries; 'chromium' = Chromium encodes
  nvencPreset: 1,
  nativeOpts: '',
  senderArgs: '',
};

export const PRESETS = {
  quick: { label: 'Quick', codecs: ['H264', 'VP9'], resolutions: [1080, 2160], fpsList: [60], warmupSec: 3, measureSec: 6 },
  full: { label: 'Full', codecs: ['H264', 'VP8', 'VP9', 'AV1', 'H265'], resolutions: [720, 1080, 1440, 2160], fpsList: [30, 60], warmupSec: 5, measureSec: 10 },
};

/** Seconds of signaling + teardown added to each test on top of warm-up and measurement. */
export const PER_TEST_OVERHEAD_SEC = 3;
