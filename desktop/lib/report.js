const ExcelJS = require('exceljs');

const STATUS_FILL = {
  PASS: 'FFC6EFCE',
  MARGINAL: 'FFFFEB9C',
  FAIL: 'FFFFC7CE',
  'SENDER-LIMITED': 'FFDDEBF7',
  UNSUPPORTED: 'FFEDEDED',
  ERROR: 'FFF8CBAD',
  ABORTED: 'FFEDEDED',
};
const STATUS_FONT = {
  PASS: 'FF006100',
  MARGINAL: 'FF7F6000',
  FAIL: 'FF9C0006',
  'SENDER-LIMITED': 'FF1F4E79',
  UNSUPPORTED: 'FF595959',
  ERROR: 'FF843C0C',
  ABORTED: 'FF595959',
};
const STATUS_HELP = {
  PASS: 'Decoded at least 95% of the frames sent at full resolution, no freezes, under 2% dropped',
  MARGINAL: 'Decoded 80-95% of target, or brief freezes / drops',
  FAIL: 'Decoded under 80% of target, or no video',
  'SENDER-LIMITED': 'This PC did not send the full resolution or frame rate, so the TV was not fully tested',
  UNSUPPORTED: 'Codec could not be negotiated between this PC and the TV',
  ERROR: 'Connection or setup error (see Notes)',
};
const HEADER_FILL = 'FF1F2A37';
const GROUP_FILLS = ['FF2B3A4D', 'FF24425A', 'FF1F4E5F', 'FF3A3A55', 'FF45404F', 'FF2F2F2F'];
const THIN = { style: 'thin', color: { argb: 'FFD0D7DE' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const resLabel = (w, h) => (h ? `${h}p` : `${w}`);
const fmtRes = (w, h) => (w && h ? `${w}×${h}` : '');
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const hwLabel = (hw) => (hw == null ? '' : hw ? 'HW' : 'SW');

function styleHeaderRow(row, fill = HEADER_FILL) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  });
}

/** Latency colour bands: < 50 ms green, 50-100 ms amber, > 100 ms red. */
function paintLatency(cell, ms) {
  paintStatus(cell, ms < 50 ? 'PASS' : ms < 100 ? 'MARGINAL' : 'FAIL');
}

function paintStatus(cell, status) {
  const fill = STATUS_FILL[status];
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  const font = STATUS_FONT[status];
  if (font) cell.font = { ...(cell.font || {}), color: { argb: font }, bold: true };
}

