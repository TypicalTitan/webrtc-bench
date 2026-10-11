const { app, BrowserWindow, ipcMain, protocol, dialog, shell, powerSaveBlocker, safeStorage, screen, session, net, desktopCapturer, MessageChannelMain } = require('electron');
const tcp = require('node:net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Config } = require('./lib/config');
const { Discovery } = require('./lib/discovery');
const { Library, findLibraryDir, serveFile } = require('./lib/library');
const { Adb, AdbTelemetry, findApk } = require('./lib/adb');
const { desktopInfo } = require('./lib/sysinfo');
const { writeReport } = require('./lib/report');
const { WS_PORT, PROTOCOL_VERSION } = require('./lib/protocol');

// ---------- command line (also drives unattended runs, see README) ----------
function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] ?? true;
  }
  return o;
}
const args = parseArgs(process.argv.slice(1));

// ---------- Chromium switches: must be set before the app is ready ----------
const config = new Config(path.join(app.getPath('userData'), 'config.json'), safeStorage);
const gpuPreference = args.gpu || config.getSettings().gpuPreference || 'high-performance';
if (gpuPreference === 'high-performance') app.commandLine.appendSwitch('force_high_performance_gpu');
if (gpuPreference === 'low-power') app.commandLine.appendSwitch('force_low_power_gpu');
app.commandLine.appendSwitch(
  'enable-features',
  [
    'WebRtcAllowH265Send',
    'WebRtcAllowH265Receive',
    'PlatformHEVCEncoderSupport',
    'MediaFoundationAV1Encoding',
    // --chromium-features=A,B: extra Chromium features for experiments (launch-time only).
    ...(typeof args['chromium-features'] === 'string' ? args['chromium-features'].split(',').filter(Boolean) : []),
  ].join(','),
);
app.commandLine.appendSwitch(
  'disable-features',
  ['WebRtcHideLocalIpsWithMdns', 'CalculateNativeWinOcclusion', 'IntensiveWakeUpThrottling'].join(','),
);
// A fake capture device keeps a getUserMedia session alive, which is what makes Chromium
// expose encoderImplementation / powerEfficientEncoder in getStats(). It also replaces *screen*
// capture with Chromium's synthetic test feed, so it is left off when the source is the PC
// display (mirroring mode); getStats then may not name the encoder.
const displaySource = (args.video || config.getSettings().video) === 'display';
if (!displaySource) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// The GPU process otherwise blocks on the PC monitor's vblank, and the canvas -> encoder frame
// conversion queues behind it: on a 4K TV used as the PC monitor the source fell to 10-30 fps
// with 100-400 ms of capture -> encoded delay. The sender must not be paced by the PC's display.
if (args['gpu-vsync'] === undefined) app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// WebRTC sender field trials are process-wide and fixed at launch. The cloud-gaming latency
// profile loosens libwebrtc's video pacer, which by default spreads each frame's packets at 1.1x
// the target bitrate, i.e. over most of a frame interval (10-28 ms measured).
const GAMING_SENDER_TRIALS = 'WebRTC-Video-Pacing/factor:8.0/';
const launchProfile = args['latency-profile'] || config.getSettings().latencyProfile || 'standard';
const senderTrials = typeof args['sender-trials'] === 'string' ? args['sender-trials'] : launchProfile === 'gaming' ? GAMING_SENDER_TRIALS : '';
if (senderTrials) app.commandLine.appendSwitch('force-fieldtrials', senderTrials);

protocol.registerSchemesAsPrivileged([
  { scheme: 'bench', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!args['allow-multiple'] && !app.requestSingleInstanceLock()) {
  app.quit();
}

const appRoot = __dirname;
const srcRoot = path.join(appRoot, 'src');
let win = null;
let discovery = null;
let library = null;
let telemetry = null;
let powerBlockId = null;
let desktopCache = null;
const adb = new Adb();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Native NVENC sender: packaged resources first, then native/build in the project tree. */
function findNativeSender() {
  const candidates = [path.join(process.resourcesPath || '', 'wbsend.exe')];
  let dir = app.getAppPath();
  for (let i = 0; i < 7; i++) {
    candidates.push(path.join(dir, 'native', 'build', 'wbsend.exe'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

let nativeProc = null;
let frameSink = null; // { server, port1 } while wbsend sends frames to us (WebRTC sink)

function nativeCommand(cmd) {
  try {
    nativeProc?.stdin.write(`${cmd}\n`);
  } catch {
    // not running
  }
}

/**
 * Loopback TCP server for wbsend's encoded frames (--sink=tcp:<port>). Frames are parsed and
 * posted on a MessagePort that the page hands to its sender worker; returns the port number.
 */
function startFrameSink() {
  stopFrameSink();
  const { port1, port2 } = new MessageChannelMain();
  const server = tcp.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 24) {
        if (buf.toString('latin1', 0, 4) !== 'WBAU') {
          sock.destroy();
          return;
        }
        const len = buf.readUInt32LE(4);
        if (buf.length < 24 + len) break;
        port1.postMessage({
          n: buf.readUInt32LE(8),
          key: buf[12] === 1,
          captureQpcMs: buf.readDoubleLE(16),
          data: new Uint8Array(buf.subarray(24, 24 + len)),
        });
        buf = buf.subarray(24 + len);
      }
    });
    sock.on('error', () => {});
  });
  frameSink = { server, port1 };
  port1.start();
  win?.webContents.postMessage('native:frame-port', null, [port2]);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stopFrameSink() {
  if (!frameSink) return;
  try {
    frameSink.server.close();
    frameSink.port1.close();
  } catch {
    // already closed
  }
  frameSink = null;
}

function stopNative() {
  const p = nativeProc;
  stopFrameSink();
  if (!p) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        // already gone
      }
      resolve();
    }, 3000);
    p.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      p.stdin.write('stop\n');
    } catch {
      p.kill();
    }
  });
}

