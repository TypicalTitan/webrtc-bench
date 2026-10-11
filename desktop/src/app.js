import { TvLink } from './tvlink.js';
import { FrameSource } from './source.js';
import { BenchRunner, senderCodecs, receiverCodecs } from './runner.js';
import { txInstant, rxInstant } from './metrics.js';
import {
  CODECS,
  CODEC_LABEL,
  RESOLUTIONS,
  RES_W,
  FPS_OPTIONS,
  DECODER_MODES,
  RENDER_MODES,
  H264_PROFILES,
  PLAYOUT_MODES,
  PACING_MODES,
  LATENCY_PROFILES,
  TRANSPORTS,
  NATIVE_CODECS,
  BITRATE_PRESETS,
  kbpsFor,
  DEFAULT_SETTINGS,
  PRESETS,
  PER_TEST_OVERHEAD_SEC,
} from './constants.js';

const bench = window.bench;

const state = {
  info: null,
  devices: [],
  manual: [],
  selected: null,
  conn: 'idle', // idle | connecting | connected | error
  connError: null,
  link: null,
  hello: null,
  library: [],
  settings: { ...DEFAULT_SETTINGS },
  senderCodecs: [],
  adb: null,
  adbBusy: false,
  adbHost: '',
  run: null,
  runner: null,
  report: null,
  keepAlive: null,
};

// Persistent nodes so re-rendering the run card never detaches the live canvas.
const previewEl = h('div', { class: 'preview' }, h('span', { class: 'ph' }, 'Preview appears here during a run'));
const chartCanvas = h('canvas', { width: 1200, height: 220 });
const stopBtn = h('button', { class: 'btn btn-danger', onclick: () => state.runner?.abort() }, 'Stop');

// ---------------------------------------------------------------- utilities

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const mount = (id, ...kids) => $(id).replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);
const resName = (hgt) => `${hgt}p`;
const log = (...a) => {
  console.log(...a);
  bench.log(...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
};

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}

async function waitUntil(fn, timeoutMs, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

// ---------------------------------------------------------------- init

async function init() {
  state.info = await bench.info();
  const saved = await bench.settings.get();
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (saved[k] !== undefined) state.settings[k] = saved[k];
  state.senderCodecs = senderCodecs();
  state.library = await bench.library.list();
  ensureVideoSelected();

  // An active capture makes Chromium expose encoder implementation details in getStats().
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => (state.keepAlive = s))
    .catch(() => {});

  bench.discovery.onUpdate((list) => {
    state.devices = list;
    onDevicesChanged();
  });
  bench.library.onProgress(onDownloadProgress);
  bench.adb.onSample((s) => {
    state.runner?.pushAdb(s);
    if (state.run?.running && !s.error) {
      state.run.live.adbCpu = s.cpuPct ?? state.run.live.adbCpu;
      state.run.live.socTemp = s.socTempC ?? state.run.live.socTemp;
    }
  });
  state.devices = await bench.discovery.start();

  $('manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const ip = $('manualIp').value.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return toast('Enter an IPv4 address like 192.168.1.40', true);
    $('manualIp').value = '';
    bench.discovery.probe(ip);
    if (!state.manual.some((d) => d.ip === ip)) state.manual.push({ id: null, ip, name: ip, manual: true, wsPort: state.info.wsPort });
    renderDevices();
  });
  setupPinDialog();
  renderAll();
  onDevicesChanged();

  const a = state.info.launch || {};
  if (a.auto) {
    autoRun(a).catch(async (e) => {
      log(`AUTO FAILED: ${e.message}`);
      toast(e.message, true);
      if (a.quit) await bench.quit(2);
    });
  }
}

function ensureVideoSelected() {
  const ok = (id) => state.library.some((v) => v.id === id && v.available);
  if (!ok(state.settings.video)) state.settings.video = state.library.find((v) => v.available)?.id ?? null;
}

function allDevices() {
  const list = [...state.devices];
  for (const m of state.manual) if (!list.some((d) => d.ip === m.ip)) list.push(m);
  return list;
}

function onDevicesChanged() {
  // Reconnect automatically to a TV we've paired with before.
  if (!state.selected && !state.info.launch?.auto) {
    const known = state.devices.find((d) => d.paired);
    if (known) selectDevice(known);
  }
  if (state.selected && !state.selected.manual) {
    const fresh = state.devices.find((d) => d.id === state.selected.id);
    if (fresh) state.selected = { ...state.selected, ...fresh };
  }
  renderDevices();
}

// ---------------------------------------------------------------- connection & pairing

async function selectDevice(dev) {
  if (state.run?.running) return toast('Stop the current run first');
  if (state.link) state.link.close();
  state.link = null;
  state.selected = dev;
  state.hello = null;
  state.conn = 'connecting';
  state.connError = null;
  renderAll();
  const link = new TvLink({ ip: dev.ip, port: dev.wsPort || state.info.wsPort });
  try {
    await link.connect();
    state.link = link;
    link.on('__close', () => {
      if (state.link !== link) return;
      state.link = null;
      state.conn = 'error';
      state.connError = 'Connection to the TV was lost. Is the app still open on the TV?';
      renderAll();
    });
    link.on('hello-ok', (m) => {
      if (state.link !== link) return;
      state.hello = m;
      renderAll();
    });
    await sayHello(link, dev);
    state.conn = 'connected';
  } catch (e) {
    link.close();
    if (state.selected === dev) {
      state.conn = 'error';
      state.connError = e.message;
    }
  }
  renderAll();
  state.adbReady = refreshAdb();
}

async function sayHello(link, dev) {
  const hello = (token) =>
    link.request(
      { t: 'hello', desktopId: state.info.desktopId, desktopName: state.info.desktopName, token: token || null, appVersion: state.info.version },
      'hello-ok',
      () => true,
      6000,
    );
  let pairing = dev.id ? await bench.pairing.get(dev.id) : null;
  let m = await hello(pairing?.token);
  const tvId = m.tv?.id;
  if (!dev.id && tvId) {
    dev.id = tvId;
    pairing = await bench.pairing.get(tvId);
    if (pairing?.token) m = await hello(pairing.token);
  }
  state.hello = m;
  if (m.paired && tvId) await bench.pairing.save(tvId, { name: m.tv.name, model: m.tv.model, lastIp: dev.ip });
}

async function startPairing() {
  const link = state.link;
  if (!link) return;
  try {
    const reply = await link.request({ t: 'pair-request' }, '*', (m) => m.t === 'pair-pin-shown' || m.t === 'pair-fail', 8000);
    if (reply.t === 'pair-fail') return toast(`Pairing failed: ${reply.reason}`, true);
    openPinDialog();
  } catch (e) {
    toast(e.message, true);
  }
}

async function submitPin(raw) {
  const pin = String(raw || '').replace(/\D/g, '');
  if (pin.length !== 6) {
    $('pinError').textContent = 'The PIN has 6 digits.';
    return false;
  }
  const link = state.link;
  if (!link) return false;
  $('pinSubmit').disabled = true;
  try {
    const reply = await link.request({ t: 'pair-pin', pin }, '*', (m) => m.t === 'pair-ok' || m.t === 'pair-fail', 8000);
    if (reply.t === 'pair-ok') {
      const tv = state.hello?.tv || {};
      if (reply.token) await bench.pairing.save(tv.id, { name: tv.name, model: tv.model, lastIp: state.selected?.ip, token: reply.token });
      $('pinDialog').close();
      toast(`Paired with ${tv.name || 'the TV'}`);
      await waitUntil(() => state.hello?.paired, 3000, 100);
      renderAll();
      return true;
    }
    const reasons = {
      'wrong-pin': `Wrong PIN. ${reply.attemptsLeft > 0 ? `${reply.attemptsLeft} attempt(s) left.` : 'Start pairing again.'}`,
      expired: 'The PIN expired. Start pairing again.',
      'cancelled-on-tv': 'Pairing was cancelled on the TV.',
      superseded: 'Another PC started pairing.',
    };
    $('pinError').textContent = reasons[reply.reason] || `Pairing failed: ${reply.reason}`;
    if (reply.reason !== 'wrong-pin' || reply.attemptsLeft <= 0) setTimeout(() => $('pinDialog').close(), 1800);
    return false;
  } catch (e) {
    $('pinError').textContent = e.message;
    return false;
  } finally {
    $('pinSubmit').disabled = false;
  }
}