function summarySheet(wb, run) {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  const codecs = run.settings.codecs;
  const resolutions = [...run.settings.resolutions].sort((a, b) => a - b);
  ws.columns = [{ width: 16 }, ...codecs.map(() => ({ width: 18 })), { width: 4 }, { width: 60 }];

  const tv = run.tv || {};
  ws.addRow(['WebRTC Bench report']).font = { size: 20, bold: true, color: { argb: 'FF1F2A37' } };
  ws.addRow([`${tv.name || 'TV'} · ${tv.model || ''} · Android ${tv.android || '?'} · ${tv.soc || ''}`]).font = {
    size: 12,
    color: { argb: 'FF555555' },
  };
  ws.addRow([
    `Video: ${run.video.title} (${run.video.subtitle || ''}) · Decoder: ${run.settings.decoderLabel} · Rendering: ${run.settings.renderLabel} · ` +
      `Bitrate: ${run.settings.bitrateLabel} · H.264: ${run.settings.h264Label} · Jitter buffer: ${run.settings.playoutLabel || 'Adaptive'} · ` +
      `${run.settings.warmupSec}s warm-up + ${run.settings.measureSec}s measured per test`,
  ]).font = { color: { argb: 'FF555555' } };
  ws.addRow([`Sender: ${run.desktop.host} · ${run.desktop.cpu} · ${activeGpu(run.desktop)} · ${new Date(run.startedAt).toLocaleString()}`]).font = {
    color: { argb: 'FF555555' },
  };
  const counts = {};
  for (const r of run.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const countRow = ws.addRow([
    Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join('   ·   '),
  ]);
  countRow.font = { bold: true };
  ws.addRow([]);

  const transports = run.settings.transports || ['webrtc'];
  const allByKey = new Map(run.results.map((r) => [`${r.transport || 'webrtc'}|${r.codec}|${r.height}|${r.fps}`, r]));
  if (transports.length > 1) transportComparison(ws, run, allByKey, codecs, resolutions);

  for (const transport of transports) {
  const byKey = { get: (k) => allByKey.get(`${transport}|${k}`) };
  const tName = run.settings.transportLabels?.[transport] || transport;
  if (transports.length > 1 || transport !== 'webrtc') {
    const sec = ws.addRow([`${tName}`]);
    sec.font = { size: 16, bold: true, color: { argb: 'FF1F4E79' } };
    ws.addRow([]);
  }
  for (const fps of run.settings.fpsList) {
    const t = ws.addRow([`Decoded frames per second · ${fps} fps target`]);
    t.font = { size: 13, bold: true };
    styleHeaderRow(ws.addRow(['Resolution', ...codecs.map(codecLabel)]));
    for (const h of resolutions) {
      const row = ws.addRow([resLabel(0, h)]);
      row.getCell(1).font = { bold: true };
      row.getCell(1).border = BORDER;
      codecs.forEach((codec, i) => {
        const cell = row.getCell(i + 2);
        const r = byKey.get(`${codec}|${h}|${fps}`);
        cell.border = BORDER;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (!r) {
          cell.value = '—';
          return;
        }
        if (r.rx && r.rx.fps != null && r.status !== 'UNSUPPORTED') {
          cell.value = round(r.rx.fps);
          cell.numFmt = '0.0';
        } else {
          cell.value = r.status === 'UNSUPPORTED' ? 'unsupported' : r.status.toLowerCase();
        }
        paintStatus(cell, r.status);
        cell.note = noteFor(r);
      });
    }
    ws.addRow([]);
    if (run.results.some((r) => r.latency)) {
      const lt = ws.addRow([`Latency · PC capture → decoded on TV, median ms (p95 in note) · ${fps} fps`]);
      lt.font = { size: 13, bold: true };
      styleHeaderRow(ws.addRow(['Resolution', ...codecs.map(codecLabel)]));
      for (const h of resolutions) {
        const row = ws.addRow([resLabel(0, h)]);
        row.getCell(1).font = { bold: true };
        row.getCell(1).border = BORDER;
        codecs.forEach((codec, i) => {
          const cell = row.getCell(i + 2);
          const L = byKey.get(`${codec}|${h}|${fps}`)?.latency;
          cell.border = BORDER;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (!L) {
            cell.value = '—';
            return;
          }
          cell.value = round(L.median, 0);
          cell.numFmt = '0';
          paintLatency(cell, L.median);
          cell.note = `median ${round(L.median, 0)} ms · p95 ${round(L.p95, 0)} · min ${round(L.min, 0)} · max ${round(L.max, 0)} · ${L.samples} samples`;
        });
      }
      ws.addRow([]);
    }
    if (resolutions.some((h) => codecs.some((codec) => byKey.get(`${codec}|${h}|${fps}`)?.displayLatency))) {
      const st = ws.addRow([`Latency · PC capture → shown on the TV's output, median ms (p95, repeats in note) · ${fps} fps`]);
      st.font = { size: 13, bold: true };
      styleHeaderRow(ws.addRow(['Resolution', ...codecs.map(codecLabel)]));
      for (const h of resolutions) {
        const row = ws.addRow([resLabel(0, h)]);
        row.getCell(1).font = { bold: true };
        row.getCell(1).border = BORDER;
        codecs.forEach((codec, i) => {
          const cell = row.getCell(i + 2);
          const r = byKey.get(`${codec}|${h}|${fps}`);
          const L = r?.displayLatency;
          cell.border = BORDER;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (!L) {
            cell.value = '—';
            return;
          }
          cell.value = round(L.median, 0);
          cell.numFmt = '0';
          paintLatency(cell, L.median);
          cell.note =
            `median ${round(L.median, 0)} ms · p95 ${round(L.p95, 0)} · min ${round(L.min, 0)} · max ${round(L.max, 0)}\n` +
            `shown ${round(r.rx?.displayedFps)} fps · ${r.rx?.repeats ?? 0} repeated refreshes · ${r.rx?.displayDropped ?? 0} replaced\n` +
            `pacing ${r.rx?.pacing ?? '?'}${r.rx?.pacingSlackMs != null ? ` (slack ${round(r.rx.pacingSlackMs)} ms)` : ''}`;
        });
      }
      ws.addRow([]);
    }
    const d = ws.addRow([`Decoder used · ${fps} fps`]);
    d.font = { size: 11, bold: true, color: { argb: 'FF555555' } };
    styleHeaderRow(ws.addRow(['Resolution', ...codecs.map(codecLabel)]), 'FF3B4A5C');
    for (const h of resolutions) {
      const row = ws.addRow([resLabel(0, h)]);
      row.getCell(1).border = BORDER;
      codecs.forEach((codec, i) => {
        const cell = row.getCell(i + 2);
        const r = byKey.get(`${codec}|${h}|${fps}`);
        cell.border = BORDER;
        cell.alignment = { horizontal: 'center' };
        cell.font = { size: 9, color: { argb: 'FF444444' } };
        cell.value = r?.rx?.decoder ? `${hwLabel(r.rx.decoderHw)} · ${r.rx.decoder}` : '';
      });
    }
    ws.addRow([]);
  }
  }

  const best = ws.addRow(['Highest passing setting per codec']);
  best.font = { size: 13, bold: true };
  for (const transport of transports) {
    for (const codec of codecs) {
      const mine = run.results.filter((r) => (r.transport || 'webrtc') === transport && r.codec === codec);
      if (!mine.length) continue;
      const top = mine.filter((r) => r.status === 'PASS').sort((a, b) => b.width * b.height * b.fps - a.width * a.height * a.fps)[0];
      const label = transports.length > 1 ? `${codecLabel(codec)} · ${run.settings.transportLabels?.[transport] || transport}` : codecLabel(codec);
      const row = ws.addRow([
        label,
        top
          ? `${resLabel(top.width, top.height)} @ ${top.fps} fps (${hwLabel(top.rx?.decoderHw)} ${top.rx?.decoder || ''})${top.latency ? ` · ${round(top.latency.median, 0)} ms latency` : ''}`
          : 'none passed',
      ]);
      row.getCell(1).font = { bold: true };
      ws.mergeCells(row.number, 2, row.number, Math.max(2, codecs.length + 1));
    }
  }
  ws.addRow([]);

  ws.addRow(['Legend']).font = { size: 13, bold: true };
  for (const [status, help] of Object.entries(STATUS_HELP)) {
    const row = ws.addRow([status, help]);
    paintStatus(row.getCell(1), status);
    row.getCell(1).border = BORDER;
    ws.mergeCells(row.number, 2, row.number, Math.max(2, codecs.length + 1));
  }
  ws.addRow([]);
  ws.addRow([`Video credit: ${run.video.attribution || 'n/a'} · License: ${run.video.license || 'n/a'} · ${run.video.sourcePage || ''}`]).font = {
    italic: true,
    size: 9,
    color: { argb: 'FF777777' },
  };
}

/** Side-by-side table for runs that include both transports with identical settings. */
function transportComparison(ws, run, allByKey, codecs, resolutions) {
  const t = ws.addRow(['WebRTC vs native NVENC · same codec, resolution, frame rate and bitrate']);
  t.font = { size: 14, bold: true, color: { argb: 'FF1F4E79' } };
  const header = ws.addRow([
    'Test',
    'WebRTC decoded fps',
    'Native decoded fps',
    'WebRTC latency ms',
    'Native latency ms',
    'Latency saved ms',
    'WebRTC p95 ms',
    'Native p95 ms',
  ]);
  styleHeaderRow(header);
  for (const fps of run.settings.fpsList) {
    for (const h of resolutions) {
      for (const codec of codecs) {
        const w = allByKey.get(`webrtc|${codec}|${h}|${fps}`);
        const n = allByKey.get(`native|${codec}|${h}|${fps}`);
        if (!w || !n) continue;
        const row = ws.addRow([
          `${codecLabel(codec)} ${resLabel(0, h)}${fps}`,
          round(w.rx?.fps),
          round(n.rx?.fps),
          round(w.latency?.median, 0),
          round(n.latency?.median, 0),
          w.latency && n.latency ? round(w.latency.median - n.latency.median, 0) : null,
          round(w.latency?.p95, 0),
          round(n.latency?.p95, 0),
        ]);
        row.eachCell((cell) => (cell.border = BORDER));
        row.getCell(1).font = { bold: true };
        paintStatus(row.getCell(2), w.status);
        paintStatus(row.getCell(3), n.status);
        if (w.latency) paintLatency(row.getCell(4), w.latency.median);
        if (n.latency) paintLatency(row.getCell(5), n.latency.median);
        [2, 3].forEach((i) => (row.getCell(i).numFmt = '0.0'));
      }
    }
  }
  ws.addRow([]);
}

function noteFor(r) {
  const lines = [r.status];
  if (r.rx) {
    lines.push(`Decoder: ${r.rx.decoder || '?'} (${hwLabel(r.rx.decoderHw)})`);
    lines.push(`Received ${fmtRes(r.rx.width, r.rx.height)} · ${round(r.rx.fps)} fps decoded · ${round(r.rx.decodeMs)} ms/frame`);
  }
  if (r.tx) lines.push(`Sent ${fmtRes(r.tx.width, r.tx.height)} @ ${round(r.tx.fps)} fps by ${r.tx.encoder || '?'}`);
  if (r.notes) lines.push(r.notes);
  return lines.join('\n');
}

const codecLabel = (c) => ({ H264: 'H.264', H265: 'H.265' })[c] || c;

function activeGpu(desktop) {
  const g = (desktop.gpus || []).find((x) => x.active) || (desktop.gpus || [])[0];
  return g ? g.name || `GPU ${g.vendorId}:${g.deviceId}` : 'GPU ?';
}

const RESULT_COLUMNS = [
  { group: 'Test', header: '#', key: 'index', width: 5 },
  { group: 'Test', header: 'Status', key: 'status', width: 15 },
  { group: 'Test', header: 'Transport', key: 'transport', width: 12 },
  { group: 'Test', header: 'Codec', key: 'codec', width: 8 },
  { group: 'Test', header: 'Resolution', key: 'res', width: 12 },
  { group: 'Test', header: 'Target fps', key: 'fps', width: 8 },
  { group: 'Test', header: 'Target Mbps', key: 'mbps', width: 9, fmt: '0.0' },
  { group: 'Test', header: 'Decoder mode', key: 'mode', width: 10 },
  { group: 'PC sender', header: 'Sent res', key: 'txRes', width: 12 },
  { group: 'PC sender', header: 'Sent fps', key: 'txFps', width: 8, fmt: '0.0' },
  { group: 'PC sender', header: 'Sent Mbps', key: 'txMbps', width: 9, fmt: '0.0' },
  { group: 'PC sender', header: 'Encoder', key: 'encoder', width: 22 },
  { group: 'PC sender', header: 'HW', key: 'encHw', width: 5 },
  { group: 'PC sender', header: 'Prep ms (native: scale + convert)', key: 'prepMs', width: 9, fmt: '0.00' },
  { group: 'PC sender', header: 'Encode ms', key: 'encMs', width: 8, fmt: '0.0' },
  { group: 'PC sender', header: 'Limited by', key: 'qlr', width: 10 },
  { group: 'TV receiver', header: 'Received res', key: 'rxRes', width: 12 },
  { group: 'TV receiver', header: 'Decoded fps', key: 'rxFps', width: 9, fmt: '0.0' },
  { group: 'TV receiver', header: 'Rendered fps', key: 'rendFps', width: 9, fmt: '0.0' },
  { group: 'TV receiver', header: 'Recv Mbps', key: 'rxMbps', width: 9, fmt: '0.0' },
  { group: 'TV receiver', header: 'Decoder', key: 'decoder', width: 24 },
  { group: 'TV receiver', header: 'HW', key: 'decHw', width: 5 },
  { group: 'TV receiver', header: 'Decode ms', key: 'decMs', width: 9, fmt: '0.00' },
  { group: 'TV receiver', header: 'Jitter buffer ms', key: 'jbMs', width: 9, fmt: '0' },
  { group: 'TV receiver', header: 'Frame pacing σ ms', key: 'pace', width: 9, fmt: '0.0' },
  { group: 'TV receiver', header: 'Dropped', key: 'dropped', width: 8 },
  { group: 'TV receiver', header: 'Freezes', key: 'freezes', width: 8 },
  { group: 'TV receiver', header: 'Freeze ms', key: 'freezeMs', width: 9, fmt: '0' },
  { group: 'TV display', header: 'Repeated refreshes', key: 'repeats', width: 9 },
  { group: 'TV display', header: 'Frames replaced before shown', key: 'replaced', width: 10 },
  { group: 'TV display', header: 'Frame pacing', key: 'pacing', width: 10 },
  { group: 'TV display', header: 'Pacing slack ms', key: 'slack', width: 8, fmt: '0.0' },
  { group: 'Latency', header: 'Decoded: median ms', key: 'latMed', width: 9, fmt: '0' },
  { group: 'Latency', header: 'Decoded: p95 ms', key: 'latP95', width: 9, fmt: '0' },
  { group: 'Latency', header: 'Decoded: min ms', key: 'latMin', width: 9, fmt: '0' },
  { group: 'Latency', header: 'Samples', key: 'latN', width: 8 },
  { group: 'Latency', header: 'On screen: median ms', key: 'scrMed', width: 9, fmt: '0' },
  { group: 'Latency', header: 'On screen: p95 ms', key: 'scrP95', width: 9, fmt: '0' },
  { group: 'Latency', header: 'Decoded → on screen ms', key: 'decScr', width: 9, fmt: '0.0' },
  { group: 'Latency', header: 'PC screen → TV screen: median ms (screen probe)', key: 'probeMed', width: 11, fmt: '0' },
  { group: 'Latency', header: 'PC screen → TV screen: p95 ms', key: 'probeP95', width: 9, fmt: '0' },
  { group: 'Latency', header: 'Screen capture → encoder ms (mirroring)', key: 'capDelay', width: 12, fmt: '0.0' },
  { group: 'Network', header: 'Loss %', key: 'loss', width: 7, fmt: '0.00' },
  { group: 'Network', header: 'NACKs', key: 'nack', width: 7 },
  { group: 'Network', header: 'PLIs', key: 'pli', width: 6 },
  { group: 'Network', header: 'Keyframes', key: 'kf', width: 8 },
  { group: 'Network', header: 'RTT ms', key: 'rtt', width: 7, fmt: '0.0' },
  { group: 'Network', header: 'PC adapter', key: 'pcNet', width: 20 },
  { group: 'Network', header: 'TV Wi-Fi dBm', key: 'rssi', width: 8, fmt: '0' },
  { group: 'Network', header: 'TV link Mbps', key: 'link', width: 8, fmt: '0' },
  { group: 'TV device', header: 'App CPU %', key: 'appCpu', width: 8, fmt: '0' },
  { group: 'TV device', header: 'TV CPU % (adb)', key: 'cpu', width: 9, fmt: '0' },
  { group: 'TV device', header: 'SoC °C (adb)', key: 'temp', width: 8, fmt: '0.0' },
  { group: 'TV device', header: 'Thermal', key: 'thermal', width: 8 },
  { group: 'Details', header: 'Negotiated codec', key: 'fmtp', width: 40 },
  { group: 'Details', header: 'Notes', key: 'notes', width: 60 },
];

const THERMAL = ['OK', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown'];

function negotiated(tx, rx) {
  const pc = [tx.codecMime, tx.fmtp].filter(Boolean).join(' ');
  const tv = [rx.codecMime, rx.fmtp].filter(Boolean).join(' ');
  if (!pc || !tv || pc === tv) return pc || tv;
  return `PC: ${pc} | TV: ${tv}`;
}

function resultRow(r) {
  const tx = r.tx || {};
  const rx = r.rx || {};
  const adb = r.adb || {};
  return {
    index: r.index,
    status: r.status,
    transport: r.transport === 'native' ? 'Native NVENC' : r.transport === 'screen' ? 'Screen mirroring' : r.profile === 'gaming' ? 'WebRTC (cloud gaming)' : 'WebRTC',
    codec: codecLabel(r.codec),
    res: fmtRes(r.width, r.height),
    fps: r.fps,
    mbps: round(r.bitrateKbps / 1000),
    mode: r.decoderMode,
    txRes: fmtRes(tx.width, tx.height),
    txFps: round(tx.fps),
    txMbps: round(tx.kbps != null ? tx.kbps / 1000 : null),
    encoder: tx.encoder || '',
    encHw: hwLabel(tx.encoderHw),
    prepMs: round(tx.prepMs, 2),
    encMs: round(tx.encodeMs),
    qlr: tx.qualityLimitation || '',
    rxRes: fmtRes(rx.width, rx.height),
    rxFps: round(rx.fps),
    rendFps: round(rx.renderedFps),
    rxMbps: round(rx.kbps != null ? rx.kbps / 1000 : null),
    decoder: rx.decoder || '',
    decHw: hwLabel(rx.decoderHw),
    decMs: round(rx.decodeMs, 2),
    jbMs: round(rx.jitterBufferMs, 0),
    pace: round(rx.frameIntervalStdMs),
    dropped: rx.dropped ?? null,
    freezes: rx.freezes ?? null,
    freezeMs: round(rx.freezeMs, 0),
    repeats: rx.repeats ?? null,
    replaced: rx.displayDropped ?? null,
    pacing: rx.pacing ?? '',
    slack: round(rx.pacingSlackMs),
    latMed: round(r.latency?.median, 0),
    latP95: round(r.latency?.p95, 0),
    latMin: round(r.latency?.min, 0),
    latN: r.latency?.samples ?? null,
    scrMed: round(r.displayLatency?.median, 0),
    scrP95: round(r.displayLatency?.p95, 0),
    decScr: round(rx.decodeToDisplayMs),
    probeMed: round(r.screenLatency?.median, 0),
    probeP95: round(r.screenLatency?.p95, 0),
    capDelay: round(r.latency?.captureDelayMs),
    loss: round(rx.lossPct, 2),
    nack: rx.nack ?? null,
    pli: rx.pli ?? null,
    kf: rx.keyframes ?? null,
    rtt: round(rx.rttMs ?? tx.rttMs),
    pcNet: tx.network || '',
    rssi: rx.transport === 'ethernet' ? 'wired' : round(rx.wifiRssi, 0),
    link: round(rx.wifiLinkMbps, 0),
    appCpu: round(rx.appCpuPct, 0),
    cpu: round(adb.cpuPct, 0),
    temp: round(adb.socTempC),
    thermal: rx.thermal != null ? THERMAL[rx.thermal] || String(rx.thermal) : '',
    fmtp: negotiated(tx, rx),
    notes: r.notes || '',
  };
}

function resultsSheet(wb, run) {
  const ws = wb.addWorksheet('Results', { views: [{ state: 'frozen', xSplit: 4, ySplit: 2 }] });
  ws.columns = RESULT_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  // Row 1: merged group headers. Row 2: column headers.
  const groups = [];
  RESULT_COLUMNS.forEach((c, i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.end = i + 1;
    else groups.push({ name: c.group, start: i + 1, end: i + 1 });
  });
  const g = ws.getRow(1);
  groups.forEach((grp, gi) => {
    g.getCell(grp.start).value = grp.name;
    if (grp.end > grp.start) ws.mergeCells(1, grp.start, 1, grp.end);
    for (let i = grp.start; i <= grp.end; i++) {
      const cell = g.getCell(i);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_FILLS[gi % GROUP_FILLS.length] } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center' };
    }
  });
  const h = ws.getRow(2);
  RESULT_COLUMNS.forEach((c, i) => {
    h.getCell(i + 1).value = c.header;
  });
  styleHeaderRow(h);
  h.height = 32;

  for (const r of run.results) {
    const row = ws.addRow(resultRow(r));
    RESULT_COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.border = BORDER;
      if (c.fmt) cell.numFmt = c.fmt;
    });
    paintStatus(row.getCell(2), r.status);
    const rxFpsCell = row.getCell(RESULT_COLUMNS.findIndex((c) => c.key === 'rxFps') + 1);
    paintStatus(rxFpsCell, r.status);
    if (r.latency) paintLatency(row.getCell(RESULT_COLUMNS.findIndex((c) => c.key === 'latMed') + 1), r.latency.median);
    if (r.displayLatency) paintLatency(row.getCell(RESULT_COLUMNS.findIndex((c) => c.key === 'scrMed') + 1), r.displayLatency.median);
  }
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + run.results.length, column: RESULT_COLUMNS.length } };
}

