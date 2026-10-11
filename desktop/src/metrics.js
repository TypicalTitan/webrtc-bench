const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const avg = (arr) => {
  const v = arr.map(num).filter((x) => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const max = (arr) => {
  const v = arr.map(num).filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};
const min = (arr) => {
  const v = arr.map(num).filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};
const mode = (arr) => {
  const counts = new Map();
  for (const x of arr) if (x != null) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
};
const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const delta = (a, b, k) => {
  const x = num(a?.[k]);
  const y = num(b?.[k]);
  return x == null || y == null ? null : y - x;
};
const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b);

const SW_DECODERS = /^(libvpx|dav1d|libaom|ffmpeg|openh264|c2\.android|omx\.google)/i;

export function guessHw(impl, flag) {
  if (typeof flag === 'boolean') return flag;
  if (!impl) return null;
  if (SW_DECODERS.test(impl)) return false;
  if (/^(c2\.|omx\.)/i.test(impl) || /mediacodec|nvenc|mediafoundation|d3d11|vaapi|qsv|amf/i.test(impl)) return true;
  return null;
}

// Chrome stats timestamps are milliseconds; the Android SDK reports microseconds.
const txSeconds = (a, b) => (delta(a, b, 'timestamp') ?? 0) / 1000;
const rxSeconds = (a, b) => (delta(a, b, 'timestamp') ?? 0) / 1e6;

function txSummary(a, b, all) {
  const dt = txSeconds(a.out, b.out) || (b.at - a.at) / 1000;
  const d = (k) => delta(a.out, b.out, k);
  const encoded = d('framesEncoded');
  const rtt = avg(all.map((s) => s.pair?.currentRoundTripTime));
  return {
    encoder: b.out.encoderImplementation ?? null,
    encoderHw: guessHw(b.out.encoderImplementation, b.out.powerEfficientEncoder),
    width: b.out.frameWidth ?? null,
    height: b.out.frameHeight ?? null,
    fps: ratio(d('framesSent'), dt),
    encodedFps: ratio(encoded, dt),
    kbps: ratio(d('bytesSent') * 8, dt * 1000),
    targetKbps: avg(all.map((s) => s.out.targetBitrate)) != null ? avg(all.map((s) => s.out.targetBitrate)) / 1000 : null,
    encodeMs: encoded > 0 ? (d('totalEncodeTime') / encoded) * 1000 : null,
    qualityLimitation: mode(all.map((s) => s.out.qualityLimitationReason)),
    sourceFps: avg(all.map((s) => s.src?.framesPerSecond)),
    packetSendDelayMs: d('packetsSent') > 0 ? (d('totalPacketSendDelay') / d('packetsSent')) * 1000 : null,
    keyframes: d('keyFramesEncoded'),
    nack: d('nackCount'),
    pli: d('pliCount'),
    rttMs: rtt != null ? rtt * 1000 : null,
    network: b.pair?.localNetwork ?? null,
    codecMime: b.codec?.mimeType ?? null,
    fmtp: b.codec?.sdpFmtpLine ?? null,
  };
}

function rxSummary(a, b, all) {
  const A = a.inbound;
  const B = b.inbound;
  const dt = rxSeconds(A, B) || (b.at - a.at) / 1000;
  const d = (k) => delta(A, B, k);
  const dec = d('framesDecoded');
  const ifd = d('totalInterFrameDelay');
  const ifd2 = d('totalSquaredInterFrameDelay');
  const lost = d('packetsLost') ?? 0;
  const recv = d('packetsReceived') ?? 0;
  const jbN = d('jitterBufferEmittedCount');
  const rtt = avg(all.map((s) => s.pair?.currentRoundTripTime));
  const sinkA = a.sink?.frames;
  const sinkB = b.sink?.frames;
  return {
    decoder: B.decoderImplementation ?? null,
    decoderHw: guessHw(B.decoderImplementation, B.powerEfficientDecoder),
    width: B.frameWidth ?? null,
    height: B.frameHeight ?? null,
    fps: ratio(dec, dt),
    receivedFps: ratio(d('framesReceived'), dt),
    renderedFps: sinkA != null && sinkB != null ? (sinkB - sinkA) / dt : null,
    kbps: ratio(d('bytesReceived') * 8, dt * 1000),
    decodeMs: dec > 0 && d('totalDecodeTime') != null ? (d('totalDecodeTime') / dec) * 1000 : null,
    processingMs: dec > 0 && d('totalProcessingDelay') != null ? (d('totalProcessingDelay') / dec) * 1000 : null,
    jitterBufferMs: jbN > 0 ? (d('jitterBufferDelay') / jbN) * 1000 : null,
    frameIntervalStdMs: dec > 1 && ifd != null && ifd2 != null ? Math.sqrt(Math.max(0, ifd2 / dec - (ifd / dec) ** 2)) * 1000 : null,
    dropped: d('framesDropped'),
    droppedPct: d('framesReceived') > 0 ? (100 * (d('framesDropped') ?? 0)) / d('framesReceived') : 0,
    freezes: d('freezeCount'),
    freezeMs: d('totalFreezesDuration') != null ? d('totalFreezesDuration') * 1000 : null,
    lossPct: lost + recv > 0 ? (100 * lost) / (lost + recv) : 0,
    nack: d('nackCount'),
    pli: d('pliCount'),
    keyframes: d('keyFramesDecoded'),
    qpAvg: dec > 0 && d('qpSum') != null ? d('qpSum') / dec : null,
    appCpuPct: avg(all.map((s) => s.sys?.appCpuPct)),
    thermal: max(all.map((s) => s.sys?.thermalStatus)),
    availMemMb: min(all.map((s) => s.sys?.availMemMb)),
    wifiRssi: avg(all.map((s) => s.sys?.wifiRssi)),
    wifiLinkMbps: avg(all.map((s) => s.sys?.wifiLinkMbps)),
    transport: b.sys?.transport ?? null,
    rttMs: rtt != null ? rtt * 1000 : null,
    codecMime: b.codec?.mimeType ?? null,
    fmtp: b.codec?.sdpFmtpLine ?? null,
  };
}

const fmt = (v, d = 1) => (v == null ? '?' : Number(v).toFixed(d));

/** Turns one test's raw samples into a verdict plus the numbers the report shows. */
export function summarize(c, { tx, rx, adb, lat = [], latProbe = [], dlat = [], slat = [], seiStats = [], clock = null, t0, t1, error, unsupported, aborted, txPatch = null }) {
  const r = {
    index: c.index,
    label: c.label,
    transport: c.transport,
    codec: c.codec,
    width: c.width,
    height: c.height,
    fps: c.fps,
    bitrateKbps: c.bitrateKbps,
    decoderMode: c.decoderMode,
    status: 'FAIL',
    notes: '',
    tx: null,
    rx: null,
    adb: null,
    latency: null,
  };
  if (unsupported) {
    r.status = 'UNSUPPORTED';
    r.notes = unsupported;
    return r;
  }
  const inWindow = (s) => s.at >= t0 && s.at <= t1;
  const txIn = tx.filter((s) => s.out && inWindow(s));
  const rxIn = rx.filter((s) => s.inbound && inWindow(s));
  if (txIn.length >= 2) r.tx = txSummary(txIn[0], txIn[txIn.length - 1], txIn);
  if (r.tx && txPatch) for (const [k, v] of Object.entries(txPatch)) if (v != null) r.tx[k] = v;
  if (rxIn.length >= 2) r.rx = rxSummary(rxIn[0], rxIn[rxIn.length - 1], rxIn);
  r.latency = latencySummary(lat.filter(inWindow), clock?.rtt);
  r.displayLatency = latencySummary(dlat.filter(inWindow), clock?.rtt);
  // Screen probe (PC screen -> TV screen, pattern mirrored by the display source).
  const sIn = slat.filter(inWindow);
  r.screenLatency = latencySummary(sIn, clock?.rtt);
  if (r.screenLatency && t1 > t0) r.screenLatency.shownFps = sIn.length / ((t1 - t0) / 1000);
  // Frame-code probe kept alongside SEI timing (validation): capture -> frame reached the renderer.
  if (latProbe.length && latProbe !== lat) r.latencyProbe = latencySummary(latProbe.filter(inWindow), clock?.rtt);
  const sei = seiStats.filter(inWindow);
  if (r.tx && sei.length) {
    r.tx.captureToEncodedMs = avg(sei.map((s) => s.captureToEncodedMs));
    r.tx.seiTagged = sum(sei.map((s) => s.tagged));
  }
  // TV-side frame timing (SEI): direct decoder, frames shown, repeated refreshes.
  const tim = rxIn.map((s) => s.timing).filter(Boolean);
  if (r.rx && tim.length) {
    const n = tim.length;
    r.rx.direct = tim.some((t) => t.direct);
    if (r.rx.direct) r.rx.renderedFps = sum(tim.map((t) => t.decodedCount)) / n;
    const pacing = tim[tim.length - 1].pacing;
    if (pacing) {
      r.rx.pacing = pacing.state;
      r.rx.pacingLeadMs = pacing.leadMs ?? null;
      r.rx.pacingSlackMs = pacing.slackLowMs ?? null;
      r.rx.pacingNote = pacing.note || null;
    }
    if (tim.some((t) => t.displayValid)) {
      r.rx.displayedFps = sum(tim.map((t) => t.shown)) / n;
      r.rx.renderedFps = r.rx.displayedFps;
      r.rx.repeats = sum(tim.map((t) => t.repeats));
      r.rx.displayDropped = sum(tim.map((t) => t.replaced));
    }
  }
  r.adb = adbSummary(adb.filter(inWindow));
  applyVerdict(c, r, { error, aborted, lastDecoder: rx[rx.length - 1]?.inbound?.decoderImplementation });
  return r;
}

/** Capture on the PC -> decoded frame handed to the TV's renderer (excludes TV display delay). */
function latencySummary(samples, syncRttMs, captureDelayMs = null) {
  const v = samples.map((s) => s.ms).sort((a, b) => a - b);
  if (!v.length) return null;
  // Mirroring mode: how much of the latency is the screen-capture pipeline before encoding.
  const cd = samples.map((s) => s.captureDelay).filter((x) => num(x) != null).sort((a, b) => a - b);
  return {
    median: percentile(v, 0.5),
    p95: percentile(v, 0.95),
    min: v[0],
    max: v[v.length - 1],
    mean: avg(v),
    samples: v.length,
    syncRttMs: syncRttMs ?? null,
    captureDelayMs: cd.length ? percentile(cd, 0.5) : captureDelayMs,
  };
}

function adbSummary(samples) {
  const ok = samples.filter((s) => !s.error);
  if (!ok.length) return null;
  return {
    cpuPct: avg(ok.map((s) => s.cpuPct)),
    cpuMax: max(ok.map((s) => s.cpuPct)),
    socTempC: max(ok.map((s) => s.socTempC)),
  };
}

/** PASS / MARGINAL / FAIL / SENDER-LIMITED rules, shared by the WebRTC and native paths. */
function applyVerdict(c, r, { error, aborted, lastDecoder }) {
  const notes = [];
  if (error) {
    r.status = aborted ? 'ABORTED' : 'ERROR';
    notes.push(error);
  } else if (!r.rx || !(r.rx.fps > 0.5)) {
    r.status = 'FAIL';
    notes.push(r.rx ? 'No frames decoded' : 'No video statistics from the TV');
    if (lastDecoder) notes.push(`decoder ${lastDecoder}`);
  } else {
    const { rx: R, tx: T } = r;
    const txFull = T && T.fps >= c.fps * 0.9 && (T.height ?? 0) >= c.height * 0.98;
    const rxFull = (R.height ?? 0) >= c.height * 0.98;
    // Judge the TV against what the PC actually delivered, not the nominal target, so a
    // brief sender dip is not blamed on the decoder.
    const keep = R.fps / Math.min(c.fps, T?.fps || c.fps);
    if (!txFull) {
      // The PC fell short. If the TV still could not keep up with the reduced load it has
      // failed regardless; otherwise the test simply did not reach the TV's limit.
      r.status = keep < 0.8 ? 'FAIL' : 'SENDER-LIMITED';
      const why = T?.qualityLimitation && T.qualityLimitation !== 'none' ? ` (limited by ${T.qualityLimitation})` : '';
      notes.push(`PC sent ${T?.width ?? '?'}×${T?.height ?? '?'} @ ${fmt(T?.fps)} fps${why}`);
      if (T?.fps) {
        notes.push(R.fps >= T.fps * 0.95 ? 'TV kept up with everything sent' : `TV decoded ${Math.round((100 * R.fps) / T.fps)}% of sent frames`);
      }
    } else if (keep >= 0.95 && rxFull && !R.freezes && (R.droppedPct ?? 0) < 2) {
      r.status = 'PASS';
    } else if (keep >= 0.8 && rxFull) {
      r.status = 'MARGINAL';
    } else {
      r.status = 'FAIL';
    }
    if (txFull) {
      if (keep < 0.95) notes.push(`decoded ${fmt(R.fps)} of ${fmt(Math.min(c.fps, T?.fps || c.fps))} fps sent`);
      if (!rxFull) notes.push(`TV received ${R.width}×${R.height}`);
    }
    if (R.freezes) notes.push(`${R.freezes} freeze(s), ${fmt(R.freezeMs, 0)} ms`);
    if (R.dropped) notes.push(`${R.dropped} frames dropped`);
    if (R.lossPct > 0.5) notes.push(`${fmt(R.lossPct, 2)}% packet loss`);
  }
  r.notes = notes.join('; ');
}

const sum = (arr) => arr.map(num).filter((x) => x != null).reduce((s, x) => s + x, 0);

/**
 * Native path: wbsend prints per-second sender stats and the TV sends per-second receiver
 * deltas ("native-stats"), so the window summary is sums / averages of those seconds.
 */
export function summarizeNative(c, { tx, rx, adb, lat, dlat = [], ready, t0, t1, error, unsupported, aborted, renderMode }) {
  const r = {
    index: c.index,
    label: c.label,
    transport: c.transport,
    codec: c.codec,
    width: c.width,
    height: c.height,
    fps: c.fps,
    bitrateKbps: c.bitrateKbps,
    decoderMode: 'hw',
    status: 'FAIL',
    notes: '',
    tx: null,
    rx: null,
    adb: null,
    latency: null,
  };
  if (unsupported) {
    r.status = 'UNSUPPORTED';
    r.notes = unsupported;
    return r;
  }
  const inWindow = (s) => s.at >= t0 && s.at <= t1;
  const txIn = tx.filter(inWindow);
  const rxIn = rx.filter(inWindow);
  if (txIn.length) {
    r.tx = {
      encoder: ready?.encoder ?? 'NVENC native',
      encoderHw: true,
      width: ready?.width ?? c.width,
      height: ready?.height ?? c.height,
      fps: avg(txIn.map((s) => s.fps)),
      encodedFps: avg(txIn.map((s) => s.fps)),
      contentFps: avg(txIn.map((s) => s.contentFps)),
      kbps: avg(txIn.map((s) => s.kbps)),
      targetKbps: c.bitrateKbps,
      prepMs: avg(txIn.map((s) => s.prepMs)),
      encodeMs: avg(txIn.map((s) => s.encodeMs)),
      qualityLimitation: 'none',
      packetSendDelayMs: avg(txIn.map((s) => s.sendMs)),
      keyframes: sum(txIn.map((s) => s.keyframes)),
      rttMs: ready?.syncRttMs ?? null,
      network: 'UDP/RTP (native)',
      codecMime: c.codec === 'H265' ? 'video/H265' : 'video/H264',
      fmtp: ready?.encoder ?? null,
    };
  }
  if (rxIn.length) {
    const n = rxIn.length; // one sample per second
    const decoded = sum(rxIn.map((s) => s.decoded));
    const aus = sum(rxIn.map((s) => s.aus));
    const lost = sum(rxIn.map((s) => s.lost));
    const packets = sum(rxIn.map((s) => s.packets));
    const weighted = (k) => {
      const w = rxIn.filter((s) => num(s[k]) != null && s.decoded > 0);
      const total = sum(w.map((s) => s.decoded));
      return total ? sum(w.map((s) => s[k] * s.decoded)) / total : null;
    };
    const last = rxIn[rxIn.length - 1];
    // Display side (newer TV app): frames actually shown, frames replaced before a vsync, and
    // refreshes that repeated the previous frame because the next one was not ready.
    const shownKnown = rxIn.some((s) => s.displayed != null);
    const displayed = sum(rxIn.map((s) => s.displayed));
    const weightedShown = (k) => {
      const w = rxIn.filter((s) => num(s[k]) != null && s.displayed > 0);
      const total = sum(w.map((s) => s.displayed));
      return total ? sum(w.map((s) => s[k] * s.displayed)) / total : null;
    };
    r.rx = {
      decoder: last.decoder,
      decoderHw: true,
      width: last.width,
      height: last.height,
      fps: decoded / n,
      receivedFps: aus / n,
      renderedFps: renderMode === 'none' ? null : shownKnown ? displayed / n : decoded / n,
      displayedFps: shownKnown ? displayed / n : null,
      displayDropped: shownKnown ? sum(rxIn.map((s) => s.displayDropped)) : null,
      repeats: shownKnown ? sum(rxIn.map((s) => s.repeats)) : null,
      paceErrors: shownKnown ? sum(rxIn.map((s) => s.paceErrors)) : null,
      decodeToDisplayMs: shownKnown ? weightedShown('decodeToDisplayMs') : null,
      pacing: last.pacing?.state ?? null,
      pacingLeadMs: last.pacing?.leadMs ?? null,
      pacingSlackMs: last.pacing?.slackLowMs ?? null,
      pacingNote: last.pacing?.note || null,
      drains: sum(rx.map((s) => s.drains)),
      kbps: (sum(rxIn.map((s) => s.bytes)) * 8) / n / 1000,
      decodeMs: weighted('decodeMs'),
      processingMs: weighted('netToDecodedMs'),
      assembleMs: weighted('assembleMs'),
      jitterBufferMs: 0,
      frameIntervalStdMs: null,
      dropped: sum(rxIn.map((s) => s.dropped)),
      droppedPct: aus ? (100 * sum(rxIn.map((s) => s.dropped))) / aus : 0,
      freezes: sum(rxIn.map((s) => s.freezes)),
      freezeMs: sum(rxIn.map((s) => s.freezeMs)),
      lossPct: packets + lost > 0 ? (100 * lost) / (packets + lost) : 0,
      nack: null,
      pli: sum(rxIn.map((s) => s.keyRequests)),
      keyframes: sum(rxIn.map((s) => s.keyframes)),
      appCpuPct: avg(rxIn.map((s) => s.sys?.appCpuPct)),
      thermal: max(rxIn.map((s) => s.sys?.thermalStatus)),
      availMemMb: min(rxIn.map((s) => s.sys?.availMemMb)),
      wifiRssi: avg(rxIn.map((s) => s.sys?.wifiRssi)),
      wifiLinkMbps: avg(rxIn.map((s) => s.sys?.wifiLinkMbps)),
      transport: last.sys?.transport ?? null,
      rttMs: ready?.syncRttMs ?? null,
      codecMime: c.codec === 'H265' ? 'video/H265' : 'video/H264',
      fmtp: `MediaCodec ${last.decoder}`,
    };
  }
  r.latency = latencySummary(lat.filter(inWindow), ready?.syncRttMs, avg(txIn.map((s) => s.captureDelayMs)));
  r.displayLatency = latencySummary(dlat.filter(inWindow), ready?.syncRttMs);
  r.adb = adbSummary(adb.filter(inWindow));
  applyVerdict(c, r, { error, aborted, lastDecoder: rx[rx.length - 1]?.decoder });
  const R = r.rx;
  if (R?.displayedFps != null && !error) {
    const extra = [];
    if (R.repeats) extra.push(`${R.repeats} repeated refreshes`);
    if (R.displayDropped) extra.push(`${R.displayDropped} frames replaced before display`);
    if (R.pacingNote) extra.push(`pacing: ${R.pacingNote}`);
    if (R.drains) extra.push(`decoder backlog flushed ${R.drains}× (incl. warm-up)`);
    if (extra.length) r.notes = [r.notes, ...extra].filter(Boolean).join('; ');
  }
  return r;
}

/** Live-view values for one native sample (sender stats or TV native-stats). */
export function nativeInstant(sample, side) {
  if (side === 'tx') {
    return { txFps: sample.fps, txKbps: sample.kbps, encodeMs: sample.encodeMs, qlr: 'none' };
  }
  const lat = (sample.latency || []).slice().sort((a, b) => a - b);
  const dlat = (sample.displayLatency || []).slice().sort((a, b) => a - b);
  return {
    rxFps: sample.decoded,
    renderedFps: sample.displayed ?? sample.decoded,
    screenLatency: dlat.length ? percentile(dlat, 0.5) : null,
    repeats: sample.repeats ?? null,
    rxKbps: (sample.bytes * 8) / 1000,
    decodeMs: sample.decodeMs ?? null,
    jbMs: 0,
    lossPct: sample.packets + sample.lost > 0 ? (100 * sample.lost) / (sample.packets + sample.lost) : 0,
    rxWidth: sample.width,
    rxHeight: sample.height,
    decoder: sample.decoder,
    decoderHw: true,
    appCpuPct: sample.sys?.appCpuPct ?? null,
    latency: lat.length ? percentile(lat, 0.5) : null,
  };
}

export function buildNativeTimeline(c, { tx, rx, adb, lat = [], dlat = [] }) {
  const rows = new Map();
  const row = (at, phase) => {
    const t = Math.round(at / 1000);
    if (!rows.has(t)) rows.set(t, { index: c.index, label: c.label, phase, t });
    return rows.get(t);
  };
  for (const s of tx) Object.assign(row(s.at, s.phase), { txFps: s.fps, txKbps: s.kbps, encodeMs: s.encodeMs, qlr: 'none' });
  for (const s of rx) {
    const x = nativeInstant(s, 'rx');
    Object.assign(row(s.at, s.phase), {
      rxFps: x.rxFps,
      rxKbps: x.rxKbps,
      decodeMs: x.decodeMs,
      jbMs: 0,
      lossPct: x.lossPct,
      dropped: s.dropped,
      appCpuPct: x.appCpuPct,
      latencyMs: x.latency,
      screenLatencyMs: x.screenLatency,
      shownFps: s.displayed ?? null,
      repeats: x.repeats,
    });
  }
  for (const s of adb) {
    if (s.error) continue;
    const r = row(s.at, s.phase);
    if (s.cpuPct != null) r.cpuPct = s.cpuPct;
    if (s.socTempC != null) r.socTempC = s.socTempC;
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

/** Instantaneous per-sample rates, used for the live view and the Timeline sheet. */
export function txInstant(prev, cur) {
  if (!prev?.out || !cur?.out) return {};
  const dt = txSeconds(prev.out, cur.out);
  if (!(dt > 0)) return {};
  const d = (k) => delta(prev.out, cur.out, k);
  const enc = d('framesEncoded');
  return {
    txFps: d('framesSent') / dt,
    txKbps: (d('bytesSent') * 8) / dt / 1000,
    encodeMs: enc > 0 ? (d('totalEncodeTime') / enc) * 1000 : null,
    qlr: cur.out.qualityLimitationReason ?? null,
    txWidth: cur.out.frameWidth ?? null,
    txHeight: cur.out.frameHeight ?? null,
    encoder: cur.out.encoderImplementation ?? null,
  };
}

export function rxInstant(prev, cur) {
  if (!prev?.inbound || !cur?.inbound) return {};
  const dt = rxSeconds(prev.inbound, cur.inbound);
  if (!(dt > 0)) return {};
  const d = (k) => delta(prev.inbound, cur.inbound, k);
  const dec = d('framesDecoded');
  const jbN = d('jitterBufferEmittedCount');
  const lost = d('packetsLost') ?? 0;
  const recv = d('packetsReceived') ?? 0;
  return {
    rxFps: dec / dt,
    renderedFps: cur.sink && prev.sink ? (cur.sink.frames - prev.sink.frames) / dt : null,
    rxKbps: (d('bytesReceived') * 8) / dt / 1000,
    decodeMs: dec > 0 && d('totalDecodeTime') != null ? (d('totalDecodeTime') / dec) * 1000 : null,
    jbMs: jbN > 0 ? (d('jitterBufferDelay') / jbN) * 1000 : null,
    lossPct: lost + recv > 0 ? (100 * lost) / (lost + recv) : 0,
    dropped: cur.inbound.framesDropped ?? null,
    rxWidth: cur.inbound.frameWidth ?? null,
    rxHeight: cur.inbound.frameHeight ?? null,
    decoder: cur.inbound.decoderImplementation ?? null,
    decoderHw: guessHw(cur.inbound.decoderImplementation, cur.inbound.powerEfficientDecoder),
    appCpuPct: cur.sys?.appCpuPct ?? null,
  };
}

/** One row per second per test, merging PC, TV and adb samples. */
export function buildTimeline(c, { tx, rx, adb, lat = [], dlat = [] }) {
  const rows = new Map();
  const row = (at, phase) => {
    const t = Math.round(at / 1000);
    if (!rows.has(t)) rows.set(t, { index: c.index, label: c.label, phase, t });
    return rows.get(t);
  };
  for (let i = 1; i < tx.length; i++) {
    const x = txInstant(tx[i - 1], tx[i]);
    const r = row(tx[i].at, tx[i].phase);
    Object.assign(r, { txFps: x.txFps, txKbps: x.txKbps, encodeMs: x.encodeMs, qlr: x.qlr });
  }
  for (let i = 1; i < rx.length; i++) {
    const x = rxInstant(rx[i - 1], rx[i]);
    const r = row(rx[i].at, rx[i].phase);
    Object.assign(r, {
      rxFps: x.rxFps,
      rxKbps: x.rxKbps,
      decodeMs: x.decodeMs,
      jbMs: x.jbMs,
      lossPct: x.lossPct,
      dropped: x.dropped,
      appCpuPct: x.appCpuPct,
    });
  }
  for (const s of adb) {
    if (s.error) continue;
    const r = row(s.at, s.phase);
    if (s.cpuPct != null) r.cpuPct = s.cpuPct;
    if (s.socTempC != null) r.socTempC = s.socTempC;
  }
  const latBySec = new Map();
  for (const s of lat) {
    const r = row(s.at, s.phase);
    if (!latBySec.has(r)) latBySec.set(r, []);
    latBySec.get(r).push(s.ms);
  }
  for (const [r, list] of latBySec) r.latencyMs = percentile(list.sort((a, b) => a - b), 0.5);
  const scrBySec = new Map();
  for (const s of dlat) {
    const r = row(s.at, s.phase);
    if (!scrBySec.has(r)) scrBySec.set(r, []);
    scrBySec.get(r).push(s.ms);
  }
  for (const [r, list] of scrBySec) r.screenLatencyMs = percentile(list.sort((a, b) => a - b), 0.5);
  for (const s of rx) {
    if (!s.timing?.displayValid) continue;
    const r = row(s.at, s.phase);
    r.shownFps = s.timing.shown;
    r.repeats = s.timing.repeats;
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
