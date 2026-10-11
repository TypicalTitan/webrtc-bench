const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { DISCOVERY_PORT, PROTOCOL_VERSION } = require('./protocol');

const PROBE_INTERVAL_MS = 2000;
const EXPIRE_MS = 10000;

function broadcastAddress(ip, mask) {
  const a = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  return a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.');
}

/**
 * LAN browser. We broadcast "wrtcb-discover" and TVs answer with a unicast "wrtcb-here".
 * Because we initiate, Windows' firewall lets the replies in without an inbound rule.
 */
class Discovery extends EventEmitter {
  constructor({ desktopId, desktopName }) {
    super();
    this.desktopId = desktopId;
    this.desktopName = desktopName;
    this.devices = new Map();
    this.manual = new Set();
    this.sock = null;
    this.timer = null;
  }

  start() {
    if (this.sock) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    s.on('error', (err) => this.emit('error', err));
    s.bind(0, () => {
      s.setBroadcast(true);
      this._probe();
    });
    this.sock = s;
    this.timer = setInterval(() => {
      this._probe();
      this._expire();
    }, PROBE_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try {
      this.sock?.close();
    } catch {
      // already closed
    }
    this.sock = null;
  }

  /** Remember an address that broadcasts may not reach (other subnet, VPN). */
  addManual(ip) {
    this.manual.add(ip);
    this._probe();
  }

  list() {
    return [...this.devices.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  _targets() {
    const t = new Set(['255.255.255.255']);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && a.netmask) t.add(broadcastAddress(a.address, a.netmask));
      }
    }
    for (const ip of this.manual) t.add(ip);
    return [...t];
  }

  _probe() {
    if (!this.sock) return;
    const msg = Buffer.from(
      JSON.stringify({ t: 'wrtcb-discover', v: PROTOCOL_VERSION, desktopId: this.desktopId, desktopName: this.desktopName }),
    );
    for (const ip of this._targets()) {
      this.sock.send(msg, DISCOVERY_PORT, ip, () => {});
    }
  }

  _onMessage(buf, rinfo) {
    let j;
    try {
      j = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (j.t !== 'wrtcb-here' || !j.id) return;
    const prev = this.devices.get(j.id);
    this.devices.set(j.id, { ...j, ip: rinfo.address, lastSeen: Date.now(), firstSeen: prev?.firstSeen || Date.now() });
    this.emit('update', this.list());
  }

  _expire() {
    const now = Date.now();
    let changed = false;
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > EXPIRE_MS) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('update', this.list());
  }
}

module.exports = { Discovery };