function setupPinDialog() {
  const dlg = $('pinDialog');
  $('pinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitPin($('pinInput').value);
  });
  $('pinCancel').addEventListener('click', () => {
    try {
      state.link?.send({ t: 'pair-cancel' });
    } catch {
      // not connected
    }
    dlg.close();
  });
  $('pinInput').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    $('pinError').textContent = '';
  });
}

function openPinDialog() {
  $('pinTvName').textContent = state.hello?.tv?.name || 'the TV';
  $('pinInput').value = '';
  $('pinError').textContent = '';
  $('pinDialog').showModal();
  $('pinInput').focus();
}

async function unpair() {
  const tvId = state.hello?.tv?.id;
  try {
    state.link?.send({ t: 'unpair' });
  } catch {
    // ignore
  }
  if (tvId) await bench.pairing.remove(tvId);
  if (state.hello) state.hello = { ...state.hello, paired: false };
  renderAll();
}

// ---------------------------------------------------------------- ADB

async function refreshAdb() {
  state.adb = await bench.adb.status(state.selected?.ip);
  if (!state.adbHost && state.selected?.ip) state.adbHost = `${state.selected.ip}:`;
  renderAdb();
}

async function adbConnect() {
  const hp = state.adbHost.trim();
  if (!/^[\w.-]+:\d+$/.test(hp)) return toast('Enter the TV address and the port shown under Wireless debugging, e.g. 192.168.1.40:37123', true);
  state.adbBusy = true;
  renderAdb();
  const r = await bench.adb.connect(hp);
  state.adbBusy = false;
  toast(r.ok ? r.message : r.error, !r.ok);
  refreshAdb();
}

async function adbInstall(serial) {
  state.adbBusy = true;
  renderAdb();
  toast('Installing the TV app…');
  const r = await bench.adb.install(serial);
  state.adbBusy = false;
  toast(r.ok ? 'Installed and launched on the TV' : r.error, !r.ok);
  renderAdb();
}

// ---------------------------------------------------------------- library

function onDownloadProgress(p) {
  const item = state.library.find((v) => v.id === p.id);
  if (!item) return;
  if (p.error) {
    item.downloading = null;
    toast(`Download failed: ${p.error}`, true);
  } else if (p.done) {
    item.downloading = null;
  } else {
    item.downloading = { received: p.received, total: p.total };
  }
  renderVideos();
}

async function download(id) {
  const item = state.library.find((v) => v.id === id);
  item.downloading = { received: 0, total: item.downloadBytes };
  renderVideos();
  const r = await bench.library.download(id);
  state.library = await bench.library.list();
  if (r.ok && !state.settings.video) setSetting({ video: id });
  ensureVideoSelected();
  renderAll();
}

// ---------------------------------------------------------------- settings & matrix

function setSetting(patch) {
  Object.assign(state.settings, patch);
  bench.settings.set(patch);
  renderVideos();
  renderMatrix();
  renderRun();
}

function toggleIn(key, value) {
  const list = new Set(state.settings[key]);
  if (list.has(value)) list.delete(value);
  else list.add(value);
  setSetting({ [key]: [...list] });
}

function codecAvailability(codec) {
  if (!state.senderCodecs.includes(codec)) return { ok: false, why: 'This PC cannot encode it' };
  if (state.hello?.paired) {
    const rx = receiverCodecs(state.hello, state.settings.decoder);
    if (!rx.includes(codec)) return { ok: false, why: `The TV has no ${DECODER_MODES[state.settings.decoder].label.toLowerCase()} decoder for it` };
  }
  return { ok: true };
}

function nativeAvailability(codec) {
  if (!state.info?.nativeSender) return { ok: false, why: 'wbsend.exe is not built (native\\build.cmd)' };
  if (!NATIVE_CODECS.includes(codec)) return { ok: false, why: 'The native path supports H.264 and H.265' };
  return { ok: true };
}

function transportAvailability(transport, codec) {
  return transport === 'native' ? nativeAvailability(codec) : codecAvailability(codec);
}

function selectedTransports() {
  const t = (state.settings.transports || ['webrtc']).filter((x) => TRANSPORTS[x]);
  return t.length ? t : ['webrtc'];
}

function buildCases() {
  const s = state.settings;
  if (s.screenTest) {
    // Screen-only measurement of something outside the app (e.g. Miracast mirroring the PC
    // screen to the TV): the pattern is shown and the TV times what reaches its screen.
    return [{ transport: 'screen', codec: '-', width: 0, height: 0, fps: 60, bitrateKbps: 0, decoderMode: '-', index: 1, total: 1, label: s.screenTest }];
  }
  const transports = selectedTransports();
  const cases = [];
  // Transport is innermost so the same configuration runs back to back on both paths.
  for (const hgt of [...s.resolutions].sort((a, b) => a - b)) {
    for (const fps of [...s.fpsList].sort((a, b) => a - b)) {
      for (const codec of CODECS.filter((c) => s.codecs.includes(c))) {
        for (const transport of transports) {
          if (!transportAvailability(transport, codec).ok) continue;
          cases.push({ transport, codec, width: RES_W[hgt], height: hgt, fps, bitrateKbps: kbpsFor(hgt, fps, s.bitrate), decoderMode: transport === 'native' ? 'hw' : s.decoder });
        }
      }
    }
  }
  const tag = transports.length > 1 || transports[0] !== 'webrtc';
  cases.forEach((c, i) => {
    c.index = i + 1;
    c.total = cases.length;
    c.label = `${CODEC_LABEL[c.codec]} ${c.width}×${c.height} @ ${c.fps}${tag ? ` · ${TRANSPORTS[c.transport].short}` : ''}`;
  });
  return cases;
}

function runBlocker() {
  if (!state.selected) return 'Pick a receiver first';
  if (state.conn !== 'connected' || !state.link) return 'Not connected to the TV';
  if (!state.hello?.paired) return 'Pair with the TV first';
  const v = state.library.find((x) => x.id === state.settings.video);
  if (!v || !v.available) return 'Choose a test video';
  if (!buildCases().length) return 'Select at least one codec, resolution and frame rate';
  return null;
}

// ---------------------------------------------------------------- run