function reportsDir() {
  const dir = config.getSettings().reportsDir || path.join(path.dirname(library.dir), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0f14',
    title: 'WebRTC Bench',
    icon: path.join(appRoot, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  if (args.verbose) {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('bench://app/index.html');
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  library = new Library({
    dir: config.getSettings().libraryDir || findLibraryDir(app.getAppPath(), app.getPath('documents')),
    config,
  });

  // Everything is served from one origin (bench://app) so drawing a video into a canvas
  // never taints it; a tainted canvas cannot be captured into a WebRTC track.
  const assetsRoot = path.join(appRoot, 'assets');
  protocol.handle('bench', async (request) => {
    const u = new URL(request.url);
    if (u.host !== 'app') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    if (rel.startsWith('/__media/')) {
      const item = library.resolve(rel.slice('/__media/'.length));
      if (!item?.path || !fs.existsSync(item.path)) return new Response('not found', { status: 404 });
      return serveFile(item.path, request);
    }
    const [root, sub] = rel.startsWith('/__assets/') ? [assetsRoot, rel.slice('/__assets'.length)] : [srcRoot, rel];
    const file = path.normalize(path.join(root, sub));
    if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'display-capture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture'].includes(permission));
  // Mirroring mode (WebRTC transport): getDisplayMedia() gets the main monitor without a picker.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const primary = screen.getPrimaryDisplay();
        callback({ video: sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0] });
      })
      .catch(() => callback({}));
  });

  discovery = new Discovery({ desktopId: config.data.desktopId, desktopName: config.data.desktopName });
  discovery.on('update', (list) => send('discovery:update', list));
  discovery.on('error', (e) => console.warn('discovery error:', e.message));

  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  discovery?.stop();
  telemetry?.stop();
  nativeProc?.kill();
  app.quit();
});

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    desktopCache = desktopCache || (await desktopInfo(app, screen));
    return {
      desktopId: config.data.desktopId,
      desktopName: config.data.desktopName,
      version: app.getVersion(),
      protocol: PROTOCOL_VERSION,
      wsPort: WS_PORT,
      launch: args,
      launchProfile,
      senderTrials,
      libraryDir: library.dir,
      reportsDir: reportsDir(),
      apk: findApk(app.getAppPath(), process.resourcesPath),
      nativeSender: findNativeSender(),
      gpuPreference,
      desktop: desktopCache,
    };
  });

  ipcMain.handle('discovery:start', () => {
    discovery.start();
    return discovery.list();
  });
  ipcMain.handle('discovery:stop', () => discovery.stop());
  ipcMain.handle('discovery:probe', (_e, ip) => discovery.addManual(String(ip)));

  ipcMain.handle('pairing:get', (_e, tvId) => config.getPairing(tvId));
  ipcMain.handle('pairing:list', () => config.listPairings());
  ipcMain.handle('pairing:save', (_e, tvId, data) => config.savePairing(tvId, data));
  ipcMain.handle('pairing:remove', (_e, tvId) => config.removePairing(tvId));

  ipcMain.handle('settings:get', () => config.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => config.setSettings(patch));

  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:download', async (_e, id) => {
    try {
      await library.download(id, (p) => send('library:progress', p));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('library:cancel', (_e, id) => library.cancel(id));
  ipcMain.handle('library:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add test videos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
    });
    if (!r.canceled) library.addFiles(r.filePaths);
    return library.list();
  });
  ipcMain.handle('library:remove', (_e, id) => {
    library.removeCustom(id);
    return library.list();
  });
  ipcMain.handle('library:open', () => shell.openPath(library.dir));

  ipcMain.handle('report:export', async (_e, run) => {
    const stamp = new Date(run.startedAt).toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const tvName = String(run.tv?.name || 'TV').replace(/[^\w.-]+/g, '_');
    const base = path.join(reportsDir(), `WebRTCBench_${tvName}_${stamp}`);
    const json = `${base}.json`;
    fs.writeFileSync(json, JSON.stringify(run, null, 2));
    const xlsx = `${base}.xlsx`;
    await writeReport(run, xlsx);
    return { xlsx, json };
  });
  ipcMain.handle('report:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('report:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('report:open-dir', () => shell.openPath(reportsDir()));

  ipcMain.handle('adb:status', (_e, ip) => adb.status(ip).catch((e) => ({ available: false, error: e.message })));
  ipcMain.handle('adb:connect', async (_e, hostPort) => {
    try {
      return { ok: true, message: await adb.connect(hostPort) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('adb:install', async (_e, serial) => {
    const apk = findApk(app.getAppPath(), process.resourcesPath);
    if (!apk) return { ok: false, error: 'TV app APK not found. Build it with android/gradlew assembleRelease.' };
    try {
      await adb.install(serial, apk);
      await adb.launch(serial);
      return { ok: true, apk };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('adb:launch', async (_e, serial) => {
    try {
      await adb.launch(serial);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('adb:telemetry-start', (_e, serial) => {
    telemetry?.stop();
    telemetry = new AdbTelemetry(adb, serial, (s) => send('adb:sample', s));
    telemetry.start();
  });
  ipcMain.handle('adb:telemetry-stop', () => {
    telemetry?.stop();
    telemetry = null;
  });

  // Native NVENC sender (wbsend.exe): arguments in, JSON lines out, "stop"/"idr" on stdin.
  ipcMain.handle('native:start', async (_e, o) => {
    await stopNative();
    const exe = findNativeSender();
    if (!exe) return { ok: false, error: 'wbsend.exe not found. Build it with native\\build.cmd.' };
    // WebRTC sink (cloud-gaming profile, NVENC sender): wbsend hands encoded frames to us over
    // loopback TCP and we pass them through a MessagePort straight to the page's sender worker,
    // which puts them into the WebRTC stream (see nvenc-worker.js).
    let sinkArgs = [`--tv=${o.tv}`, `--port=${o.port}`];
    if (o.sink === 'webrtc') {
      const port = await startFrameSink();
      sinkArgs = [`--sink=tcp:${port}`];
    }
    const args = [
      ...sinkArgs,
      ...(o.source === 'display' ? ['--source=display', `--display=${o.display || 0}`] : [`--file=${o.file}`]),
      `--codec=${o.codec}`,
      `--width=${o.width}`,
      `--height=${o.height}`,
      `--fps=${o.fps}`,
      `--kbps=${o.kbps}`,
      `--start=${o.start || 0}`,
      `--duration=${o.duration || 60}`,
      `--preset=${o.preset || 1}`,
      `--profile=${o.profile || 'high'}`,
      ...(o.extra || []).filter((x) => /^--[\w-]+(=\S*)?$/.test(x)),
    ];
    const p = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    nativeProc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          send('native:event', JSON.parse(line));
        } catch {
          console.log('[wbsend]', line);
        }
      }
    });
    p.stderr.on('data', (d) => console.warn('[wbsend]', d.toString().trim()));
    p.on('error', (e) => send('native:event', { t: 'error', message: e.message }));
    p.on('exit', (code) => {
      if (nativeProc === p) nativeProc = null;
      send('native:event', { t: 'exit', code });
    });
    return { ok: true, exe };
  });
  ipcMain.handle('native:stop', () => stopNative());
  ipcMain.handle('native:idr', () => nativeCommand('idr'));
  ipcMain.handle('native:cmd', (_e, cmd) => {
    if (/^(idr|shift -?\d+(\.\d+)?)$/.test(String(cmd))) nativeCommand(cmd);
  });
  // Lets the page map wbsend's QueryPerformanceCounter timestamps onto its own clock
  // (libuv's hrtime is QPC-based on Windows, same zero as wbsend's nowMs()).
  ipcMain.handle('clock:qpc', () => Number(process.hrtime.bigint()) / 1e6);

  ipcMain.handle('power:block', () => {
    if (powerBlockId == null) powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
  });
  ipcMain.handle('power:unblock', () => {
    if (powerBlockId != null) powerSaveBlocker.stop(powerBlockId);
    powerBlockId = null;
  });

  ipcMain.handle('auto:read-pin', (_e, file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null;
    }
  });
  // Screen-latency pattern (pattern.html): full screen on the primary display, above everything,
  // so screen mirroring (Miracast, Cast, WebRTC display capture) carries it to the TV.
  let patternWin = null;
  ipcMain.handle('pattern:show', async () => {
    if (patternWin && !patternWin.isDestroyed()) return true;
    const d = screen.getPrimaryDisplay();
    patternWin = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#000000',
      webPreferences: { backgroundThrottling: false },
    });
    patternWin.setAlwaysOnTop(true, 'screen-saver');
    await patternWin.loadURL('bench://app/pattern.html');
    return true;
  });
  ipcMain.handle('pattern:hide', () => {
    if (patternWin && !patternWin.isDestroyed()) patternWin.close();
    patternWin = null;
  });
  ipcMain.handle('app:screenshot', async (_e, file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:quit', (_e, code) => {
    discovery?.stop();
    telemetry?.stop();
    app.exit(code ?? 0);
  });
  ipcMain.on('log', (_e, parts) => console.log('[bench]', ...parts));
}
