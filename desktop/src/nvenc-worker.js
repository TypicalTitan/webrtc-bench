/**
 * WebRTC sender transform for the cloud-gaming profile's NVENC sender.
 *
 * wbsend.exe captures and encodes with NVENC (about 2 ms at 1080p) and hands each access unit to
 * the main process, which posts it here on a MessagePort. For every frame that arrives the page
 * pushes a tiny placeholder picture through Chromium's WebRTC sender; when that placeholder comes
 * out of Chromium's encoder this transform swaps in the NVENC frame (plus the timing SEI). So the
 * TV gets a standard WebRTC stream (RTP packetization, pacing, congestion control, NACK and SRTP
 * all done by Chromium) of real NVENC frames, without Chromium's capture and encode latency.
 *
 * Placeholders are send slots, pushed at 240/s regardless of the NVENC frames: each frame rides
 * the next slot that comes out of Chromium's encoder (at most ~4 ms later) and slots with nothing
 * to carry are dropped. Waiting for a per-frame placeholder would add Chromium's capture ->
 * encode pipeline (20-30 ms) back in. If frames still pile up, the backlog is dropped and wbsend
 * asked for a keyframe. A keyframe request from the TV (a placeholder keyframe) is forwarded to
 * wbsend as "idr".
 */
const UUID = new TextEncoder().encode('WebRTCBenchSEI01');

let hevc = false;
let qpcToTv = null; // TV clock ms = wbsend QPC ms + qpcToTv
let qpcToEpoch = null; // epoch ms = QPC ms + qpcToEpoch
const queue = [];
let needKey = false;
let started = false;
let stat = { frames: 0, sent: 0, dropped: 0, idr: 0, received: 0, pipeSum: 0, pipeN: 0 };

self.onmessage = (e) => {
  const m = e.data;
  if (m?.t === 'port') {
    m.port.onmessage = (ev) => onAu(ev.data);
    m.port.start?.();
  } else if (m?.t === 'config') {
    qpcToTv = m.qpcToTv;
    qpcToEpoch = m.qpcToEpoch;
  } else if (m?.t === 'stats') {
    self.postMessage({ t: 'stats', frames: stat.frames, tagged: stat.sent, dropped: stat.dropped, idrRequests: stat.idr, queued: queue.length, received: stat.received, captureToEncodedMs: stat.pipeN ? stat.pipeSum / stat.pipeN : null, mapped: true });
    stat = { frames: 0, sent: 0, dropped: 0, idr: 0, received: 0, pipeSum: 0, pipeN: 0 };
  }
};

function onAu(au) {
  stat.received++;
  queue.push(au);
  if (queue.length > 3) {
    // No slots came out for a while: drop the backlog and restart from a keyframe.
    stat.dropped += queue.length;
    queue.length = 0;
    requestKey();
  }
}

function requestKey() {
  if (needKey) return;
  needKey = true;
  stat.idr++;
  self.postMessage({ t: 'idr' });
}

self.onrtctransform = (event) => {
  const { readable, writable, options } = event.transformer;
  hevc = options?.codec === 'H265';
  readable.pipeThrough(new TransformStream({ transform: onFrame })).pipeTo(writable).catch(() => {});
};

function onFrame(frame, ctl) {
  stat.frames++;
  if (frame.type === 'key' && started) requestKey(); // the TV asked for a keyframe
  started = true;
  let au = queue.shift();
  while (au && needKey && !au.key) {
    stat.dropped++;
    au = queue.shift();
  }
  if (!au) {
    // Nothing to carry. Pass the slot on empty rather than dropping it: Chromium's hardware
    // H.265 encoder only gets its output buffers back from frames that go through, and stalls
    // after a few dropped ones.
    frame.data = new ArrayBuffer(0);
    ctl.enqueue(frame);
    return;
  }
  if (au.key) needKey = false;
  let data = au.data;
  if (qpcToTv != null && Number.isFinite(au.captureQpcMs)) {
    data = withSei(data, au.n, au.captureQpcMs + qpcToTv, au.captureQpcMs);
    if (qpcToEpoch != null) {
      stat.pipeSum += performance.timeOrigin + performance.now() - (au.captureQpcMs + qpcToEpoch);
      stat.pipeN++;
    }
  }
  frame.data = data.buffer.byteLength === data.byteLength ? data.buffer : data.slice().buffer;
  stat.sent++;
  ctl.enqueue(frame);
}

function withSei(u, n, captureTvMs, captureLocalMs) {
  const at = firstVclStart(u);
  if (at < 0) return u;
  const sei = makeSei(n, captureTvMs, captureLocalMs);
  const out = new Uint8Array(u.length + sei.length);
  out.set(u.subarray(0, at), 0);
  out.set(sei, at);
  out.set(u.subarray(at), at + sei.length);
  return out;
}

/** Offset of the start code (including a leading zero byte) of the first picture NAL. */
function firstVclStart(u) {
  for (let i = 0; i + 4 < u.length; i++) {
    if (u[i] !== 0 || u[i + 1] !== 0 || u[i + 2] !== 1) continue;
    const type = hevc ? (u[i + 3] >> 1) & 0x3f : u[i + 3] & 0x1f;
    const vcl = hevc ? type <= 31 : type >= 1 && type <= 5;
    if (vcl) return i > 0 && u[i - 1] === 0 ? i - 1 : i;
  }
  return -1;
}

/** User-data-unregistered SEI NAL (Annex B), same layout as wbsend.exe and sei-worker.js. */
function makeSei(frameNo, captureTvMs, captureLocalMs) {
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