async function startRun() {
  const why = runBlocker();
  if (why) {
    toast(why, true);
    return null;
  }
  const cases = buildCases();
  const video = state.library.find((v) => v.id === state.settings.video);
  const settings = { ...state.settings };
  state.report = null;
  state.run = { running: true, total: cases.length, index: 0, current: null, phase: 'preparing', phaseEnds: 0, done: [], live: {}, chart: [], startedAt: Date.now() };
  renderAll();
  $('runCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const source = new FrameSource(video, previewEl);
  let results = [];
  let timeline = [];
  let aborted = false;
  try {
    state.run.sourceMeta = await source.prepare();
    await state.adbReady; // adb lookup started on connect; telemetry needs its result
    await bench.power.block();
    if (state.adb?.serial && settings.adbTelemetry) await bench.adb.telemetryStart(state.adb.serial);
    state.link.send({ t: 'run-begin', total: cases.length, video: video.title });
    const link = state.link;
    const dev = state.selected;
    // Screen-only runs: the TV may leave the network while mirroring (Fire TV's Miracast receiver).
    const reconnect = async () => {
      link.close();
      await link.connect(4000);
      await sayHello(link, dev);
      state.link = link;
      state.conn = 'connected';
      state.connError = null;
      renderAll();
    };
    const runner = new BenchRunner({ link, source, settings, tvHello: state.hello, onEvent: onRunEvent, reconnect });
    state.runner = runner;
    ({ results, timeline } = await runner.run(cases));
    aborted = runner.aborted;
  } catch (e) {
    toast(e.message, true);
    log(`run error: ${e.message}`);
  } finally {
    try {
      if (state.link?.open) state.link.send({ t: 'run-end', message: aborted ? 'Run stopped' : 'Run finished' });
    } catch {
      // ignore
    }
    await bench.adb.telemetryStop();
    await bench.power.unblock();
    source.dispose();
    previewEl.replaceChildren(h('span', { class: 'ph' }, 'Preview appears here during a run'));
    state.runner = null;
    state.run.running = false;
  }

  if (results.length) {
    const run = assembleRun(cases, results, timeline, video, settings);
    try {
      state.report = { run, files: await bench.report.export(run) };
    } catch (e) {
      state.report = { run, files: null };
      toast(`Could not write the spreadsheet: ${e.message}`, true);
    }
  }
  renderAll();
  if (state.report) setTimeout(() => $('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  return state.report;
}

function assembleRun(cases, results, timeline, video, settings) {
  const codecs = CODECS.filter((c) => cases.some((x) => x.codec === c));
  const transports = Object.keys(TRANSPORTS).filter((t) => cases.some((x) => x.transport === t));
  if (cases.some((x) => x.transport === 'screen')) transports.push('screen');
  return {
    startedAt: state.run.startedAt,
    finishedAt: Date.now(),
    desktop: state.info.desktop,
    tv: {
      ...state.hello.tv,
      display: state.hello.display,
      decoders: state.hello.decoders,
      receiverCodecs: state.hello.receiverCodecs,
    },
    video: {
      id: video.id,
      kind: video.kind,
      title: video.title,
      subtitle: video.subtitle,
      file: video.file || video.path || null,
      content: video.content,
      license: video.license,
      attribution: video.attribution || null,
      sourcePage: video.sourcePage || null,
      sourceWidth: state.run.sourceMeta?.width ?? null,
      sourceHeight: state.run.sourceMeta?.height ?? null,
      sourceFps: state.run.sourceMeta?.fps ?? null,
      latencyFrom:
        video.kind === 'display'
          ? `screen capture (native: Desktop Duplication present time; WebRTC: ${state.run.sourceMeta?.latencyFrom === 'capture' ? 'Chromium capture time' : 'frame draw time'})`
          : 'frame handed to the encoder',
    },
    settings: {
      ...settings,
      codecs,
      transports,
      transportLabels: Object.fromEntries(transports.map((t) => [t, TRANSPORTS[t]?.label ?? 'Screen mirroring (timed on the TV screen)'])),
      decoderLabel: DECODER_MODES[settings.decoder].label,
      bitrateLabel: BITRATE_PRESETS[settings.bitrate].label,
      renderLabel: RENDER_MODES[settings.render].label,
      h264Label: H264_PROFILES[settings.h264Profile].label,
      playoutLabel: PLAYOUT_MODES[settings.playout].label,
      pacingLabel: PACING_MODES[settings.pacing]?.label ?? settings.pacing,
      latencyProfileLabel: LATENCY_PROFILES[settings.latencyProfile]?.label ?? settings.latencyProfile,
      senderTrials: state.info?.senderTrials || '',
    },
    senderCodecs: state.senderCodecs,
    adbTelemetry: !!state.adb?.serial,
    results,
    timeline,
  };
}

function onRunEvent(ev) {
  const run = state.run;
  if (!run) return;
  if (ev.type === 'case-start') {
    run.index = ev.c.index;
    run.current = ev.c;
    run.phase = 'connecting';
    run.phaseEnds = 0;
    run.notice = null;
    run.live = { adbCpu: run.live.adbCpu, socTemp: run.live.socTemp };
    run.chart = [];
    run.caseStart = performance.now();
  } else if (ev.type === 'phase') {
    run.phase = ev.phase;
    run.phaseEnds = Date.now() + ev.seconds * 1000;
    if (ev.phase === 'measure') run.measureAt = (performance.now() - run.caseStart) / 1000;
  } else if (ev.type === 'tx-sample') {
    const x = txInstant(ev.prev, ev.sample);
    Object.assign(run.live, x);
    if (x.txFps != null) run.chart.push({ t: ev.sample.at / 1000, tx: x.txFps });
  } else if (ev.type === 'rx-sample') {
    const x = rxInstant(ev.prev, ev.sample);
    Object.assign(run.live, x);
    if (x.rxFps != null) run.chart.push({ t: ev.sample.at / 1000, rx: x.rxFps });
  } else if (ev.type === 'lat-sample') {
    const sorted = ev.batch.map((s) => s.ms).sort((a, b) => a - b);
    run.live.latency = sorted[Math.floor(sorted.length / 2)];
  } else if (ev.type === 'notice') {
    run.notice = ev.text;
    log(`notice: ${ev.text}`);
    renderAll();
  } else if (ev.type === 'live') {
    // Native path: values are already per-second rates.
    for (const [k, v] of Object.entries(ev.values)) if (v != null) run.live[k] = v;
    if (ev.side === 'tx' && ev.values.txFps != null) run.chart.push({ t: ev.t, tx: ev.values.txFps });
    if (ev.side === 'rx' && ev.values.rxFps != null) run.chart.push({ t: ev.t, rx: ev.values.rxFps });
  } else if (ev.type === 'case-done') {
    run.done.push(ev.result);
    const r = ev.result;
    log(
      `#${r.index} ${r.status} ${r.label} | rx ${fmt(r.rx?.fps)} fps ${r.rx?.width ?? '?'}x${r.rx?.height ?? '?'} ` +
        `dec=${r.rx?.decoder ?? '?'}(${r.rx?.decoderHw ? 'HW' : 'SW'}) ${fmt(r.rx?.decodeMs, 2)}ms | tx ${fmt(r.tx?.fps)} fps ` +
        `${r.tx?.width ?? '?'}x${r.tx?.height ?? '?'} enc=${r.tx?.encoder ?? '?'} ${fmt(r.tx?.kbps ? r.tx.kbps / 1000 : null)}Mbps ` +
        `| latency median ${fmt(r.latency?.median, 0)} p95 ${fmt(r.latency?.p95, 0)} ms (n=${r.latency?.samples ?? 0}, sync rtt ${fmt(r.latency?.syncRttMs)}, capture ${fmt(r.latency?.captureDelayMs)}) ` +
        `jb ${fmt(r.rx?.jitterBufferMs, 0)} pacer ${fmt(r.tx?.packetSendDelayMs, 0)} enc ${fmt(r.tx?.encodeMs, 1)} dec ${fmt(r.rx?.decodeMs, 1)} | adb cpu ${fmt(r.adb?.cpuPct, 0)}% ${fmt(r.adb?.socTempC)}C | pc net ${r.tx?.network ?? '?'} | ${r.notes}`,
    );
    if (r.screenLatency) {
      log(`#${r.index}   screen probe (PC screen -> TV screen) median ${fmt(r.screenLatency.median, 1)} p95 ${fmt(r.screenLatency.p95, 1)} ms, ${fmt(r.screenLatency.shownFps ?? r.rx?.displayedFps)} new frames/s (n=${r.screenLatency.samples})`);
    }
    if (r.transport !== 'native' && (r.tx?.captureToEncodedMs != null || r.rx?.direct || r.latencyProbe)) {
      log(
        `#${r.index}   webrtc ${r.profile}${r.sender ? ` (${r.sender} sender)` : ''} | capture->encoded ${fmt(r.tx?.captureToEncodedMs, 1)} ms (sei ${r.tx?.seiTagged ?? 0}) | ` +
          `direct ${!!r.rx?.direct} | probe median ${fmt(r.latencyProbe?.median, 0)} p95 ${fmt(r.latencyProbe?.p95, 0)} | ` +
          `renderer-decoded same frame ${fmt(r.timingCheck?.rendererMinusDecodedMedianMs, 1)} ms (n=${r.timingCheck?.samples ?? 0})`,
      );
    }
    if (r.rx?.displayedFps != null) {
      log(
        `#${r.index}   screen median ${fmt(r.displayLatency?.median, 1)} p95 ${fmt(r.displayLatency?.p95, 1)} ms | shown ${fmt(r.rx.displayedFps)} fps, ` +
          `repeats ${r.rx.repeats}, replaced ${r.rx.displayDropped}, decode->screen ${fmt(r.rx.decodeToDisplayMs, 1)} ms | ` +
          `pacing ${r.rx.pacing} lead ${fmt(r.rx.pacingLeadMs, 1)} slack ${fmt(r.rx.pacingSlackMs, 1)} | prep ${fmt(r.tx?.prepMs, 2)} enc ${fmt(r.tx?.encodeMs, 2)} ms | ` +
          `decode->ready ${fmt(r.latency?.median, 1)} p95 ${fmt(r.latency?.p95, 1)}`,
      );
    }
  }
  renderRun();
}

// ---------------------------------------------------------------- auto mode

async function autoRun(a) {
  log(`auto: ${JSON.stringify(a)}`);
  if (!a.device) throw new Error('--device=<TV IP> is required with --auto');
  const found = await waitUntil(() => state.devices.find((d) => d.ip === a.device), 8000);
  const dev = found || { id: null, ip: a.device, name: a.device, manual: true, wsPort: state.info.wsPort };
  if (!found) state.manual.push(dev);
  await selectDevice(dev);
  if (state.conn !== 'connected') throw new Error(state.connError || 'Could not connect');
  log(`auto: connected to ${state.hello.tv?.name} (${state.hello.tv?.model}), paired=${state.hello.paired}`);
  if (!state.hello.paired) {
    if (!a['pin-file']) throw new Error('The TV is not paired; pass --pin-file=<file> and write the PIN shown on the TV into it');
    await startPairing();
    log(`auto: PIN is on the TV; waiting for it in ${a['pin-file']}`);
    const pin = await waitUntil(() => bench.auto.readPin(a['pin-file']), 300000, 1000);
    if (!pin) throw new Error('No PIN provided');
    $('pinInput').value = pin;
    if (!(await submitPin(pin))) throw new Error(`Pairing failed: ${$('pinError').textContent}`);
    log('auto: paired');
  }
  const list = (v, map = (x) => x) => String(v).split(',').map((x) => map(x.trim())).filter((x) => x !== '' && x != null);
  const patch = {};
  if (a.codecs) patch.codecs = list(a.codecs, (x) => x.toUpperCase().replace('.', ''));
  if (a.res) patch.resolutions = list(a.res, Number);
  if (a.fps) patch.fpsList = list(a.fps, Number);
  if (a.decoder) patch.decoder = a.decoder;
  if (a.bitrate) patch.bitrate = a.bitrate;
  if (a.warmup) patch.warmupSec = Number(a.warmup);
  if (a.measure) patch.measureSec = Number(a.measure);
  if (a.video) patch.video = a.video;
  if (a.pipeline) patch.pipeline = a.pipeline;
  if (a.render) patch.render = a.render;
  if (a.h264) patch.h264Profile = a.h264;
  if (a.transport) patch.transports = list(a.transport, (x) => x.toLowerCase());
  if (a.playout) patch.playout = a.playout;
  if (a['tv-trials']) patch.tvFieldTrials = a['tv-trials'];
  if (a.pacing) patch.pacing = a.pacing;
  if (a['latency-profile']) patch.latencyProfile = a['latency-profile'];
  if (a['gaming-sender']) patch.gamingSender = a['gaming-sender'];
  if (a['slot-fps']) patch.slotFps = Number(a['slot-fps']);
  if (a.preencoded !== undefined) patch.preencoded = !['0', 'false', 'off'].includes(String(a.preencoded));
  if (a['slot-size']) patch.slotSize = String(a['slot-size']);
  if (a['slot-kind']) patch.slotKind = String(a['slot-kind']);
  if (a['push-frames'] !== undefined) patch.pushFrames = !['0', 'false', 'off'].includes(String(a['push-frames']));
  if (a['screen-probe'] !== undefined) patch.screenProbe = !['0', 'false', 'off'].includes(String(a['screen-probe']));
  if (a['screen-test']) patch.screenTest = String(a['screen-test']);  if (a['nvenc-preset']) patch.nvencPreset = Number(a['nvenc-preset']);
  if (a['native-opts']) patch.nativeOpts = a['native-opts'];
  if (a['sender-args']) patch.senderArgs = a['sender-args'];
  if (a.latency !== undefined) patch.measureLatency = !['0', 'false', 'off'].includes(String(a.latency));
  if (a['adb-telemetry'] !== undefined) patch.adbTelemetry = !['0', 'false', 'off'].includes(String(a['adb-telemetry']));
  // Command-line overrides apply to this run only; they are not saved as the user's settings.
  Object.assign(state.settings, patch);
  renderAll();
  log(`auto: ${buildCases().length} tests, video=${state.settings.video}, send codecs=${state.senderCodecs.join(',')}, tv codecs=${receiverCodecs(state.hello, state.settings.decoder).join(',')}`);
  if (a['shot-dir']) await shot(a['shot-dir'], '01-ready', 'matrixCard');
  let shotTimer = 0;
  if (a['shot-dir']) {
    shotTimer = setTimeout(() => shot(a['shot-dir'], '02-running', 'runCard'), (state.settings.warmupSec + state.settings.measureSec / 2 + 4) * 1000);
  }
  const rep = await startRun();
  clearTimeout(shotTimer);
  log(`auto: report ${rep?.files?.xlsx ?? '(none)'}`);
  if (a['shot-dir']) {
    await sleep(800);
    await shot(a['shot-dir'], '03-results', 'resultsCard');
  }
  if (a.quit) await bench.quit(0);
}

async function shot(dir, name, cardId) {
  $(cardId)?.scrollIntoView({ block: 'start' });
  await sleep(400);
  const file = `${dir}\\${name}.png`;
  await bench.screenshot(file);
  log(`auto: screenshot ${file}`);
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderTop();
  renderDevices();
  renderAdb();
  renderReceiver();
  renderVideos();
  renderMatrix();
  renderRun();
  renderResults();
}

function renderTop() {
  const d = state.info?.desktop || {};
  const gpu = (d.gpus || []).find((g) => g.active) || (d.gpus || [])[0];
  mount(
    'desktopMeta',
    h('span', { class: 'chip-static', title: 'This PC' }, d.host || ''),
    gpu && h('span', { class: 'chip-static', title: `GPU (${state.info.gpuPreference})` }, gpu.name || `GPU ${gpu.vendorId}`),
    h('span', { class: 'chip-static', title: 'Codecs this PC can send' }, `Sends ${state.senderCodecs.map((c) => CODEC_LABEL[c]).join(' · ')}`),
  );
}

function renderDevices() {
  const list = allDevices();
  const items = list.map((d) => {
    const sel = state.selected && (state.selected.id ? state.selected.id === d.id : state.selected.ip === d.ip);
    const badge = d.busy ? h('span', { class: 'badge busy' }, 'busy') : d.paired ? h('span', { class: 'badge ok' }, 'paired') : d.manual ? h('span', { class: 'badge' }, 'manual') : h('span', { class: 'badge warn' }, 'new');
    return h(
      'button',
      { class: `device${sel ? ' selected' : ''}`, onclick: () => selectDevice(d) },
      h('span', { class: 'tv-icon' }),
      h('span', null, h('div', { class: 'device-name' }, d.name || d.ip), h('div', { class: 'device-sub' }, [d.model, d.ip].filter(Boolean).join(' · '))),
      badge,
    );
  });
  mount(
    'deviceList',
    items.length
      ? items
      : h('div', { class: 'empty' }, 'Looking for TVs… Open ', h('b', null, 'WebRTC Bench'), ' on your Google TV. It must be on the same network as this PC.'),
  );
}

function renderAdb() {
  const a = state.adb;
  const box = [];
  box.push(h('div', { class: 'side-title' }, h('span', null, 'ADB (optional)')));
  if (!a) {
    box.push(h('div', { class: 'adb-box muted' }, 'Checking for adb…'));
  } else if (!a.available) {
    box.push(h('div', { class: 'adb-box' }, h('div', { class: 'muted' }, 'adb was not found. Install Android platform-tools to install the TV app from here and to add TV CPU and temperature to reports.')));
  } else {
    const ready = a.devices?.filter((d) => d.state === 'device') || [];
    const target = a.serial || (ready.length === 1 ? ready[0].serial : null);
    box.push(
      h(
        'div',
        { class: 'adb-box' },
        h(
          'div',
          { class: 'adb-status' },
          h('span', { class: `dot ${a.serial ? 'ok' : ready.length ? 'warn' : ''}` }),
          a.serial ? h('span', null, 'TV connected: ', h('span', { class: 'mono' }, a.serial)) : ready.length ? h('span', null, `${ready.length} device(s), none matches the selected TV`) : h('span', { class: 'muted' }, 'No device connected'),
        ),
        a.serial &&
          h(
            'label',
            { class: 'check', style: { fontSize: '12.5px' } },
            h('input', { type: 'checkbox', checked: state.settings.adbTelemetry, disabled: !!state.run?.running, onchange: (e) => setSetting({ adbTelemetry: e.target.checked }) }),
            'Record TV CPU % and SoC temperature during runs',
          ),
        h(
          'div',
          { class: 'adb-row' },
          h('input', {
            value: state.adbHost,
            placeholder: 'TV ip:port (Wireless debugging)',
            spellcheck: 'false',
            oninput: (e) => (state.adbHost = e.target.value),
          }),
          h('button', { class: 'btn btn-small', disabled: state.adbBusy, onclick: adbConnect }, 'Connect'),
        ),
        h(
          'div',
          { class: 'adb-row' },
          h(
            'button',
            { class: 'btn btn-small', disabled: !target || state.adbBusy || !state.info.apk, title: state.info.apk || 'APK not found', onclick: () => adbInstall(target) },
            'Install / update TV app',
          ),
          h('button', { class: 'btn btn-small btn-ghost', disabled: !target || state.adbBusy, onclick: () => bench.adb.launch(target).then(() => toast('Launched on the TV')) }, 'Launch'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: refreshAdb }, 'Refresh'),
        ),
      ),
    );
  }
  mount('adbSection', box);
}

function cardHead(n, title, done, ...actions) {
  return h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, h('span', { class: `step${done ? ' done' : ''}` }, done ? '✓' : n), title), h('div', { class: 'card-actions' }, actions));
}