function timelineSheet(wb, run) {
  const ws = wb.addWorksheet('Timeline', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    ['Test #', 'index', 7],
    ['Test', 'label', 22],
    ['Phase', 'phase', 9],
    ['t (s)', 't', 7, '0.0'],
    ['Sent fps', 'txFps', 9, '0.0'],
    ['Sent Mbps', 'txMbps', 9, '0.00'],
    ['Encode ms', 'encodeMs', 9, '0.0'],
    ['Limited by', 'qlr', 10],
    ['Decoded fps', 'rxFps', 10, '0.0'],
    ['Recv Mbps', 'rxMbps', 9, '0.00'],
    ['Decode ms', 'decodeMs', 9, '0.00'],
    ['Jitter buffer ms', 'jbMs', 10, '0'],
    ['Latency ms', 'latencyMs', 9, '0'],
    ['On screen ms', 'screenLatencyMs', 9, '0'],
    ['Shown fps', 'shownFps', 9, '0'],
    ['Repeated refreshes', 'repeats', 9],
    ['Loss %', 'lossPct', 8, '0.00'],
    ['Dropped (cum.)', 'dropped', 9],
    ['App CPU %', 'appCpuPct', 9, '0'],
    ['TV CPU % (adb)', 'cpuPct', 10, '0'],
    ['SoC °C (adb)', 'socTempC', 9, '0.0'],
  ];
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  styleHeaderRow(ws.getRow(1));
  for (const t of run.timeline) {
    const row = ws.addRow({
      ...t,
      txMbps: t.txKbps != null ? t.txKbps / 1000 : null,
      rxMbps: t.rxKbps != null ? t.rxKbps / 1000 : null,
    });
    cols.forEach(([, , , fmt], i) => {
      if (fmt) row.getCell(i + 1).numFmt = fmt;
    });
    if (t.phase === 'warmup') row.font = { color: { argb: 'FF999999' } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + run.timeline.length, column: cols.length } };
}

