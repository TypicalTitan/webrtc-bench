import { CODEC_MIME, CODEC_LABEL, H264_PROFILES } from './constants.js';
import { setBitrateHints, setH264ProfileLevel } from './sdp.js';
import { summarize, buildTimeline, summarizeNative, buildNativeTimeline, nativeInstant } from './metrics.js';

/** Codecs this PC can encode for WebRTC (Chromium capabilities). */
export function senderCodecs() {
  const caps = RTCRtpSender.getCapabilities('video')?.codecs || [];
  return Object.keys(CODEC_MIME).filter((k) => caps.some((c) => c.mimeType.toLowerCase() === CODEC_MIME[k].toLowerCase()));
}

/** Codecs the TV's chosen decoder factory accepts. */
export function receiverCodecs(tvHello, mode) {
  const list = tvHello?.receiverCodecs?.[mode] || [];
  return [...new Set(list.map((c) => String(c.name).toUpperCase()))];
}

function h264Profile(fmtp) {
  return (/profile-level-id=([0-9a-f]{6})/i.exec(fmtp || '')?.[1] || '').slice(0, 4).toLowerCase();
}

/** Codec preference list for one test: the target codec (one H.264 profile) plus RTX. */
export function codecPreferences(codec, h264Prefix = '4200') {
  const caps = RTCRtpSender.getCapabilities('video')?.codecs || [];
  const mime = CODEC_MIME[codec].toLowerCase();
  let list = caps.filter((c) => c.mimeType.toLowerCase() === mime);
  if (codec === 'H264') {
    const pm1 = list.filter((c) => /packetization-mode=1/.test(c.sdpFmtpLine || ''));
    const wanted = pm1.filter((c) => h264Profile(c.sdpFmtpLine) === h264Prefix);
    list = (wanted.length ? wanted : pm1).slice(0, 1);
  }
  if (codec === 'VP9') list = list.filter((c) => !/profile-id=[1-3]/.test(c.sdpFmtpLine || ''));
  if (codec === 'AV1') list = list.filter((c) => !/profile=[12]/.test(c.sdpFmtpLine || ''));
  if (!list.length) return [];
  const rtx = caps.filter((c) => c.mimeType.toLowerCase() === 'video/rtx');
  return [...list, ...rtx];
}

async function sampleSender(pc) {
  const report = await pc.getStats();
  let out;
  let src;
  let transport;
  let remote;
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    else if (s.type === 'media-source' && s.kind === 'video') src = s;
    else if (s.type === 'transport') transport = s;
    else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remote = s;
  });
  const pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
  const codec = out?.codecId ? report.get(out.codecId) : null;
  const local = pair?.localCandidateId ? report.get(pair.localCandidateId) : null;
  return {
    out: out ? { ...out } : null,
    src: src ? { ...src } : null,
    pair: pair
      ? {
          currentRoundTripTime: pair.currentRoundTripTime,
          availableOutgoingBitrate: pair.availableOutgoingBitrate,
          // Which PC adapter carries the stream (this PC may have both Ethernet and Wi-Fi).
          localNetwork: local ? `${local.networkType || 'unknown'} ${local.address || ''}`.trim() : null,
        }
      : null,
    codec: codec ? { mimeType: codec.mimeType, sdpFmtpLine: codec.sdpFmtpLine } : null,
    remote: remote ? { roundTripTime: remote.roundTripTime, fractionLost: remote.fractionLost } : null,
  };
}

function waitConnected(pc, ms) {
  return new Promise((resolve, reject) => {
    if (pc.connectionState === 'connected') return resolve();
    const timer = setTimeout(() => reject(new Error('Timed out connecting to the TV (ICE/DTLS)')), ms);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(timer);
        resolve();
      } else if (pc.connectionState === 'failed') {
        clearTimeout(timer);
        reject(new Error('WebRTC connection to the TV failed'));
      }
    });
  });
}

/**
 * Runs the test matrix one case at a time: fresh peer connection per case, warm-up, then a
 * measurement window during which both ends sample stats once per second.
 */
export class BenchRunner {
  constructor({ link, source, settings, tvHello, onEvent, reconnect }) {
    this.link = link;
    this.reconnect = reconnect || null; // re-opens `link` and says hello again (screen-only runs)
    this.source = source;
    this.settings = settings;
    this.tvCodecList = tvHello?.receiverCodecs?.[settings.decoder] || [];
    this.onEvent = onEvent || (() => {});
    this.aborted = false;
    this.wakers = new Set();
    this.current = null;
    this.phase = 'idle';
    this.pingSeq = 0;
  }

  abort() {
    this.aborted = true;
    for (const w of this.wakers) w();
  }