function renderReceiver() {
  const s = state.selected;
  const paired = !!state.hello?.paired;
  const parts = [cardHead(1, 'Receiver', state.conn === 'connected' && paired, paired && h('button', { class: 'btn btn-small btn-ghost', onclick: unpair }, 'Unpair'))];
  if (!s) {
    parts.push(
      h(
        'div',
        { class: 'notice' },
        h('div', { class: 'grow' }, h('div', null, h('b', null, 'Pick a TV from the list on the left.')), h('div', { class: 'muted' }, 'Install WebRTC Bench on the TV (ADB panel, bottom left) and open it. TVs on this network appear automatically.')),
      ),
    );
  } else if (state.conn === 'connecting') {
    parts.push(h('div', { class: 'notice' }, h('span', { class: 'spinner' }), h('div', null, `Connecting to ${s.name || s.ip}…`)));
  } else if (state.conn === 'error') {
    parts.push(
      h(
        'div',
        { class: 'notice warn' },
        h('div', { class: 'grow' }, h('b', null, `Can't reach ${s.name || s.ip}`), h('div', { class: 'muted' }, state.connError)),
        h('button', { class: 'btn', onclick: () => selectDevice(s) }, 'Retry'),
      ),
    );
  } else if (state.hello) {
    const tv = state.hello.tv || {};
    const disp = state.hello.display || {};
    parts.push(
      h(
        'div',
        { class: 'kv-grid' },
        kv('Name', tv.name),
        kv('Model', `${tv.manufacturer || ''} ${tv.model || ''}`.trim()),
        kv('Android', `${tv.android} (API ${tv.sdk})`),
        kv('Chip', tv.soc || '–'),
        kv('Address', `${tv.ip || s.ip}:${tv.wsPort || state.info.wsPort}`),
        kv('Display', disp.width ? `${disp.width}×${disp.height} @ ${Math.round(disp.refreshRate)} Hz` : '–'),
        kv('HDR', (disp.hdr || []).join(', ') || 'none reported'),
        kv('CPU', `${tv.cpuCores || '?'} cores · ${(tv.abis || [])[0] || ''}`),
        kv('Network', netLabel(tv.network)),
      ),
    );
    if (!paired) {
      parts.push(
        h(
          'div',
          { class: 'notice', style: { marginTop: '14px' } },
          h('div', { class: 'grow' }, h('b', null, 'Pair this PC with the TV'), h('div', { class: 'muted' }, 'The TV will show a 6-digit PIN. Pairing is remembered on both sides.')),
          h('button', { class: 'btn btn-primary', onclick: startPairing }, 'Pair'),
        ),
      );
    } else {
      const hw = (state.hello.decoders || []).filter((d) => d.hardware);
      const byType = new Map();
      for (const d of hw) if (!byType.has(d.type)) byType.set(d.type, d);
      parts.push(
        h(
          'div',
          { class: 'codec-chips' },
          h('span', { class: 'hint', style: { alignSelf: 'center', marginRight: '4px' } }, 'Hardware decoders:'),
          [...byType.values()].map((d) =>
            h('span', { class: 'cchip hw', title: `${d.name} · max ${d.maxWidth}×${d.maxHeight} · ${d.maxInstances} instances` }, d.type.replace('video/', '').replace('x-vnd.on2.', '').toUpperCase(), h('span', { class: 'tag' }, `${d.maxHeight >= 2160 ? '4K' : `${d.maxHeight}p`}`)),
          ),
        ),
      );
    }
  }
  mount('receiverCard', parts);
}