function decodersSheet(wb, run) {
  const ws = wb.addWorksheet('TV decoders', { views: [{ state: 'frozen', ySplit: 1 }] });
  const sizes = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
  ws.columns = [
    { header: 'Decoder', key: 'name', width: 34 },
    { header: 'Type', key: 'type', width: 22 },
    { header: 'HW', key: 'hw', width: 6 },
    { header: 'Max instances', key: 'inst', width: 10 },
    { header: 'Max size', key: 'max', width: 12 },
    ...sizes.map((s) => ({ header: `${s} fps (declared)`, key: s, width: 16 })),
    { header: 'Performance points', key: 'pp', width: 60 },
  ];
  styleHeaderRow(ws.getRow(1));
  for (const d of run.tv?.decoders || []) {
    const row = {
      name: d.name,
      type: d.type,
      hw: d.hardware == null ? '' : d.hardware ? 'HW' : 'SW',
      inst: d.maxInstances,
      max: `${d.maxWidth}×${d.maxHeight}`,
      pp: (d.performancePoints || []).join(', '),
    };
    for (const s of sizes) {
      const x = d.sizes?.[s];
      row[s] = !x || !x.supported ? 'no' : x.achievable || (x['60'] ? '≥60' : x['30'] ? '≥30' : 'yes');
    }
    const r = ws.addRow(row);
    if (d.hardware) r.getCell(3).font = { bold: true, color: { argb: 'FF006100' } };
  }
}

