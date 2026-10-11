// Builds reports/WebRTCBench_Comparison.xlsx (+ .json) from the named per-run reports:
//   WebRTCBench_<TV>_<config>.json  with TV in {Shed, FireTV} and config in CONFIGS below.
// Usage: node tools/compare-report.js
const fs = require('fs');
const path = require('path');
const ExcelJS = require(path.join(__dirname, '..', 'desktop', 'node_modules', 'exceljs'));

const REPORTS = path.join(__dirname, '..', 'reports');
const TVS = [
  { tag: 'Shed', label: 'Google TV Streamer' },
  { tag: 'FireTV', label: 'Fire TV (MT5896)' },
];
const CONFIGS = {
  std: 'WebRTC-standard_live',
  gaming: 'WebRTC-gaming_live',
  gamingPre: 'WebRTC-gaming_preencoded',
  native: 'Native_live',
  nativePre: 'Native_preencoded',
  mirrorStd: 'Mirror_WebRTC-standard',
  mirrorGaming: 'Mirror_WebRTC-gaming',
  miracast: 'Mirror_Miracast',
};
const RES = [720, 1080, 1440, 2160];
const RL = { 720: '720p', 1080: '1080p', 1440: '1440p', 2160: '4K' };
const CL = { H264: 'H.264', H265: 'H.265' };