function netLabel(n) {
  if (!n) return '–';
  if (n.transport === 'ethernet') return 'Ethernet';
  if (n.transport !== 'wifi') return n.transport || '–';
  const band = n.wifiFreqMhz ? (n.wifiFreqMhz >= 5900 ? '6 GHz' : n.wifiFreqMhz >= 4900 ? '5 GHz' : '2.4 GHz') : '';
  return `Wi-Fi ${band} · ${n.wifiRssi ?? '?'} dBm · ${n.wifiLinkMbps ?? '?'} Mbps`;
}

function kv(k, v) {
  return h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v ?? '–'));
}

function renderVideos() {
  const sel = state.settings.video;
  const tiles = state.library.map((v) => {
    const dl = v.downloading;
    let foot;
    if (dl) {
      const pct = dl.total ? Math.min(100, (100 * dl.received) / dl.total) : 0;
      foot = h(
        'div',
        { style: { width: '100%' } },
        h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })),
        h('div', { class: 'vt-foot', style: { marginTop: '6px' } }, h('span', null, `${pct.toFixed(0)}% of ${mb(dl.total)}`), h('button', { class: 'link-btn', onclick: (e) => (e.stopPropagation(), bench.library.cancel(v.id)) }, 'Cancel')),
      );
    } else if (!v.available && v.kind === 'file' && !v.custom) {
      foot = h('div', { class: 'vt-foot' }, h('span', null, v.license), h('button', { class: 'btn btn-small', onclick: (e) => (e.stopPropagation(), download(v.id)) }, `Download ${mb(v.downloadBytes)}`));
    } else {
      foot = h(
        'div',
        { class: 'vt-foot' },
        h('span', null, v.license, v.sizeBytes ? ` · ${mb(v.sizeBytes)}` : ''),
        v.sourcePage
          ? h('button', { class: 'link-btn', onclick: (e) => (e.stopPropagation(), bench.openExternal(v.sourcePage)) }, 'source')
          : v.custom
            ? h('button', { class: 'link-btn', onclick: async (e) => (e.stopPropagation(), (state.library = await bench.library.remove(v.id)), ensureVideoSelected(), renderVideos()) }, 'remove')
            : null,
      );
    }
    return h(
      'div',
      {
        class: `vtile${sel === v.id ? ' selected' : ''}${v.available ? '' : ' unavailable'}`,
        onclick: () => v.available && !state.run?.running && setSetting({ video: v.id }),
        title: v.attribution ? `Credit: ${v.attribution}` : null,
      },
      h('span', { class: 'vt-kind' }, v.kind === 'pattern' ? 'generated' : v.kind === 'display' ? 'live' : v.custom ? 'your file' : 'clip'),
      h('div', { class: 'vt-title' }, v.title),
      h('div', { class: 'vt-sub' }, v.subtitle),
      h('div', { class: 'vt-desc' }, v.content),
      foot,
    );
  });
  tiles.push(
    h(
      'div',
      { class: 'vtile add', onclick: async () => ((state.library = await bench.library.add()), renderVideos()) },
      h('div', { style: { fontSize: '26px' } }, '+'),
      h('div', null, 'Add a video file'),
    ),
  );
  const chosen = state.library.find((v) => v.id === sel);
  mount(
    'videoCard',
    cardHead(2, 'Test video', !!chosen?.available, h('button', { class: 'btn btn-small btn-ghost', onclick: () => bench.library.openFolder() }, 'Open folder')),
    h('div', { class: 'video-grid' }, tiles),
  );
}

