const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

// wbsend's encoded frames arrive on a MessagePort (WebRTC sink); ports cannot cross the context
// bridge, so hand it to the page with window.postMessage (it ends up in nvenc-worker.js).
ipcRenderer.on('native:frame-port', (e) => window.postMessage('wrtcb-frame-port', '*', e.ports));
const subscribe = (ch, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('bench', {
  info: () => invoke('app:info'),
  discovery: {
    start: () => invoke('discovery:start'),
    stop: () => invoke('discovery:stop'),
    probe: (ip) => invoke('discovery:probe', ip),
    onUpdate: (cb) => subscribe('discovery:update', cb),
  },
  pairing: {
    get: (tvId) => invoke('pairing:get', tvId),
    list: () => invoke('pairing:list'),
    save: (tvId, data) => invoke('pairing:save', tvId, data),
    remove: (tvId) => invoke('pairing:remove', tvId),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  library: {
    list: () => invoke('library:list'),
    download: (id) => invoke('library:download', id),
    cancel: (id) => invoke('library:cancel', id),
    add: () => invoke('library:add'),
    remove: (id) => invoke('library:remove', id),
    openFolder: () => invoke('library:open'),
    onProgress: (cb) => subscribe('library:progress', cb),
  },
  report: {
    export: (run) => invoke('report:export', run),
    open: (p) => invoke('report:open', p),
    reveal: (p) => invoke('report:reveal', p),
    openDir: () => invoke('report:open-dir'),
  },
  adb: {
    status: (ip) => invoke('adb:status', ip),
    connect: (hostPort) => invoke('adb:connect', hostPort),
    install: (serial) => invoke('adb:install', serial),
    launch: (serial) => invoke('adb:launch', serial),
    telemetryStart: (serial) => invoke('adb:telemetry-start', serial),
    telemetryStop: () => invoke('adb:telemetry-stop'),
    onSample: (cb) => subscribe('adb:sample', cb),
  },
  native: {
    start: (opts) => invoke('native:start', opts),
    stop: () => invoke('native:stop'),
    idr: () => invoke('native:idr'),
    cmd: (cmd) => invoke('native:cmd', cmd),
    onEvent: (cb) => subscribe('native:event', cb),
  },
  /** QueryPerformanceCounter time in ms (wbsend's clock), for mapping its timestamps. */
  qpcMs: () => invoke('clock:qpc'),
  power: {
    block: () => invoke('power:block'),
    unblock: () => invoke('power:unblock'),
  },
  auto: {
    readPin: (file) => invoke('auto:read-pin', file),
  },
  openExternal: (url) => invoke('app:open-external', url),
  screenshot: (file) => invoke('app:screenshot', file),
  pattern: { show: () => invoke('pattern:show'), hide: () => invoke('pattern:hide') },
  quit: (code) => invoke('app:quit', code),
  log: (...parts) => ipcRenderer.send('log', parts),
});