function load(tv, cfg) {
  const f = path.join(REPORTS, `WebRTCBench_${tv}_${cfg}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const find = (run, codec, h, fps = 60) => run?.results.find((r) => r.codec === codec && r.height === h && r.fps === fps) || null;
const r1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

const data = { generated: new Date().toISOString(), tvs: [] };
for (const tv of TVS) {
  const runs = Object.fromEntries(Object.entries(CONFIGS).map(([k, cfg]) => [k, load(tv.tag, cfg)]));
  const rows = [];
  for (const codec of ['H264', 'H265']) {
    for (const h of RES) {
      const g = (k) => find(runs[k], codec, h);
      const row = { codec, h };
      for (const k of ['std', 'gaming', 'gamingPre', 'native', 'nativePre']) {
        const r = g(k);
        row[k] = r && {
          status: r.status,
          fps: r1(r.rx?.fps),
          shownFps: r1(r.rx?.displayedFps),
          decoded: r1(r.latency?.median),
          decodedP95: r1(r.latency?.p95),
          screen: r1(r.displayLatency?.median),
          screenP95: r1(r.displayLatency?.p95),
          sent: r1(r.tx?.captureToEncodedMs),
          decodeMs: r1(r.rx?.decodeMs),
        };
      }
      rows.push(row);
    }
  }
  const mirror = {};
  for (const k of ['mirrorStd', 'mirrorGaming', 'miracast']) {
    const r = runs[k]?.results?.[0];
    const s = r?.screenLatency;
    mirror[k] = s ? { median: r1(s.median), p95: r1(s.p95), fps: r1(s.shownFps ?? r.rx?.displayedFps), status: r.status } : null;
  }
  data.tvs.push({ ...tv, rows, mirror, have: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, !!v])) });
}
fs.writeFileSync(path.join(REPORTS, 'WebRTCBench_Comparison.json'), JSON.stringify(data, null, 1));

// ---------------------------------------------------------------- workbook
const BORDER = { top: { style: 'thin', color: { argb: 'FFD0D7DE' } }, left: { style: 'thin', color: { argb: 'FFD0D7DE' } }, bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } }, right: { style: 'thin', color: { argb: 'FFD0D7DE' } } };
const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
function latFill(ms) {
  if (ms == null) return null;
  return ms < 30 ? FILL('FFD8F0DF') : ms < 60 ? FILL('FFE9F5D9') : ms < 100 ? FILL('FFFDF0D5') : FILL('FFF9DEDC');
}
function header(ws, cells, fill = 'FF1F4E79') {
  const row = ws.addRow(cells);
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = FILL(fill);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = BORDER;
  });
  row.height = 32;
  return row;
}

const wb = new ExcelJS.Workbook();
wb.creator = 'WebRTC Bench';
const ws = wb.addWorksheet('WebRTC latency', { views: [{ showGridLines: false }] });
ws.columns = [{ width: 16 }, ...Array(14).fill({ width: 11 })];
ws.addRow(['WebRTC to the TV: standard vs cloud-gaming profile']).font = { size: 18, bold: true };
ws.addRow(['60 fps, Wi-Fi TV, PC on Ethernet. Latency in ms (median), capture on the PC -> decoded on the TV, and -> on screen where the TV reports it (Google TV). ' +
  'Pre-encoded: frames encoded beforehand and timed from the moment they are sent, so the number is transfer + receive + decode only.']).font = { color: { argb: 'FF555555' } };
ws.addRow([]);
for (const tv of data.tvs) {
  ws.addRow([tv.label]).font = { size: 14, bold: true, color: { argb: 'FF1F4E79' } };
  header(ws, ['Test', 'Standard\nfps', 'Standard\ndecoded', 'Gaming\nfps', 'Gaming\ndecoded', 'Gaming\np95', 'Gaming\non screen', 'Gaming\nshown fps', 'Gaming\nPC capture->sent',
    'Pre-encoded\ndecoded', 'Pre-encoded\non screen', 'Native (ref)\ndecoded', 'Native pre-enc.\ndecoded', 'TV decode\nms/frame']);
  for (const row of tv.rows) {
    const s = row.std || {};
    const g = row.gaming || {};
    const p = row.gamingPre || {};
    const n = row.native || {};
    const np = row.nativePre || {};
    const cells = [`${CL[row.codec]} ${RL[row.h]}`, s.fps, s.decoded, g.fps, g.decoded, g.decodedP95, g.screen, g.shownFps, g.sent, p.decoded, p.screen, n.decoded, np.decoded, g.decodeMs];
    const r = ws.addRow(cells);
    r.eachCell({ includeEmpty: true }, (c, i) => {
      c.border = BORDER;
      c.alignment = { horizontal: i === 1 ? 'left' : 'center' };
      if (i > 1 && typeof c.value === 'number') c.numFmt = '0.0';
      if ([3, 5, 7, 10, 11, 12, 13].includes(i)) {
        const f = latFill(c.value);
        if (f) c.fill = f;
      }
    });
    r.getCell(1).font = { bold: true };
  }
  ws.addRow([]);
}

const wm = wb.addWorksheet('Mirroring vs Miracast', { views: [{ showGridLines: false }] });
wm.columns = [{ width: 34 }, { width: 14 }, { width: 14 }, { width: 16 }];
wm.addRow(['Screen mirroring: PC screen -> TV screen']).font = { size: 18, bold: true };
wm.addRow(['Same method for every row: the PC shows a full-screen pattern with a frame number; the TV app captures its own screen and times when each number appears. ' +
  'Includes PC display/capture, encode, Wi-Fi, decode and the TV compositor; excludes the TV panel.']).font = { color: { argb: 'FF555555' } };
wm.addRow([]);
for (const tv of data.tvs) {
  wm.addRow([tv.label]).font = { size: 14, bold: true, color: { argb: 'FF1F4E79' } };
  header(wm, ['Technology', 'Median ms', 'p95 ms', 'New frames/s on TV']);
  const lines = [
    ['Miracast (Windows -> Fire TV)', tv.mirror.miracast, tv.tag === 'Shed' ? 'not supported by Google TV (Google Cast only)' : 'not measured'],
    ['WebRTC, standard profile', tv.mirror.mirrorStd, 'not measured'],
    ['WebRTC, cloud-gaming profile', tv.mirror.mirrorGaming, 'not measured'],
  ];
  for (const [name, m, missing] of lines) {
    const r = wm.addRow(m ? [name, m.median, m.p95, m.fps] : [name, missing]);
    r.eachCell({ includeEmpty: true }, (c, i) => {
      c.border = BORDER;
      if (i > 1 && typeof c.value === 'number') {
        c.numFmt = '0.0';
        c.alignment = { horizontal: 'center' };
      }
    });
    if (m) {
      const f = latFill(m.median);
      if (f) r.getCell(2).fill = f;
    } else {
      wm.mergeCells(r.number, 2, r.number, 4);
      r.getCell(2).font = { italic: true, color: { argb: 'FF777777' } };
    }
  }
  wm.addRow([]);
}

const wi = wb.addWorksheet('About');
wi.columns = [{ width: 28 }, { width: 100 }];
for (const [k, v] of [
  ['Standard profile', 'Chromium WebRTC as shipped: Chromium capture + Media Foundation encoder, libwebrtc pacer (1.1x), adaptive jitter buffer, WebRTC texture renderer on the TV.'],
  ['Cloud-gaming profile', 'Native capture + NVENC encode (wbsend.exe) carried over Chromium WebRTC (RTP, pacing x8, congestion control, NACK, SRTP); TV: playout delay 0, low-latency MediaCodec decoder straight to the screen, vsync-locked frame pacing.'],
  ['Pre-encoded', 'wbsend encodes the clip segment first and streams stored frames; latency is timed from the moment each frame is sent.'],
  ['On screen', 'Android frame-rendered time on the TV output. Fire OS 8 reports queue time instead, so Fire TV has no on-screen column.'],
  ['Source reports', Object.values(CONFIGS).map((c) => `WebRTCBench_<TV>_${c}`).join(', ')],
  ['Generated', data.generated],
]) {
  const r = wi.addRow([k, v]);
  r.getCell(1).font = { bold: true };
  r.getCell(2).alignment = { wrapText: true };
}
wb.xlsx.writeFile(path.join(REPORTS, 'WebRTCBench_Comparison.xlsx')).then(() => {
  console.log('wrote reports/WebRTCBench_Comparison.xlsx');
  for (const tv of data.tvs) console.log(tv.tag, JSON.stringify(tv.have));
});