function renderMatrix() {
  const s = state.settings;
  const disabled = !!state.run?.running;
  const transports = selectedTransports();
  const codecChips = CODECS.map((c) => {
    const avs = transports.map((t) => transportAvailability(t, c));
    const ok = avs.some((a) => a.ok);
    const why = avs.find((a) => !a.ok)?.why;
    return h('button', { class: `chip${s.codecs.includes(c) && ok ? ' on' : ''}`, disabled: disabled || !ok, title: why || null, onclick: () => toggleIn('codecs', c) }, CODEC_LABEL[c]);
  });
  const transportChips = Object.entries(TRANSPORTS).map(([k, t]) => {
    const missing = k === 'native' && !state.info?.nativeSender;
    return h(
      'button',
      {
        class: `chip${transports.includes(k) && !missing ? ' on' : ''}`,
        disabled: disabled || missing,
        title: missing ? 'wbsend.exe is not built (run native\\build.cmd)' : t.help,
        onclick: () => {
          const next = new Set(transports);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          if (next.size) setSetting({ transports: [...next] });
        },
      },
      t.label,
    );
  });
  const resChips = RESOLUTIONS.map((r) => h('button', { class: `chip${s.resolutions.includes(r) ? ' on' : ''}`, disabled, onclick: () => toggleIn('resolutions', r) }, `${resName(r)}`, h('span', { class: 'faint', style: { marginLeft: '6px', fontWeight: 500 } }, `${RES_W[r]}×${r}`)));
  const fpsChips = FPS_OPTIONS.map((f) => h('button', { class: `chip${s.fpsList.includes(f) ? ' on' : ''}`, disabled, onclick: () => toggleIn('fpsList', f) }, `${f} fps`));
  const seg = (key, options) =>
    h(
      'div',
      { class: 'seg' },
      Object.entries(options).map(([k, o]) => h('button', { class: s[key] === k ? 'on' : '', disabled, title: o.help || null, onclick: () => setSetting({ [key]: k }) }, o.label)),
    );
  const cases = buildCases();
  const perTest = s.warmupSec + s.measureSec + PER_TEST_OVERHEAD_SEC;
  const mins = Math.ceil((cases.length * perTest) / 60);
  mount(
    'matrixCard',
    cardHead(
      3,
      'Test matrix',
      cases.length > 0,
      Object.entries(PRESETS).map(([k, p]) =>
        h('button', { class: 'btn btn-small', disabled, onclick: () => setSetting({ codecs: p.codecs, resolutions: p.resolutions, fpsList: p.fpsList, warmupSec: p.warmupSec, measureSec: p.measureSec }) }, `${p.label} preset`),
      ),
    ),
    h(
      'div',
      { class: 'matrix-grid' },
      h('div', { class: 'label' }, 'Transport'),
      h(
        'div',
        { class: 'chips' },
        transportChips,
        h('span', { class: 'hint' }, transports.includes('native') ? 'Native: H.264/H.265 via NVENC → TV low-latency decoder (video file or display)' : 'Select both to compare them side by side'),
      ),
      h('div', { class: 'label' }, 'Codecs'),
      h('div', { class: 'chips' }, codecChips),
      h('div', { class: 'label' }, 'Resolutions'),
      h('div', { class: 'chips' }, resChips),
      h('div', { class: 'label' }, 'Frame rates'),
      h('div', { class: 'chips' }, fpsChips),
      h('div', { class: 'label' }, 'TV decoder'),
      h('div', { class: 'chips' }, seg('decoder', DECODER_MODES), h('span', { class: 'hint' }, DECODER_MODES[s.decoder].help)),
      h('div', { class: 'label' }, 'Bitrate'),
      h('div', { class: 'chips' }, seg('bitrate', BITRATE_PRESETS), h('span', { class: 'hint' }, `1080p30 ${fmt(kbpsFor(1080, 30, s.bitrate) / 1000)} Mbps · 4K60 ${fmt(kbpsFor(2160, 60, s.bitrate) / 1000)} Mbps`)),
      h('div', { class: 'label' }, 'Timing'),
      h(
        'div',
        { class: 'chips' },
        h('label', { class: 'inline-field' }, 'Warm-up', h('input', { class: 'num', type: 'number', min: 1, max: 30, value: s.warmupSec, disabled, onchange: (e) => setSetting({ warmupSec: clamp(e.target.value, 1, 30) }) }), 's'),
        h('label', { class: 'inline-field' }, 'Measure', h('input', { class: 'num', type: 'number', min: 3, max: 120, value: s.measureSec, disabled, onchange: (e) => setSetting({ measureSec: clamp(e.target.value, 3, 120) }) }), 's per test'),
      ),
      h('div', { class: 'label' }, 'WebRTC profile'),
      h(
        'div',
        { class: 'chips' },
        seg('latencyProfile', LATENCY_PROFILES),
        h(
          'span',
          { class: 'hint' },
          LATENCY_PROFILES[s.latencyProfile]?.help ?? '',
          s.latencyProfile !== (state.info?.launchProfile || 'standard') ? ' · restart the app to apply the PC pacer part' : '',
        ),
      ),
      h('div', { class: 'label' }, 'Jitter buffer'),
      h(
        'div',
        { class: 'chips' },
        seg('playout', PLAYOUT_MODES),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.measureLatency, disabled, onchange: (e) => setSetting({ measureLatency: e.target.checked }) }), 'Measure latency'),
        h('span', { class: 'hint' }, PLAYOUT_MODES[s.playout].help),
      ),
      h('div', { class: 'label' }, 'TV rendering'),
      h('div', { class: 'chips' }, seg('render', RENDER_MODES), h('span', { class: 'hint' }, RENDER_MODES[s.render].help)),
      h('div', { class: 'label' }, 'Frame pacing'),
      h('div', { class: 'chips' }, seg('pacing', PACING_MODES), h('span', { class: 'hint' }, PACING_MODES[s.pacing].help)),
      h('div', { class: 'label' }, 'H.264 profile'),
      h('div', { class: 'chips' }, seg('h264Profile', H264_PROFILES), h('span', { class: 'hint' }, H264_PROFILES[s.h264Profile].help)),
      h('div', { class: 'label' }, 'Source'),
      h(
        'div',
        { class: 'chips' },
        seg('pipeline', { canvas: { label: 'Canvas + overlay', help: 'Exact resolution and frame rate with a frame counter overlay' }, direct: { label: 'Direct', help: 'Send the decoded file as-is, scaled down by the encoder' } }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.tvOverlay, disabled, onchange: (e) => setSetting({ tvOverlay: e.target.checked }) }), 'Live stats on the TV'),
      ),
    ),
    h(
      'div',
      { class: 'summary-line' },
      h('div', null, h('strong', null, `${cases.length} test${cases.length === 1 ? '' : 's'}`), h('span', { class: 'muted' }, cases.length ? `  ·  about ${mins} min` : '')),
      h('div', { class: 'hint' }, 'Order: resolution → frame rate → codec. Each test uses a fresh WebRTC connection.'),
    ),
  );
}