function infoSheet(wb, run) {
  const ws = wb.addWorksheet('Run info');
  ws.columns = [{ width: 28 }, { width: 100 }];
  const section = (title) => {
    const r = ws.addRow([title]);
    r.font = { bold: true, size: 13 };
    ws.addRow([]);
  };
  const kv = (k, v) => {
    const r = ws.addRow([k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    r.getCell(1).font = { bold: true, color: { argb: 'FF555555' } };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  };
  section('Run');
  kv('Started', new Date(run.startedAt).toLocaleString());
  kv('Finished', new Date(run.finishedAt).toLocaleString());
  kv('Tests', run.results.length);
  kv('Codecs', run.settings.codecs.join(', '));
  kv('Resolutions', run.settings.resolutions.map((h) => `${h}p`).join(', '));
  kv('Frame rates', run.settings.fpsList.join(', '));
  kv('Transports', (run.settings.transports || ['webrtc']).map((t) => run.settings.transportLabels?.[t] || t).join(', '));
  kv('Decoder mode', run.settings.decoderLabel);
  kv('TV rendering', run.settings.renderLabel);
  kv('Jitter buffer', run.settings.playoutLabel);
  if (run.settings.pacingLabel) kv('Frame pacing (native)', run.settings.pacingLabel);
  kv(
    'Latency method',
    run.settings.measureLatency
      ? 'The PC timestamps every frame at capture (WebRTC: a 16-bit frame code burned into the image; native: an SEI message). ' +
          'Clocks are aligned with ping/pong (offset error ≤ half the sync round trip). "Decoded" ends when the TV decoder hands the frame back. ' +
          '"On screen" (native) ends when Android reports the frame shown on the TV\'s video output (MediaCodec frame-rendered time); ' +
          "it excludes only the TV panel's own processing."
      : 'off',
  );
  kv('H.264 profile', run.settings.h264Label);
  kv('Bitrate preset', run.settings.bitrateLabel);
  kv('Warm-up / measured', `${run.settings.warmupSec}s / ${run.settings.measureSec}s`);
  kv('Source pipeline', run.settings.pipeline);
  ws.addRow([]);
  section('Video');
  for (const k of ['title', 'subtitle', 'file', 'content', 'license', 'attribution', 'sourcePage', 'sourceWidth', 'sourceHeight', 'sourceFps', 'latencyFrom']) {
    if (run.video[k] != null) kv(k, run.video[k]);
  }
  ws.addRow([]);
  section('TV receiver');
  for (const [k, v] of Object.entries(run.tv || {})) if (!['decoders', 'receiverCodecs'].includes(k)) kv(k, v);
  for (const [mode, list] of Object.entries(run.tv?.receiverCodecs || {})) {
    kv(`WebRTC decoders (${mode})`, list.map((c) => `${c.name}${c.params?.['profile-level-id'] ? ` ${c.params['profile-level-id']}` : ''}`).join(', '));
  }
  ws.addRow([]);
  section('PC sender');
  for (const [k, v] of Object.entries(run.desktop || {})) kv(k, v);
  kv('WebRTC send codecs', (run.senderCodecs || []).join(', '));
}

async function writeReport(run, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WebRTC Bench';
  wb.created = new Date(run.startedAt);
  summarySheet(wb, run);
  resultsSheet(wb, run);
  timelineSheet(wb, run);
  decodersSheet(wb, run);
  infoSheet(wb, run);
  await wb.xlsx.writeFile(filePath);
}

module.exports = { writeReport };