  /** ADB samples arrive from the main process; tag them with the current test's clock. */
  pushAdb(sample) {
    const cur = this.current;
    if (!cur) return;
    cur.adb.push({ ...sample, at: performance.now() - cur.start, phase: this.phase });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  /**
   * NTP-style offset between the TV's monotonic clock and ours: several ping/pongs, keep the
   * one with the smallest round trip. Error is at most half that round trip (~1 ms on a LAN).
   */
  async clockSync(rounds = 12) {
    let best = null;
    for (let i = 0; i < rounds; i++) {
      const seq = ++this.pingSeq;
      const t0 = performance.timeOrigin + performance.now();
      const m = await this.link.request({ t: 'ping', ts: seq }, 'pong', (x) => x.ts === seq, 1500);
      const t1 = performance.timeOrigin + performance.now();
      if (typeof m.tv !== 'number') return null; // older TV app without clock support
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: m.tv - (t0 + t1) / 2 };
    }
    return best;
  }

  async run(cases) {
    const results = [];
    const timeline = [];
    const probe = this.settings.screenProbe || cases.some((c) => c.transport === 'screen');
    if (probe) await this.startScreenProbe();
    try {
      for (const c of cases) {
        if (this.aborted || !this.link.open) break;
        this.onEvent({ type: 'case-start', c });
        const { result, rows } =
          c.transport === 'native' ? await this.runNativeCase(c) : c.transport === 'screen' ? await this.runScreenCase(c) : await this.runCase(c);
        results.push(result);
        timeline.push(...rows);
        this.onEvent({ type: 'case-done', c, result });
        if (!this.aborted) await this.sleep(1200); // let the TV release its decoder
      }
    } finally {
      if (probe) await this.stopScreenProbe();
    }
    return { results, timeline };
  }

  /**
   * Screen latency probe: the PC shows pattern.html full screen (frame number in a bottom band),
   * the TV app captures its own screen and reports when each pattern frame first appeared. Same
   * method for anything that mirrors the PC screen to the TV: Miracast, Cast, or our WebRTC
   * display capture. Started once per run (the TV asks once for screen-capture permission).
   */
  async startScreenProbe() {
    const id = `probe-${Math.random().toString(36).slice(2, 8)}`;
    const draws = new Map(); // pattern code -> PC draw time (epoch ms)
    const channel = new BroadcastChannel('wrtcb-pattern');
    channel.onmessage = (e) => draws.set(e.data.n & 0xffff, e.data.t);
    const probe = { id, draws, channel, clock: null, sink: null };
    probe.off = this.link.on('screen-lat', (m) => {
      if (m.id !== id || !probe.sink || !probe.clock) return;
      for (const [code, tvMs] of m.samples || []) {
        const t = draws.get(code);
        if (t == null) continue;
        const ms = tvMs - probe.clock.offset - t;
        if (ms > -5 && ms < 5000) probe.sink(ms);
      }
    });
    this.probe = probe;
    await window.bench.pattern.show();
    this.onEvent({ type: 'notice', text: 'Allow screen capture on the TV (WebRTC Bench asks once per run)' });
    let r;
    try {
      r = await this.link.request({ t: 'screen-probe-start', id }, '*', (m) => m.id === id && (m.t === 'screen-probe-ready' || m.t === 'screen-probe-error'), 120000);
    } catch (e) {
      r = { t: 'screen-probe-error', message: 'no answer from the TV (was screen capture allowed on the TV?)' };
    }
    if (r.t === 'screen-probe-error') {
      await this.stopScreenProbe();
      throw new Error(`Screen probe: ${r.message}`);
    }
  }

  async stopScreenProbe() {
    const p = this.probe;
    if (!p) return;
    this.probe = null;
    p.off?.();
    p.channel.close();
    await window.bench.pattern.hide();
    if (this.link.open) this.link.send({ t: 'screen-probe-stop', id: p.id });
  }

  /** Starts collecting screen-probe samples for one test; returns them (array of {at, phase, ms}). */
  async probeSamples(at) {
    const out = [];
    if (!this.probe) return out;
    this.probe.clock = (await this.clockSync().catch(() => null)) || this.probe.clock;
    this.probe.sink = (ms) => out.push({ at: at(), phase: this.phase, ms });
    return out;
  }