function clamp(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function tile(k, v, unit, cls = '', small = false) {
  return h('div', { class: `tile ${cls}` }, h('div', { class: 'k' }, k), h('div', { class: `v${small ? ' small' : ''}`, title: typeof v === 'string' ? v : null }, v ?? '–', unit && v != null && v !== '–' ? h('span', { class: 'unit' }, unit) : null));
}

function latencyClass(ms) {
  if (ms == null) return '';
  return ms < 50 ? 'good' : ms < 100 ? 'mid' : 'bad';
}

function fpsClass(v, target) {
  if (v == null || !target) return '';
  return v >= target * 0.95 ? 'good' : v >= target * 0.8 ? 'mid' : 'bad';
}

function renderRun() {
  const run = state.run;
  const blocker = runBlocker();
  const head = cardHead(
    4,
    'Run',
    !!state.report,
    run?.running
      ? stopBtn
      : h('button', { class: 'btn btn-primary btn-big', disabled: !!blocker, title: blocker, onclick: startRun }, state.report ? 'Run again' : 'Start benchmark'),
  );
  if (!run) {
    const mirroring = state.library.find((v) => v.id === state.settings.video)?.kind === 'display';
    mount(
      'runCard',
      head,
      h(
        'div',
        { class: 'muted' },
        blocker
          ? `${blocker}.`
          : mirroring
            ? 'Mirroring mode: your main monitor is streamed to the TV. Start a game or a full-screen video on it, then start the run; frames where nothing changed are left out of latency.'
            : 'Ready. The PC streams each test to the TV; keep this window open (it can be behind other windows).',
      ),
    );
    drawChart();
    return;
  }
  const c = run.current;
  const L = run.live;
  const pct = run.total ? (100 * (run.done.length + (run.running && c ? 0.5 : 0))) / run.total : 0;
  const remaining = run.phaseEnds ? Math.max(0, Math.ceil((run.phaseEnds - Date.now()) / 1000)) : null;
  const phaseText = { preparing: 'Loading video…', connecting: 'Connecting…', setup: 'Connecting…', warmup: 'Warming up', measure: 'Measuring', stopping: 'Finishing' }[run.phase] || run.phase;
  const status = run.running
    ? h('div', { class: 'run-status' }, h('div', { class: 'now' }, c ? `Test ${c.index} of ${run.total} · ${c.label}` : 'Preparing…'), h('div', { class: 'sub' }, phaseText, remaining != null && ['warmup', 'measure'].includes(run.phase) ? ` · ${remaining}s` : '', c && c.transport !== 'screen' ? ` · ${fmt(c.bitrateKbps / 1000)} Mbps target · ${DECODER_MODES[c.decoderMode]?.label ?? c.decoderMode} decoder` : ''), h('div', { class: 'bar' }, h('div', { style: { width: `${pct}%` } })))
    : h('div', { class: 'run-status' }, h('div', { class: 'now' }, `Finished ${run.done.length} of ${run.total} tests`), h('div', { class: 'sub' }, state.report?.files ? 'Spreadsheet saved. See results below.' : ''), h('div', { class: 'bar' }, h('div', { style: { width: `${pct}%` } })));

  const target = c?.fps;
  const tiles = h(
    'div',
    { class: 'tiles' },
    tile('Sent', L.txFps != null ? fmt(L.txFps) : '–', 'fps', fpsClass(L.txFps, target)),
    tile('Decoded on TV', L.rxFps != null ? fmt(L.rxFps) : '–', 'fps', fpsClass(L.rxFps, target)),
    tile('Latency', L.latency != null ? fmt(L.latency, 0) : '–', 'ms', latencyClass(L.latency)),
    tile('Received', L.rxWidth ? `${L.rxWidth}×${L.rxHeight}` : '–', '', c && L.rxHeight && L.rxHeight < c.height ? 'bad' : '', true),
    tile('Bitrate', L.rxKbps != null ? fmt(L.rxKbps / 1000) : '–', 'Mbps'),
    tile('Decode time', L.decodeMs != null ? fmt(L.decodeMs, 1) : '–', 'ms'),
    tile('TV decoder', L.decoder ? `${L.decoderHw ? 'HW' : L.decoderHw === false ? 'SW' : ''} ${L.decoder}` : '–', '', '', true),
    tile('PC encoder', L.encoder || '–', '', '', true),
    L.screenLatency != null
      ? tile('On screen', fmt(L.screenLatency, 0), 'ms capture → shown', latencyClass(L.screenLatency))
      : tile('Jitter buffer', L.jbMs != null ? fmt(L.jbMs, 0) : '–', 'ms'),
    tile('Packet loss', L.lossPct != null ? fmt(L.lossPct, 2) : '–', '%', L.lossPct > 1 ? 'bad' : ''),
    tile('TV CPU', L.adbCpu != null ? fmt(L.adbCpu, 0) : L.appCpuPct != null ? fmt(L.appCpuPct, 0) : '–', L.adbCpu != null ? '% (adb)' : '% app'),
    tile('TV SoC temp', L.socTemp != null ? fmt(L.socTemp) : '–', '°C'),
    tile('Rendered on TV', L.renderedFps != null ? fmt(L.renderedFps) : '–', 'fps', fpsClass(L.renderedFps, target)),
    h('div', { class: 'chart-wrap' }, h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--blue)' } }), 'sent fps'), h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'decoded fps'), h('span', null, h('i', { style: { background: 'var(--faint)' } }), 'target')), chartCanvas),
  );
  const previewWrap = h('div', null, previewEl, h('div', { class: 'hint', style: { marginTop: '6px' } }, run.sourceMeta?.width ? `Source ${run.sourceMeta.width}×${run.sourceMeta.height}${run.sourceMeta.fps ? ` @ ${run.sourceMeta.fps} fps` : ''}` : ''));
  mount(
    'runCard',
    head,
    h('div', { class: 'run-top' }, status),
    run.running && run.notice && h('div', { class: 'notice' }, h('div', null, run.notice)),
    h('div', { class: 'live' }, previewWrap, tiles),
    run.done.length > 0 && h('div', { class: 'done-list' }, run.done.map((r) => h('span', { class: `pill st-${r.status}`, title: r.notes || r.status }, `${r.index}. ${r.label} · ${r.rx?.fps != null ? `${fmt(r.rx.fps)} fps` : r.status.toLowerCase()}`))),
  );
  drawChart();
}

function drawChart() {
  const run = state.run;
  const cv = chartCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, Math.round((cv.clientWidth || 600) * dpr));
  const hgt = Math.round(110 * dpr);
  if (cv.width !== w || cv.height !== hgt) {
    cv.width = w;
    cv.height = hgt;
  }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, hgt);
  if (!run?.current) return;
  const target = run.current.fps;
  const span = state.settings.warmupSec + state.settings.measureSec + 3;
  const pts = run.chart;
  const ymax = Math.max(target * 1.25, ...pts.map((p) => p.tx ?? p.rx ?? 0)) || 1;
  const X = (t) => (t / span) * w;
  const Y = (v) => hgt - (v / ymax) * (hgt - 8 * dpr) - 2 * dpr;
  g.lineWidth = 1 * dpr;
  g.strokeStyle = '#5c6b7e';
  g.setLineDash([5 * dpr, 5 * dpr]);
  g.beginPath();
  g.moveTo(0, Y(target));
  g.lineTo(w, Y(target));
  g.stroke();
  if (run.measureAt) {
    g.strokeStyle = '#33435a';
    g.beginPath();
    g.moveTo(X(run.measureAt), 0);
    g.lineTo(X(run.measureAt), hgt);
    g.stroke();
  }
  g.setLineDash([]);
  for (const [key, color] of [
    ['tx', '#63b3ed'],
    ['rx', '#4fd1c5'],
  ]) {
    const series = pts.filter((p) => p[key] != null);
    if (series.length < 1) continue;
    g.strokeStyle = color;
    g.lineWidth = 2.2 * dpr;
    g.beginPath();
    series.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p[key])) : g.moveTo(X(p.t), Y(p[key]))));
    g.stroke();
  }
}

