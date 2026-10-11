/** JSON-over-WebSocket control channel to the TV app (pairing, signaling, stats). */
export class TvLink {
  constructor({ ip, port }) {
    this.ip = ip;
    this.port = port;
    this.ws = null;
    this.listeners = new Map();
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.ip}:${this.port}`);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`No answer from ${this.ip}:${this.port}. Is WebRTC Bench open on the TV?`));
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${this.ip}:${this.port}. Is WebRTC Bench open on the TV?`));
      };
      // After a reconnect the old socket may still close late; only the current one counts.
      ws.onclose = () => this.ws === ws && this._emit({ t: '__close' });
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        this._emit(m);
      };
    });
  }

  _emit(m) {
    for (const key of [m.t, '*']) {
      for (const fn of [...(this.listeners.get(key) || [])]) {
        try {
          fn(m);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  send(obj) {
    if (!this.open) throw new Error('Not connected to the TV');
    this.ws.send(JSON.stringify(obj));
  }

  /** Resolves with the first message of `type` matching `pred`; rejects on timeout or disconnect. */
  waitFor(type, pred = () => true, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const offs = [];
      const timer = setTimeout(() => done(reject, new Error(`Timed out waiting for "${type}" from the TV`)), timeoutMs);
      function done(fn, v) {
        clearTimeout(timer);
        offs.forEach((off) => off());
        fn(v);
      }
      offs.push(this.on(type, (m) => pred(m) && done(resolve, m)));
      offs.push(this.on('__close', () => done(reject, new Error('The TV disconnected'))));
      offs.push(this.on('error', (m) => m.code === 'not-paired' && done(reject, new Error(m.message))));
    });
  }

  request(msg, replyType, pred, timeoutMs) {
    const p = this.waitFor(replyType, pred, timeoutMs);
    this.send(msg);
    return p;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}