  /** Screen-only case: measure whatever is mirroring the PC screen (e.g. Miracast). */
  async runScreenCase(c) {
    const start = performance.now();
    const at = () => performance.now() - start;
    const adb = [];
    this.current = { id: c.label, start, adb };
    const slat = await this.probeSamples(at);
    const pre = this.probe?.clock ? { ...this.probe.clock, pc: performance.timeOrigin + performance.now() } : null;
    // Wait (up to 5 min) until the mirrored pattern actually shows up on the TV: the person
    // starts the mirroring session (e.g. Win+K -> the TV) after the probe is running. Fire TV's
    // Miracast receiver takes the TV off Wi-Fi; then the TV keeps timing on its own and the
    // samples are collected when it is back on the network.
    this.phase = 'waiting';
    this.onEvent({ type: 'notice', text: 'Start mirroring the PC screen to the TV now' });
    let misses = 0;
    for (let i = 0; i < 600 && !slat.length && !this.aborted; i++) {
      await this.sleep(500);
      if (i % 4 !== 3) continue;
      misses = (await this.tvReachable()) ? 0 : misses + 1;
      if (misses >= 2 && pre && this.reconnect) return this.runOfflineScreenCase(c, pre);
    }
    if (slat.length) this.onEvent({ type: 'notice', text: 'Pattern seen on the TV; measuring' });
    this.phase = 'warmup';
    this.onEvent({ type: 'phase', c, phase: 'warmup', seconds: this.settings.warmupSec });
    await this.sleep(this.settings.warmupSec * 1000);
    this.phase = 'measure';
    const t0 = at();
    this.onEvent({ type: 'phase', c, phase: 'measure', seconds: this.settings.measureSec });
    await this.sleep(this.settings.measureSec * 1000);
    const t1 = at();
    if (this.probe) this.probe.sink = null;
    this.current = null;
    this.phase = 'idle';
    const inWin = slat.filter((s) => s.at >= t0 && s.at <= t1);
    const v = inWin.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    const secs = (t1 - t0) / 1000;
    const result = {
      index: c.index,
      label: c.label,
      transport: 'screen',
      codec: '-',
      width: 0,
      height: 0,
      fps: c.fps,
      status: v.length ? 'PASS' : 'FAIL',
      notes: v.length ? 'PC screen -> TV screen, timed by the TV screen probe' : 'No pattern frames seen on the TV (is the PC screen mirrored to it?)',
      tx: null,
      rx: v.length ? { displayedFps: v.length / secs, fps: v.length / secs } : null,
      adb: null,
      latency: null,
      screenLatency: v.length ? { median: pct(0.5), p95: pct(0.95), min: v[0], max: v[v.length - 1], mean: v.reduce((s, x) => s + x, 0) / v.length, samples: v.length, syncRttMs: this.probe?.clock?.rtt ?? null } : null,
    };
    return { result, rows: [] };
  }