function renderResults() {
  const card = $('resultsCard');
  const rep = state.report;
  if (!rep) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const { run, files } = rep;
  const counts = {};
  for (const r of run.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const codecs = run.settings.codecs;
  const resolutions = [...run.settings.resolutions].sort((a, b) => a - b);
  const transports = run.settings.transports || ['webrtc'];
  const multi = transports.length > 1;
  const tLabel = (t) => (multi || t !== 'webrtc' ? `${TRANSPORTS[t]?.label || t} · ` : '');
  const allByKey = new Map(run.results.map((r) => [`${r.transport || 'webrtc'}|${r.codec}|${r.height}|${r.fps}`, r]));
  const perTransport = transports.map((transport) => {
    const tCodecs = codecs.filter((c) => run.results.some((r) => (r.transport || 'webrtc') === transport && r.codec === c));
    return { transport, tCodecs, byKey: { get: (k) => allByKey.get(`${transport}|${k}`) } };
  });
  const matrices = perTransport.flatMap(({ transport, tCodecs: codecs, byKey }) => run.settings.fpsList.map((fps) =>
    h(
      'table',
      { class: 'mtable' },
      h('caption', null, `${tLabel(transport)}${fps} fps target · decoded fps on the TV`),
      h('thead', null, h('tr', null, h('th', null, ''), codecs.map((c) => h('th', null, CODEC_LABEL[c])))),
      h(
        'tbody',
        null,
        resolutions.map((hgt) =>
          h(
            'tr',
            null,
            h('th', { class: 'rowh' }, resName(hgt)),
            codecs.map((codec) => {
              const r = byKey.get(`${codec}|${hgt}|${fps}`);
              if (!r) return h('td', null, '–');
              const val = r.rx?.fps != null && r.status !== 'UNSUPPORTED' ? fmt(r.rx.fps) : r.status === 'UNSUPPORTED' ? 'n/a' : r.status.toLowerCase();
              const dec = r.rx?.decoder ? `${r.rx.decoderHw ? 'HW' : r.rx.decoderHw === false ? 'SW' : ''} ${r.rx.decoder}` : r.status;
              return h('td', { class: `st-${r.status}`, title: `${r.status}${r.notes ? ` · ${r.notes}` : ''}` }, val, h('span', { class: 'd' }, dec));
            }),
          ),
        ),
      ),
    ),
  ));
  const LAT_CLASS = { good: 'st-PASS', mid: 'st-MARGINAL', bad: 'st-FAIL' };
  const latencyMatrices = perTransport.flatMap(({ transport, tCodecs: codecs, byKey }) => run.results.some((r) => r.latency && (r.transport || 'webrtc') === transport)
    ? run.settings.fpsList.map((fps) =>
        h(
          'table',
          { class: 'mtable' },
          h('caption', null, `${tLabel(transport)}${fps} fps · latency, PC capture → decoded on TV (median ms)`),
          h('thead', null, h('tr', null, h('th', null, ''), codecs.map((c) => h('th', null, CODEC_LABEL[c])))),
          h(
            'tbody',
            null,
            resolutions.map((hgt) =>
              h(
                'tr',
                null,
                h('th', { class: 'rowh' }, resName(hgt)),
                codecs.map((codec) => {
                  const L = byKey.get(`${codec}|${hgt}|${fps}`)?.latency;
                  if (!L) return h('td', null, '–');
                  return h('td', { class: LAT_CLASS[latencyClass(L.median)] }, fmt(L.median, 0), h('span', { class: 'd' }, `p95 ${fmt(L.p95, 0)} · min ${fmt(L.min, 0)}`));
                }),
              ),
            ),
          ),
        ),
      )
    : []);
  const best = perTransport.flatMap(({ transport, tCodecs }) =>
    tCodecs.map((codec) => {
      const mine = run.results.filter((r) => (r.transport || 'webrtc') === transport && r.codec === codec);
      const top = mine.filter((r) => r.status === 'PASS').sort((a, b) => b.width * b.height * b.fps - a.width * a.height * a.fps)[0];
      return h(
        'div',
        { class: 'b' },
        h('div', { class: 'k' }, `${tLabel(transport)}${CODEC_LABEL[codec]} · highest passing`),
        h('div', null, h('b', null, top ? `${resName(top.height)} @ ${top.fps} fps` : 'none'), top?.latency ? h('span', { class: 'faint' }, ` · ${fmt(top.latency.median, 0)} ms`) : ''),
      );
    }),
  );
  const cols = ['#', 'Status', 'Test', 'Sent', 'Decoded', 'Latency ms', 'Received', 'Decoder', 'Decode ms', 'Encoder', 'Mbps', 'Loss %', 'TV CPU', 'Notes'];
  const rows = run.results.map((r) =>
    h(
      'tr',
      null,
      h('td', null, r.index),
      h('td', null, h('span', { class: `pill st-${r.status}` }, r.status)),
      h('td', null, r.label),
      h('td', null, r.tx ? `${fmt(r.tx.fps)} fps` : '–'),
      h('td', null, r.rx ? `${fmt(r.rx.fps)} fps` : '–'),
      h(
        'td',
        null,
        r.latency
          ? `${fmt(r.latency.median, 0)} (p95 ${fmt(r.latency.p95, 0)})${r.latency.captureDelayMs != null ? ` · capture ${fmt(r.latency.captureDelayMs, 0)}` : ''}`
          : '–',
      ),
      h('td', null, r.rx?.width ? `${r.rx.width}×${r.rx.height}` : '–'),
      h('td', null, r.rx?.decoder ? `${r.rx.decoderHw ? 'HW' : r.rx.decoderHw === false ? 'SW' : ''} ${r.rx.decoder}` : '–'),
      h('td', null, fmt(r.rx?.decodeMs, 2)),
      h('td', null, r.tx?.encoder || '–'),
      h('td', null, r.rx?.kbps != null ? fmt(r.rx.kbps / 1000) : '–'),
      h('td', null, fmt(r.rx?.lossPct, 2)),
      h('td', null, r.adb?.cpuPct != null ? `${fmt(r.adb.cpuPct, 0)}%` : r.rx?.appCpuPct != null ? `${fmt(r.rx.appCpuPct, 0)}% app` : '–'),
      h('td', { class: 'notes' }, r.notes),
    ),
  );
  mount(
    'resultsCard',
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, h('span', { class: 'step done' }, '✓'), 'Results'), h('div', { class: 'card-actions' }, files && h('button', { class: 'btn btn-primary', onclick: () => bench.report.open(files.xlsx) }, 'Open spreadsheet'), files && h('button', { class: 'btn', onclick: () => bench.report.reveal(files.xlsx) }, 'Show in folder'))),
    h('div', { class: 'result-head' }, Object.entries(counts).map(([k, v]) => h('span', { class: `pill st-${k}` }, `${v} ${k.toLowerCase()}`)), files && h('span', { class: 'file-path' }, files.xlsx)),
    h('div', { class: 'matrices' }, matrices, latencyMatrices),
    h('div', { class: 'best' }, best),
    h('div', { class: 'rtable-wrap' }, h('table', { class: 'rtable' }, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, rows))),
  );
}

setInterval(() => {
  if (state.run?.running) renderRun();
}, 1000);
window.addEventListener('resize', drawChart);

init().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${e.message}`, true);
});
