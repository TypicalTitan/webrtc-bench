const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Optional ADB integration: installs the TV app and samples device-wide CPU and SoC
 * temperature during tests (things an unprivileged Android app cannot read itself).
 */
class Adb {
  constructor() {
    this.bin = null;
    this.serialByIp = new Map();
  }

  _candidates() {
    const local = process.env.LOCALAPPDATA || '';
    return [
      process.env.ADB,
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'adb.exe'),
      path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      'adb',
    ].filter(Boolean);
  }

  async locate() {
    if (this.bin) return this.bin;
    for (const c of this._candidates()) {
      if (c !== 'adb' && !fs.existsSync(c)) continue;
      try {
        await this._exec(c, ['version'], 4000);
        this.bin = c;
        return c;
      } catch {
        // try next
      }
    }
    return null;
  }

  _exec(bin, args, timeout = 8000) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
    });
  }

  async run(args, timeout) {
    const bin = await this.locate();
    if (!bin) throw new Error('adb not found');
    return this._exec(bin, args, timeout);
  }

  async devices() {
    const out = await this.run(['devices', '-l']);
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state, ...rest] = l.split(/\s+/);
        const model = (rest.find((r) => r.startsWith('model:')) || '').slice(6);
        return { serial, state, model };
      });
  }

  /** Finds the adb serial (ip:port or mDNS name) that belongs to the TV at `ip`. */
  async serialForIp(ip) {
    const cached = this.serialByIp.get(ip);
    const devs = (await this.devices()).filter((d) => d.state === 'device');
    if (cached && devs.some((d) => d.serial === cached)) return cached;
    const direct = devs.find((d) => d.serial.startsWith(`${ip}:`));
    if (direct) {
      this.serialByIp.set(ip, direct.serial);
      return direct.serial;
    }
    for (const d of devs) {
      try {
        const out = await this.run(['-s', d.serial, 'shell', 'ip -o -4 addr'], 5000);
        if (out.includes(`${ip}/`)) {
          this.serialByIp.set(ip, d.serial);
          return d.serial;
        }
      } catch {
        // unreachable device
      }
    }
    return null;
  }

  async status(ip) {
    const bin = await this.locate();
    if (!bin) return { available: false, reason: 'adb not found on this PC' };
    let devices = [];
    try {
      devices = await this.devices();
    } catch (e) {
      return { available: true, bin, error: e.message, devices: [] };
    }
    const serial = ip ? await this.serialForIp(ip) : null;
    return { available: true, bin, devices, serial };
  }

  async connect(hostPort) {
    const out = await this.run(['connect', hostPort], 15000);
    if (!/connected to/i.test(out)) throw new Error(out.trim() || 'connect failed');
    return out.trim();
  }

  async install(serial, apk) {
    const out = await this.run(['-s', serial, 'install', '-r', apk], 180000);
    if (!/Success/.test(out)) throw new Error(out.trim());
    return out.trim();
  }

  async launch(serial) {
    return this.run(['-s', serial, 'shell', 'am', 'start', '-n', 'dev.webrtcbench.tv/.MainActivity'], 10000);
  }
}

/**
 * Samples device-wide CPU (every 2 s) and the thermal HAL (every 10 s) through ONE long-lived
 * `adb shell` loop. Opening a new shell per sample costs the TV a TLS session and a process
 * spawn each time, which showed up as stream stalls.
 */
class AdbTelemetry {
  constructor(adb, serial, onSample) {
    this.adb = adb;
    this.serial = serial;
    this.onSample = onSample;
    this.prev = null;
    this.child = null;
    this.buf = '';
    this.block = [];
  }

  async start() {
    const bin = await this.adb.locate();
    if (!bin) return;
    const script =
      'i=0; while true; do head -1 /proc/stat; ' +
      'if [ $((i % 5)) -eq 0 ]; then dumpsys thermalservice | grep "Temperature{" | head -8; fi; ' +
      'echo "--"; i=$((i+1)); sleep 2; done';
    this.child = spawn(bin, ['-s', this.serial, 'shell', script], { windowsHide: true });
    this.child.stdout.on('data', (d) => this._onData(d.toString()));
    this.child.on('error', (e) => this.onSample({ ts: Date.now(), error: e.message }));
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
    this.child = null;
  }

  _onData(text) {
    this.buf += text;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line === '--') {
        this._emit(this.block);
        this.block = [];
      } else if (line) {
        this.block.push(line);
      }
    }
  }

  _emit(lines) {
    const sample = { ts: Date.now() };
    const cpuLine = lines.find((l) => l.startsWith('cpu '));
    if (cpuLine) {
      const v = cpuLine.split(/\s+/).slice(1).map(Number);
      const idle = v[3] + (v[4] || 0);
      const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
      if (this.prev && total > this.prev.total) {
        sample.cpuPct = 100 * (1 - (idle - this.prev.idle) / (total - this.prev.total));
      }
      this.prev = { idle, total };
    }
    const temps = {};
    for (const l of lines) {
      const m = /mValue=([\d.]+), mType=\d+, mName=(\w+)/.exec(l);
      if (m) temps[m[2]] = Math.max(temps[m[2]] ?? -Infinity, parseFloat(m[1]));
    }
    if (temps.soc_max != null) sample.socTempC = temps.soc_max;
    this.onSample(sample);
  }
}

/** Locates the TV APK: packaged resources first, then the project tree. */
function findApk(appPath, resourcesPath) {
  const candidates = [path.join(resourcesPath || '', 'WebRTCBench-TV.apk')];
  let dir = appPath;
  for (let i = 0; i < 7; i++) {
    candidates.push(path.join(dir, 'WebRTCBench-TV.apk'));
    candidates.push(path.join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

module.exports = { Adb, AdbTelemetry, findApk };