  /** One ping/pong within `timeoutMs`; a half-open socket to a TV that left the network fails it. */
  async tvReachable(timeoutMs = 1500) {
    if (!this.link.open) return false;
    const seq = ++this.pingSeq;
    try {
      await this.link.request({ t: 'ping', ts: seq }, 'pong', (x) => x.ts === seq, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Screen-only case, TV off the network while mirroring: wait until it is back (the person
   * stops mirroring), reconnect, and collect the samples the TV timed meanwhile. TV times are
   * mapped with clock syncs from before and after, interpolated (the clocks drift a few ppm).
   */
  async runOfflineScreenCase(c, pre) {
    if (this.probe) this.probe.sink = null;
    this.phase = 'offline';
    this.onEvent({
      type: 'notice',
      text: 'The TV left the network (its mirroring receiver does that); it keeps timing the pattern. Mirror for 30 s or more, then stop mirroring: results are collected when the TV is back.',
    });
    let back = false;
    for (let i = 0; i < 600 && !this.aborted && !back; i++) {
      await this.sleep(2000);
      try {
        await this.reconnect();
        back = true;
      } catch {
        // still away
      }
    }
    this.phase = 'idle';
    this.current = null;
    const fail = (notes) => ({
      result: { index: c.index, label: c.label, transport: 'screen', codec: '-', width: 0, height: 0, fps: c.fps, status: 'FAIL', notes, tx: null, rx: null, adb: null, latency: null, screenLatency: null },
      rows: [],
    });
    if (!back) return fail('The TV did not come back on the network within 20 minutes');
    const post = await this.clockSync().catch(() => null);
    const postPc = performance.timeOrigin + performance.now();
    if (!post) return fail('Clock sync with the TV failed after it reconnected');
    const id = this.probe.id;
    const dump = await this.link.request({ t: 'screen-probe-dump', id, since: pre.pc + pre.offset }, 'screen-probe-dump', (m) => m.id === id, 20000);
    const drift = (post.offset - pre.offset) / (postPc - pre.pc);
    const pts = [];
    for (const [code, tvMs] of dump.samples || []) {
      const t = this.probe.draws.get(code);
      if (t == null) continue;
      const offset = pre.offset + drift * (tvMs - pre.offset - pre.pc);
      const ms = tvMs - offset - t;
      if (ms > -5 && ms < 5000) pts.push({ tv: tvMs, ms });
    }
    if (!pts.length) return fail('No pattern frames seen on the TV (was the PC screen mirrored to it?)');
    // Skip the warm-up after the first frame and the last second (mirroring being torn down).
    const first = pts[0].tv;
    const last = pts[pts.length - 1].tv;
    const inWin = pts.filter((p) => p.tv >= first + this.settings.warmupSec * 1000 && p.tv <= last - 1000);
    const v = (inWin.length ? inWin : pts).map((p) => p.ms).sort((a, b) => a - b);
    const pct = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    const secs = Math.max(0.001, ((inWin.length ? inWin[inWin.length - 1].tv - inWin[0].tv : last - first) || 1) / 1000);
    return {
      result: {
        index: c.index,
        label: c.label,
        transport: 'screen',
        codec: '-',
        width: 0,
        height: 0,
        fps: c.fps,
        status: 'PASS',
        notes: `PC screen -> TV screen, timed by the TV screen probe while it was off the network (${secs.toFixed(0)} s; clock drift ${(drift * 1e6).toFixed(0)} ppm corrected)`,
        tx: null,
        rx: { displayedFps: v.length / secs, fps: v.length / secs },
        adb: null,
        latency: null,
        screenLatency: { median: pct(0.5), p95: pct(0.95), min: v[0], max: v[v.length - 1], mean: v.reduce((s, x) => s + x, 0) / v.length, samples: v.length, syncRttMs: Math.max(pre.rtt, post.rtt), offline: true, driftPpm: drift * 1e6 },
      },
      rows: [],
    };
  }

  /**
   * Native path: the TV starts its RTP receiver + low-latency MediaCodec decoder, then the
   * main process launches wbsend.exe (NVENC). wbsend reports per-second sender stats on stdout;
   * the TV reports per-second receiver stats and per-frame latency over the control socket.
   */
  async runNativeCase(c) {
    const id = `n${c.index}-${Math.random().toString(36).slice(2, 8)}`;
    const start = performance.now();
    const at = () => performance.now() - start;
    const tx = [];
    const rx = [];
    const adb = [];
    const lat = [];
    const dlat = []; // capture -> on screen
    this.current = { id, start, adb };
    const offs = [];
    let started = false;
    let senderStarted = false;
    let stopping = false;
    let ready = null;
    let error = null;
    let unsupported = null;
    let t0 = 0;
    let t1 = 0;
    this.phase = 'setup';
    const item = this.source.item;

    try {
      if (c.codec !== 'H264' && c.codec !== 'H265') {
        unsupported = 'The native NVENC path supports H.264 and H.265';
        throw new Error(unsupported);
      }
      if (item.kind !== 'display' && (item.kind !== 'file' || !item.path)) {
        unsupported = 'The native NVENC path needs a video file or the display, not a generated pattern';
        throw new Error(unsupported);
      }
      this.source.pauseMedia(); // the PC's own preview decode would compete with wbsend for the GPU

      offs.push(
        this.link.on('native-stats', (m) => {
          if (m.id !== id) return;
          const s = { ...m, at: at(), phase: this.phase };
          rx.push(s);
          for (const ms of m.latency || []) lat.push({ at: s.at, phase: s.phase, ms });
          for (const ms of m.displayLatency || []) dlat.push({ at: s.at, phase: s.phase, ms });
          this.onEvent({ type: 'live', c, side: 'rx', values: nativeInstant(s, 'rx'), t: s.at / 1000 });
        }),
      );
      offs.push(this.link.on('rx-error', (m) => m.id === id && (error = m.message)));
      offs.push(
        window.bench.native.onEvent((ev) => {
          if (ev.t === 'ready') ready = ev;
          else if (ev.t === 'error') error = error || `sender: ${ev.message}`;
          else if (ev.t === 'exit' && !stopping) error = error || `sender exited (code ${ev.code})`;
          else if (ev.t === 'stats') {
            const s = { ...ev, at: at(), phase: this.phase };
            tx.push(s);
            this.onEvent({ type: 'live', c, side: 'tx', values: { ...nativeInstant(s, 'tx'), encoder: ready?.encoder }, t: s.at / 1000 });
          }
        }),
      );

      started = true;
      const tvReady = await this.link.request(
        {
          t: 'native-start',
          id,
          index: c.index,
          total: c.total,
          codec: c.codec,
          width: c.width,
          height: c.height,
          fps: c.fps,
          bitrateKbps: c.bitrateKbps,
          render: this.settings.render,
          showOverlay: this.settings.tvOverlay,
          video: item.title,
          pacing: this.settings.pacing || 'vsync',
          opts: this.settings.nativeOpts || '',
        },
        '*',
        (m) => m.id === id && (m.t === 'native-ready' || m.t === 'rx-error'),
        10000,
      );
      if (tvReady.t === 'rx-error') throw new Error(tvReady.message);

      const h264 = H264_PROFILES[this.settings.h264Profile];
      const res = await window.bench.native.start({
        tv: this.link.ip,
        port: tvReady.port,
        source: item.kind === 'display' ? 'display' : 'file',
        file: item.path,
        start: item.segmentStart || 0,
        codec: c.codec === 'H265' ? 'hevc' : 'h264',
        width: c.width,
        height: c.height,
        fps: c.fps,
        kbps: c.bitrateKbps,
        duration: this.settings.warmupSec + this.settings.measureSec + 20, // safety net only
        profile: h264?.prefix === '6400' ? 'high' : 'baseline',
        preset: this.settings.nvencPreset || 1,
        extra: [...(this.settings.senderArgs || '').split(/\s+/).filter(Boolean), ...(this.settings.preencoded ? ['--preencoded'] : [])],
      });
      if (!res.ok) throw new Error(res.error);
      senderStarted = true;
      for (let i = 0; i < 600 && !ready && !error && !this.aborted; i++) await this.sleep(100); // pre-encoding can take a while
      if (!ready) throw new Error(error || 'The native sender did not start');

      this.phase = 'warmup';
      this.onEvent({ type: 'phase', c, phase: 'warmup', seconds: this.settings.warmupSec });
      await this.sleep(this.settings.warmupSec * 1000);
      if (this.aborted) throw new Error('Stopped by user');
      this.phase = 'measure';
      t0 = at();
      this.onEvent({ type: 'phase', c, phase: 'measure', seconds: this.settings.measureSec });
      await this.sleep(this.settings.measureSec * 1000 + 300);
      t1 = at();
      if (this.aborted) throw new Error('Stopped by user');
      if (!this.link.open) throw new Error('The TV disconnected');
      if (error) throw new Error(error);
    } catch (e) {
      if (!unsupported) error = error || e.message;
    } finally {
      stopping = true;
      this.phase = 'stopping';
      if (senderStarted) await window.bench.native.stop();
      if (started && this.link.open) {
        try {
          await this.link.request({ t: 'native-stop', id }, 'native-stopped', (m) => m.id === id, 5000);
        } catch {
          // TV may already have dropped the session
        }
      }
      offs.forEach((off) => off());
      this.current = null;
      this.phase = 'idle';
    }

    const result = summarizeNative(c, {
      tx,
      rx,
      adb,
      lat,
      dlat,
      ready,
      t0,
      t1,
      error,
      unsupported,
      aborted: this.aborted,
      renderMode: this.settings.render,
    });
    if (ready?.preencoded) result.preencoded = true;
    return { result, rows: buildNativeTimeline(c, { tx, rx, adb, lat, dlat }) };
  }

  async runCase(c) {
    this.source.resumeMedia();
    const id = `t${c.index}-${Math.random().toString(36).slice(2, 8)}`;
    const start = performance.now();
    const at = () => performance.now() - start;
    const tx = [];
    const rx = [];
    const adb = [];
    const lat = []; // capture -> decoded (SEI timing), or capture -> renderer (frame-code probe)
    const latProbe = []; // frame-code probe, kept separately when SEI timing is also available
    const dlat = []; // capture -> on screen
    const seiStats = [];
    const seiCodes = new Map();
    const codeCheck = [];
    let slat = []; // screen probe: PC screen -> TV screen
    let clock = null;
    this.current = { id, start, adb };
    const offs = [];
    let pc = null;
    let worker = null;
    let nvenc = false; // cloud gaming with the NVENC sender (wbsend -> WebRTC)
    let placeholder = null;
    let slotClock = null;
    const SLOT_FPS = Number(this.settings.slotFps) || 240;
    let senderStarted = false;
    const ntx = []; // wbsend stats (NVENC sender)
    let nready = null;
    let statsTimer = 0;
    let started = false;
    let error = null;
    let unsupported = null;
    let t0 = 0;
    let t1 = 0;
    this.phase = 'setup';

    try {
      const h264 = c.codec === 'H264' ? H264_PROFILES[this.settings.h264Profile] || H264_PROFILES.baseline : null;
      const prefs = codecPreferences(c.codec, h264?.prefix);
      if (!prefs.length) {
        unsupported = `${CODEC_LABEL[c.codec]} encoding is not available on this PC`;
        throw new Error(unsupported);
      }
      if (!this.tvCodecList.some((t) => String(t.name).toUpperCase() === c.codec)) {
        unsupported = `${CODEC_LABEL[c.codec]} is not offered by the TV's ${this.settings.decoder} decoders`;
        throw new Error(unsupported);
      }

      const gaming = this.settings.latencyProfile === 'gaming';
      const item = this.source.item;
      // Cloud-gaming profile, NVENC sender: wbsend captures and encodes, Chromium only carries
      // the frames over WebRTC (nvenc-worker.js). Needs H.264/H.265 and a file or the display.
      nvenc =
        gaming &&
        this.settings.gamingSender !== 'chromium' &&
        typeof RTCRtpScriptTransform === 'function' &&
        (c.codec === 'H264' || c.codec === 'H265') &&
        (item.kind === 'display' || (item.kind === 'file' && !!item.path));
      let track;
      let scaleDownBy = 1;
      if (nvenc) {
        this.source.pauseMedia(); // the PC's own preview decode would compete with wbsend
        worker = new Worker('./nvenc-worker.js');
        placeholder = new MediaStreamTrackGenerator({ kind: 'video' });
        const writer = placeholder.writable.getWriter();
        // Placeholder size/kind (--slot-size=WxH, --slot-kind=i420|canvas) for experiments.
        const [PW, PH] = String(this.settings.slotSize || (c.codec === 'H265' ? '1280x720' : '320x180')).split('x').map(Number);
        const slotCanvas = this.settings.slotKind === 'canvas' ? new OffscreenCanvas(PW, PH) : null;
        slotCanvas?.getContext('2d').fillRect(0, 0, PW, PH);
        const blank = new Uint8Array((PW * PH * 3) / 2).fill(128);
        worker.onmessage = (e) => {
          const m = e.data;
          if (m?.t === 'stats') {
            seiStats.push({ ...m, at: at(), phase: this.phase });
            console.log(`[nvenc-worker] slots ${m.frames} sent ${m.tagged} received ${m.received} queued ${m.queued} dropped ${m.dropped}`);
          } else if (m?.t === 'idr') window.bench.native.cmd('idr');
        };
        // Placeholders are send slots: a steady 240/s stream through Chromium's sender, each
        // NVENC frame rides the next slot that comes out of the encoder (unused slots are
        // dropped). Waiting on a placeholder per frame would add Chromium's whole capture ->
        // encode pipeline back in.
        slotClock = new Worker('./ticker-worker.js');
        slotClock.onmessage = () => {
          const ts = Math.round(performance.now() * 1000);
          const vf = slotCanvas ? new VideoFrame(slotCanvas, { timestamp: ts }) : new VideoFrame(blank, { format: 'I420', codedWidth: PW, codedHeight: PH, timestamp: ts });
          writer.write(vf).catch(() => vf.close());
        };
        // setTimeout alone tops out near 240/s (4 ms clamp); faster slot rates spin briefly.
        slotClock.postMessage({ t: 'start', fps: SLOT_FPS, spinMs: SLOT_FPS > 240 ? 1.2 : 0 });
        const onPort = (e) => {
          if (e.data === 'wrtcb-frame-port' && e.ports?.[0]) worker.postMessage({ t: 'port', port: e.ports[0] }, [e.ports[0]]);
        };
        window.addEventListener('message', onPort);
        offs.push(() => window.removeEventListener('message', onPort));
        track = placeholder;
      } else {
        // H.264/H.265 frames carry their capture time in an SEI (sei-worker.js), so the TV times
        // every frame itself; other codecs fall back to reading the burned-in frame code.
        if (this.settings.measureLatency && (c.codec === 'H264' || c.codec === 'H265') && typeof RTCRtpScriptTransform === 'function') {
          worker = new Worker('./sei-worker.js');
          worker.onmessage = (e) => e.data?.t === 'stats' && seiStats.push({ ...e.data, at: at(), phase: this.phase });
        }
        ({ track, scaleDownBy } = this.source.start({
          width: c.width,
          height: c.height,
          fps: c.fps,
          label: c.label,
          pipeline: this.settings.pipeline,
          // Frames go straight into the track (MediaStreamTrackGenerator): exact per-frame timing
          // (canvas.captureStream shifts frames by one against their RTP time) and no wait for
          // the next compositor frame. --push-frames=0 restores captureStream.
          push: this.settings.pushFrames !== false,
          onCapture: worker ? (n, t, anchorGapMs) => worker.postMessage({ t: 'capture', n, at: t, anchorGapMs }) : null,
        }));
      }

      offs.push(
        this.link.on('rx-stats', (m) => {
          if (m.id !== id) return;
          const s = { ...m, at: at(), phase: this.phase };
          rx.push(s);
          this.onEvent({ type: 'rx-sample', c, sample: s, prev: rx[rx.length - 2] });
          const batch = [];
          for (const ms of m.timing?.decoded || []) batch.push({ at: s.at, phase: s.phase, ms });
          // Cross-check (probe=1): for the same frame code, renderer time (pixel probe) minus
          // decoded time (SEI) should be a small positive number.
          for (const [code, ms] of m.timing?.codes || []) seiCodes.set(code, ms);
          for (const [code, tvMs] of m.lat || []) if (seiCodes.has(code)) codeCheck.push(tvMs - seiCodes.get(code));
          for (const ms of m.timing?.screen || []) dlat.push({ at: s.at, phase: s.phase, ms });
          if (clock && Array.isArray(m.lat)) {
            // [frame code, TV clock ms when the decoded frame reached the renderer]
            const probe = [];
            for (const [code, tvMs] of m.lat) {
              const captured = this.source.captureTimeOf(code);
              if (captured == null) continue;
              const ms = tvMs - clock.offset - captured;
              if (ms > -5 && ms < 5000) probe.push({ at: s.at, phase: s.phase, ms, captureDelay: this.source.captureDelayOf(code) });
            }
            latProbe.push(...probe);
            if (!worker) batch.push(...probe);
          }
          lat.push(...batch);
          if (batch.length) this.onEvent({ type: 'lat-sample', c, batch });
        }),
      );
      offs.push(this.link.on('rx-error', (m) => m.id === id && (error = m.message)));
      // Cloud-gaming profile: the TV's vsync pacer moves our frame clock (wbsend's or the canvas').
      offs.push(
        this.link.on('pace-shift', (m) => {
          if (m.id !== id || typeof m.ms !== 'number') return;
          if (nvenc) window.bench.native.cmd(`shift ${m.ms.toFixed(3)}`);
          else this.source.shiftPhase(m.ms);
        }),
      );
      offs.push(
        this.link.on('ice', (m) => {
          if (m.id !== id || !pc) return;
          pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex }).catch(() => {});
        }),
      );

      started = true;
      await this.link.request(
        {
          t: 'test-start',
          id,
          index: c.index,
          total: c.total,
          codec: c.codec,
          width: c.width,
          height: c.height,
          fps: c.fps,
          bitrateKbps: c.bitrateKbps,
          decoder: c.decoderMode,
          video: this.source.item.title,
          showOverlay: this.settings.tvOverlay,
          render: this.settings.render,
          latency: this.settings.measureLatency && this.settings.pipeline === 'canvas',
          sei: !!worker,
          profile: gaming ? 'gaming' : 'standard',
          pacing: this.settings.pacing || 'vsync',
          playout: gaming ? 'low' : this.settings.playout,
          fieldTrials: this.settings.tvFieldTrials || '',
          opts: this.settings.nativeOpts || '',
        },
        '*',
        (m) => m.id === id && (m.t === 'test-ready' || m.t === 'rx-error'),
        8000,
      ).then((m) => {
        if (m.t === 'rx-error') throw new Error(m.message);
        return m;
      });
      if (this.settings.measureLatency) clock = await this.clockSync().catch(() => null);
      worker?.postMessage({ t: 'config', tvOffset: clock?.offset ?? null, fps: c.fps });
      slat = await this.probeSamples(at);

      pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      pc.onicecandidate = (e) => {
        if (e.candidate && this.link.open) {
          this.link.send({ t: 'ice', id, candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
        }
      };
      const enc = { maxBitrate: c.bitrateKbps * 1000, maxFramerate: nvenc ? SLOT_FPS : c.fps };
      if (scaleDownBy > 1.001) enc.scaleResolutionDownBy = scaleDownBy;
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: [enc] });
      transceiver.setCodecPreferences(prefs);
      if (worker) transceiver.sender.transform = new RTCRtpScriptTransform(worker, { codec: c.codec });

      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: 'offer', sdp: setBitrateHints(offer.sdp, c.codec, c.bitrateKbps) });
      let toTv = pc.localDescription.sdp;
      if (h264) toTv = setH264ProfileLevel(toTv, '42e01f'); // the only H.264 profile Android WebRTC accepts
      const answer = await this.link.request({ t: 'offer', id, sdp: toTv }, 'answer', (m) => m.id === id, 10000);
      let sdp = setBitrateHints(answer.sdp, c.codec, c.bitrateKbps);
      if (h264) sdp = setH264ProfileLevel(sdp, `${h264.prefix}34`); // real profile, level 5.2
      await pc.setRemoteDescription({ type: 'answer', sdp });
      try {
        const params = transceiver.sender.getParameters();
        params.degradationPreference = 'maintain-resolution';
        await transceiver.sender.setParameters(params);
      } catch (e) {
        console.warn('degradationPreference not applied', e);
      }
      await waitConnected(pc, 10000);

      if (nvenc) {
        // wbsend timestamps frames with QueryPerformanceCounter; map that onto our clock (IPC
        // round trip, best of 8) and from there onto the TV's (ping/pong above).
        let best = null;
        for (let i = 0; i < 8; i++) {
          const a = performance.timeOrigin + performance.now();
          const q = await window.bench.qpcMs();
          const b = performance.timeOrigin + performance.now();
          if (!best || b - a < best.rtt) best = { rtt: b - a, qpcToEpoch: (a + b) / 2 - q };
        }
        worker.postMessage({ t: 'config', qpcToEpoch: best.qpcToEpoch, qpcToTv: clock ? best.qpcToEpoch + clock.offset : null });
        offs.push(
          window.bench.native.onEvent((ev) => {
            if (ev.t === 'ready') nready = ev;
            else if (ev.t === 'stats') ntx.push({ ...ev, at: at(), phase: this.phase });
            else if (ev.t === 'error') error = error || `sender: ${ev.message}`;
            else if (ev.t === 'exit' && this.phase !== 'stopping') error = error || `sender exited (code ${ev.code})`;
          }),
        );
        const h264p = H264_PROFILES[this.settings.h264Profile];
        const res = await window.bench.native.start({
          sink: 'webrtc',
          source: item.kind === 'display' ? 'display' : 'file',
          file: item.path,
          start: item.segmentStart || 0,
          codec: c.codec === 'H265' ? 'hevc' : 'h264',
          width: c.width,
          height: c.height,
          fps: c.fps,
          kbps: c.bitrateKbps,
          duration: this.settings.warmupSec + this.settings.measureSec + 20,
          profile: h264p?.prefix === '6400' ? 'high' : 'baseline',
          preset: this.settings.nvencPreset || 1,
          extra: [...(this.settings.senderArgs || '').split(/\s+/).filter(Boolean), ...(this.settings.preencoded ? ['--preencoded'] : [])],
        });
        if (!res.ok) throw new Error(res.error);
        senderStarted = true;
        for (let i = 0; i < 600 && !nready && !error && !this.aborted; i++) await this.sleep(100); // pre-encoding can take a while
        if (!nready) throw new Error(error || 'The NVENC sender did not start');
      }

      statsTimer = setInterval(async () => {
        worker?.postMessage({ t: 'stats' });
        try {
          const s = await sampleSender(pc);
          s.at = at();
          s.phase = this.phase;
          tx.push(s);
          this.onEvent({ type: 'tx-sample', c, sample: s, prev: tx[tx.length - 2] });
        } catch {
          // connection closing
        }
      }, 1000);

      this.phase = 'warmup';
      this.onEvent({ type: 'phase', c, phase: 'warmup', seconds: this.settings.warmupSec });
      await this.sleep(this.settings.warmupSec * 1000);
      if (this.aborted) throw new Error('Stopped by user');
      this.phase = 'measure';
      t0 = at();
      this.onEvent({ type: 'phase', c, phase: 'measure', seconds: this.settings.measureSec });
      await this.sleep(this.settings.measureSec * 1000 + 300);
      t1 = at();
      if (this.aborted) throw new Error('Stopped by user');
      if (!this.link.open) throw new Error('The TV disconnected');
    } catch (e) {
      if (!unsupported) error = error || e.message;
    } finally {
      clearInterval(statsTimer);
      this.phase = 'stopping';
      if (started && this.link.open) {
        try {
          await this.link.request({ t: 'test-stop', id }, 'test-stopped', (m) => m.id === id, 5000);
        } catch {
          // TV may already have dropped the session
        }
      }
      offs.forEach((off) => off());
      try {
        pc?.close();
      } catch {
        // ignore
      }
      if (senderStarted) await window.bench.native.stop();
      worker?.terminate();
      slotClock?.terminate();
      placeholder?.stop();
      if (this.probe) this.probe.sink = null;
      this.source.stop();
      this.current = null;
      this.phase = 'idle';
    }

