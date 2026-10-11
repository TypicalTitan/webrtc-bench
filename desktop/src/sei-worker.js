/**
 * Encoded-frame transform for the WebRTC sender (RTCRtpScriptTransform worker).
 *
 * Tags every H.264 / H.265 frame with the same user-data SEI wbsend.exe uses: frame number plus
 * the capture time on the TV's clock, so the TV can time each frame itself (decoded and, where
 * Android reports it, shown on screen) without reading pixels back.
 *
 * Chromium does not expose capture times on encoded frames, so frames are matched to captures
 * through the RTP timestamp: rtp/90 - captureTime is a constant per stream (90 kHz clock and a
 * random offset). With evenly spaced frames every whole-frame shift of that constant fits equally
 * well, so the source pauses once during warm-up (an "anchor" capture follows a 100 ms gap): the
 * encoded frame after the matching gap in RTP time is that capture, which fixes the constant.
 * After that each frame maps to the capture within half a frame interval of it; dropped frames
 * simply have no match. Also reports capture -> encoded time on the PC.
 */
const UUID = new TextEncoder().encode('WebRTCBenchSEI01');

let captures = []; // { n, t } t = epoch ms (performance.timeOrigin + now) at capture
let tvOffset = null; // tv clock = t + tvOffset
let intervalMs = 1000 / 60;
let offset = null; // rtp/90 - t
let anchor = null; // pending anchor capture { n, t, gapMs }
let prevRtpMs = null;
let rtpBase = null;
let rtpWraps = 0;
let lastRtp = null;
let stat = { frames: 0, tagged: 0, encSum: 0, encN: 0 };

const now = () => performance.timeOrigin + performance.now();

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'capture') {
    captures.push({ n: m.n, t: m.at });
    if (captures.length > 240) captures.shift();
    if (m.anchorGapMs) anchor = { n: m.n, t: m.at, gapMs: m.anchorGapMs };
  } else if (m.t === 'config') {
    if (m.tvOffset != null) tvOffset = m.tvOffset;
    if (m.fps) intervalMs = 1000 / m.fps;
  } else if (m.t === 'stats') {
    self.postMessage({ t: 'stats', frames: stat.frames, tagged: stat.tagged, captureToEncodedMs: stat.encN ? stat.encSum / stat.encN : null, mapped: offset != null });
    stat = { frames: 0, tagged: 0, encSum: 0, encN: 0 };
  }
};

self.onrtctransform = (event) => {
  const { readable, writable, options } = event.transformer;
  const hevc = options?.codec === 'H265';
  readable.pipeThrough(new TransformStream({ transform: (frame, ctl) => ctl.enqueue(onFrame(frame, hevc)) })).pipeTo(writable).catch(() => {});
};

/** Unwrapped RTP time in ms (90 kHz clock). */
function rtpMs(rtp) {
  if (lastRtp != null && rtp < lastRtp && lastRtp - rtp > 0x80000000) rtpWraps++;
  lastRtp = rtp;
  if (rtpBase == null) rtpBase = rtp;
  return (rtp - rtpBase + rtpWraps * 0x100000000) / 90;
}

function onFrame(frame, hevc) {
  const out = now();
  stat.frames++;
  const meta = frame.getMetadata();
  const r = rtpMs(meta.rtpTimestamp ?? frame.timestamp);
  const gap = prevRtpMs == null ? 0 : r - prevRtpMs;
  prevRtpMs = r;
  if (anchor && gap > anchor.gapMs * 0.6) {
    offset = r - anchor.t; // this encoded frame is the anchor capture
    anchor = null;
  }
  if (offset == null) return frame;
  let match = null;
  for (const c of captures) {
    const err = r - c.t - offset;
    if (!match || Math.abs(err) < Math.abs(match.err)) match = { c, err };
  }
  if (!match || Math.abs(match.err) > intervalMs * 0.45) return frame;
  offset += 0.02 * match.err; // follow slow drift between the two clocks
  const { c } = match;
  stat.encSum += out - c.t;
  stat.encN++;
  if (tvOffset == null) return frame;
  const sei = makeSei(c.n, c.t + tvOffset, c.t, hevc);
  const data = new Uint8Array(frame.data);
  const at = firstVclStart(data, hevc);
  if (at < 0) return frame;
  const tagged = new Uint8Array(data.length + sei.length);
  tagged.set(data.subarray(0, at), 0);
  tagged.set(sei, at);
  tagged.set(data.subarray(at), at + sei.length);
  frame.data = tagged.buffer;
  stat.tagged++;
  return frame;
}

/** Offset of the start code (including a leading zero byte) of the first picture NAL. */
function firstVclStart(u, hevc) {
  for (let i = 0; i + 4 < u.length; i++) {
    if (u[i] !== 0 || u[i + 1] !== 0 || u[i + 2] !== 1) continue;
    const type = hevc ? (u[i + 3] >> 1) & 0x3f : u[i + 3] & 0x1f;
    const vcl = hevc ? type <= 31 : type >= 1 && type <= 5;
    if (vcl) return i > 0 && u[i - 1] === 0 ? i - 1 : i;
  }
  return -1;
}

/** User-data-unregistered SEI NAL (Annex B), same payload layout as wbsend.exe. */
function makeSei(frameNo, captureTvMs, captureLocalMs, hevc) {
  const p = new Uint8Array(36);
  const dv = new DataView(p.buffer);
  p.set(UUID, 0);
  dv.setUint32(16, frameNo >>> 0);
  dv.setFloat64(20, captureTvMs);
  dv.setFloat64(28, captureLocalMs);
  const header = hevc ? [39 << 1, 1] : [6];
  const raw = [...header, 5, 36, ...p, 0x80];
  const body = [];
  let zeros = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i];
    if (i >= header.length && zeros >= 2 && x <= 3) {
      body.push(3); // emulation prevention
      zeros = 0;
    }
    body.push(x);
    zeros = x === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array([0, 0, 0, 1, ...body]);
}