    let txPatch = null;
    if (nvenc) {
      // Chromium only encoded placeholders; the frames on the wire came from wbsend (NVENC).
      const nIn = ntx.filter((s) => s.at >= t0 && s.at <= t1);
      const mean = (k) => (nIn.length ? nIn.reduce((s, x) => s + (x[k] || 0), 0) / nIn.length : null);
      txPatch = {
        encoder: `${nready?.encoder || 'NVENC'} → WebRTC (Chromium transport)`,
        encoderHw: true,
        encodeMs: mean('encodeMs'),
        prepMs: mean('prepMs'),
        fps: mean('fps'),
        width: c.width,
        height: c.height,
      };
    }
    const result = summarize(c, { tx, rx, adb, lat, latProbe, dlat, slat, seiStats, clock, t0, t1, error, unsupported, aborted: this.aborted, txPatch });
    result.profile = this.settings.latencyProfile === 'gaming' ? 'gaming' : 'standard';
    if (nvenc) result.sender = 'nvenc';
    if (nready?.preencoded) result.preencoded = true;
    if (codeCheck.length) {
      const v = codeCheck.slice().sort((a, b) => a - b);
      result.timingCheck = { samples: v.length, rendererMinusDecodedMedianMs: v[Math.floor(v.length / 2)] };
    }
    const rows = buildTimeline(c, { tx, rx, adb, lat, dlat });
    return { result, rows };
  }
}
