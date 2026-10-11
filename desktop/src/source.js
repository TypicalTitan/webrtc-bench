/**
 * Produces the video track that gets encoded. In "canvas" mode every frame is drawn at the
 * exact test resolution and paced to the exact test frame rate, with an overlay (label,
 * frame counter, clock and a 16-bit frame code) so every frame differs and the TV screen
 * shows what is being tested.
 */
export class FrameSource {
  constructor(item, previewHost) {
    this.item = item;
    this.previewHost = previewHost;
    this.video = null;
    this.sourceFps = null;
    this.canvas = null;
    this.ctx = null;
    this.track = null;
    this.spec = null;
    this.running = false;
    this.frames = 0;
    this.produced = 0;
    this.next = 0;
    this.lastRaf = 0;
    this.raf = 0;
    this.fallbackTimer = 0;
    this.noiseTiles = null;
    this.codeLines = null;
    this.captureTimes = new Map(); // 16-bit frame code -> wall-clock ms when it was captured
    this.handoffTimes = new Map(); // mirroring: frame code -> when it was handed to the encoder
  }

  /** Mirroring mode: ms from screen capture to encoder hand-off for this frame, if known. */
  captureDelayOf(code) {
    const c = this.captureTimes.get(code);
    const h = this.handoffTimes.get(code);
    return c != null && h != null ? h - c : null;
  }

  /** Native tests encode in wbsend.exe; stop our own preview decode so it doesn't share the GPU. */
  pauseMedia() {
    if (!this.isDisplay) this.video?.pause();
  }

  get isDisplay() {
    return this.item.kind === 'display';
  }

  resumeMedia() {
    if (this.video?.paused) this.video.play().catch(() => {});
  }

  /** When the frame carrying `code` was handed to the encoder (performance-clock epoch ms). */
  captureTimeOf(code) {
    return this.captureTimes.get(code) ?? null;
  }

  get isPattern() {
    return this.item.kind === 'pattern';
  }

  async prepare() {
    if (this.isPattern) {
      this.noiseTiles = [0, 1, 2, 3].map(() => makeNoiseTile(256));
      this.codeLines = makeCodeLines();
      return { width: null, height: null, fps: null };
    }
    if (this.isDisplay) return this._prepareDisplay();
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = `/__media/${encodeURIComponent(this.item.id)}`;
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error(`Cannot play "${this.item.title}": ${v.error?.message || 'unsupported format'}`));
    });
    await v.play();
    this.video = v;
    this.sourceFps = await measureFps(v);
    return { width: v.videoWidth, height: v.videoHeight, fps: this.sourceFps };
  }

  /**
   * Mirroring mode: live capture of the main monitor. requestVideoFrameCallback tells us when a
   * new screen image arrived and when it was captured, so latency is measured from capture and
   * repeated (unchanged) frames are left out.
   */
  async _prepareDisplay() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 120 } }, audio: false });
    this.displayStream = stream;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play();
    this.video = v;
    this.latestFrame = 0;
    this.drawnFrame = 0;
    this.latestCapture = null;
    this.captureClock = 'draw';
    const onFrame = (now, meta) => {
      this.latestFrame = meta.presentedFrames;
      if (typeof meta.captureTime === 'number') {
        this.latestCapture = meta.captureTime;
        this.captureClock = 'capture';
      } else {
        this.latestCapture = meta.receiveTime ?? now;
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    const f0 = this.latestFrame;
    await new Promise((r) => setTimeout(r, 1000));
    this.sourceFps = this.latestFrame - f0;
    return { width: v.videoWidth, height: v.videoHeight, fps: this.sourceFps, latencyFrom: this.captureClock };
  }

  /**
   * Returns the track to send; for "direct" mode also the downscale factor for the encoder.
   * `push`: hand each canvas frame straight to the track (MediaStreamTrackGenerator) the moment
   * it is drawn, instead of canvas.captureStream, which picks frames up at the next compositor
   * frame. `onCapture(n, epochMs)` is called for every frame handed to the encoder.
   */
  start({ width, height, fps, label, pipeline, push = false, onCapture = null }) {
    this.stop();
    this.spec = { width, height, fps, label };
    this.onCapture = onCapture;
    // Frame timing (sei-worker.js) needs one recognizable gap: pause before frame ~1 s and
    // ~2.5 s into warm-up (the second re-anchors if the first was missed).
    this.anchors = onCapture ? [Math.round(fps), Math.round(fps * 2.5)] : [];
    this.anchorGapMs = 100;
    this.anchorPending = false;
    this.frames = 0;
    this.produced = 0;
    this.captureTimes.clear();
    this.handoffTimes.clear();
    this.startedAt = performance.now();
    // Every test plays the same stretch of the clip, so codecs and resolutions are compared
    // on identical content (the seek settles during warm-up).
    if (this.video && !this.isDisplay) {
      this.video.currentTime = Math.min(this.item.segmentStart || 0, Math.max(0, this.video.duration - 30));
    }

    if (pipeline === 'direct' && this.video) {
      const t = (this.isDisplay ? this.displayStream : this.video.captureStream()).getVideoTracks()[0].clone();
      t.contentHint = 'motion';
      this.track = t;
      this.previewHost?.replaceChildren(this.video);
      this.video.className = 'preview-media';
      this.running = true;
      return { track: t, scaleDownBy: this.video.videoHeight / height };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.className = 'preview-media';
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingQuality = 'high';
    let track;
    if (push && typeof MediaStreamTrackGenerator === 'function') {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = gen.writable.getWriter();
      track = gen;
    } else {
      track = canvas.captureStream(0).getVideoTracks()[0];
    }
    track.contentHint = this.item.id === 'pattern-screen' ? 'detail' : 'motion';
    this.track = track;
    this.previewHost?.replaceChildren(canvas);

    this.running = true;
    this.next = 0;
    if (this.writer) {
      // Push mode: an exact frame clock (ticker-worker.js) instead of the monitor's refresh.
      this.ticker = new Worker('./ticker-worker.js');
      this.ticker.onmessage = (e) => e.data?.t === 'tick' && this._tick(performance.now(), true);
      this.ticker.postMessage({ t: 'start', fps });
      return { track, scaleDownBy: 1 };
    }
    const loop = (now) => {
      if (!this.running) return;
      this.lastRaf = performance.now();
      this._tick(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    // rAF stops when the window is minimized; keep producing frames from a timer then.
    this.fallbackTimer = setInterval(() => {
      if (performance.now() - this.lastRaf > 60) this._tick(performance.now());
    }, 4);
    this._tick(performance.now());
    return { track, scaleDownBy: 1 };
  }

  /** Moves the frame clock (the TV's vsync pacer asks for this); positive = later. */
  shiftPhase(ms) {
    if (this.ticker) this.ticker.postMessage({ t: 'shift', ms });
    else this.next += ms;
  }

  _tick(now, clocked = false) {
    if (!this.running || !this.ctx) return;
    const interval = 1000 / this.spec.fps;
    if (!clocked) {
      if (this.next === 0) this.next = now;
      if (now + 1 < this.next) return;
    }
    if (this.anchors.length && this.frames === this.anchors[0] && !this.anchorPending) {
      this.anchors.shift();
      this.anchorPending = true;
      if (clocked) this.ticker.postMessage({ t: 'shift', ms: this.anchorGapMs });
      else this.next = now + this.anchorGapMs;
      return;
    }
    this._draw(now);
    const handoff = performance.timeOrigin + performance.now();
    if (this.writer) {
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round(handoff * 1000) });
      this.writer.write(vf).catch(() => vf.close()); // the track closes frames it accepts
    } else {
      this.track.requestFrame();
    }
    const code = this.frames & 0xffff;
    const anchorGapMs = this.anchorPending ? this.anchorGapMs : 0;
    this.anchorPending = false;
    if (!this.isDisplay) {
      this.captureTimes.set(code, handoff);
      this.onCapture?.(this.frames, handoff, anchorGapMs);
    } else if (this.latestFrame !== this.drawnFrame && this.latestCapture != null) {
      // New screen content: time it from capture. Repeats get no entry (no latency sample).
      this.drawnFrame = this.latestFrame;
      this.captureTimes.set(code, performance.timeOrigin + this.latestCapture);
      this.handoffTimes.set(code, handoff);
      this.onCapture?.(this.frames, performance.timeOrigin + this.latestCapture, anchorGapMs);
    } else {
      this.captureTimes.delete(code);
      this.handoffTimes.delete(code);
    }
    if (this.handoffTimes.size > 4096) this.handoffTimes.delete(this.handoffTimes.keys().next().value);
    if (this.captureTimes.size > 4096) this.captureTimes.delete(this.captureTimes.keys().next().value);
    this.frames++;
    this.produced++;
    this.next += interval;
    if (now - this.next > 4 * interval) this.next = now + interval; // fell behind: resync
  }

  /** Frames produced per second since start (canvas mode). */
  get producedFps() {
    const s = (performance.now() - this.startedAt) / 1000;
    return s > 0 ? this.produced / s : 0;
  }

  _draw(now) {
    const { ctx } = this;
    const { width: w, height: h } = this.spec;
    if (this.video) {
      ctx.drawImage(this.video, 0, 0, w, h);
    } else if (this.item.id === 'pattern-screen') {
      drawScreen(ctx, w, h, this.frames, now, this.codeLines);
    } else if (this.item.id === 'pattern-bars') {
      drawBars(ctx, w, h, this.frames);
    } else {
      drawMotion(ctx, w, h, this.frames, now, this.noiseTiles);
    }
    this._overlay(ctx, w, h);
  }

  _overlay(ctx, w, h) {
    const s = h / 1080;
    const fh = Math.max(12, Math.round(24 * s));
    const pad = Math.round(20 * s);
    const d = new Date();
    const clock = `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const text = `WebRTC Bench · ${this.spec.label} · frame ${String(this.frames).padStart(6, '0')} · ${clock}`;
    ctx.font = `600 ${fh}px Consolas, "Cascadia Mono", monospace`;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const bh = Math.round(fh * 1.7);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(pad, h - pad - bh, tw + fh * 1.2, bh);
    ctx.fillStyle = '#4fd1c5';
    ctx.fillText(text, pad + fh * 0.6, h - pad - bh / 2);
    // Frame code for latency measurement, bottom right; android LatencyProbe.kt reads it back
    // with the same geometry. Row A = 16 bits of the frame number, row B = those bits inverted.
    const bs = Math.max(12, Math.round(16 * s));
    const x0 = w - pad - 16 * bs;
    const y0 = h - pad - 2 * bs;
    ctx.fillStyle = '#000';
    ctx.fillRect(x0 - 4, y0 - 4, 16 * bs + 8, 2 * bs + 8);
    const code = this.frames & 0xffff;
    for (let i = 0; i < 16; i++) {
      const bit = (code >> (15 - i)) & 1;
      ctx.fillStyle = bit ? '#fff' : '#000';
      ctx.fillRect(x0 + i * bs, y0, bs, bs);
      ctx.fillStyle = bit ? '#000' : '#fff';
      ctx.fillRect(x0 + i * bs, y0 + bs, bs, bs);
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.fallbackTimer);
    this.ticker?.terminate();
    this.ticker = null;
    try {
      this.writer?.releaseLock();
    } catch {
      // pending write; the track is stopped below anyway
    }
    this.writer = null;
    this.onCapture = null;
    this.track?.stop();
    this.track = null;
    this.canvas = null;
    this.ctx = null;
  }

  dispose() {
    this.stop();
    this.previewHost?.replaceChildren();
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
  }
}

function measureFps(video) {
  if (!video.requestVideoFrameCallback) return Promise.resolve(null);
  return new Promise((resolve) => {
    const times = [];
    const start = performance.now();
    const cb = (_now, meta) => {
      times.push(meta.mediaTime);
      if (performance.now() - start < 1200 && times.length < 90) video.requestVideoFrameCallback(cb);
      else {
        const span = times[times.length - 1] - times[0];
        const fps = span > 0 ? (times.length - 1) / span : null;
        resolve(fps ? Math.round(fps * 100) / 100 : null);
      }
    };
    video.requestVideoFrameCallback(cb);
    setTimeout(() => resolve(null), 3000);
  });
}

function makeNoiseTile(size) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    img.data[i] = v;
    img.data[i + 1] = (v * 7 + 91) & 255;
    img.data[i + 2] = (v * 13 + 37) & 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Full-frame, non-translational noise plus moving shapes: no codec can predict it well. */
function drawMotion(ctx, w, h, frame, now, tiles) {
  const hue = (frame * 2) % 360;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue},70%,40%)`);
  g.addColorStop(1, `hsl(${(hue + 140) % 360},70%,30%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.45;
  const pat = ctx.createPattern(tiles[frame % tiles.length], 'repeat');
  ctx.translate(-((frame * 97) % 256), -((frame * 61) % 256));
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w + 256, h + 256);
  ctx.restore();
  const r = h * 0.07;
  for (let i = 0; i < 14; i++) {
    const x = w / 2 + Math.cos(now * 0.0011 * (1 + i * 0.13) + i) * w * 0.42;
    const y = h / 2 + Math.sin(now * 0.0016 * (1 + i * 0.11) + i * 2) * h * 0.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${(i * 26 + frame * 3) % 360},90%,60%)`;
    ctx.fill();
  }
}

function makeCodeLines() {
  const words = [
    ['kw', 'const'], ['id', 'frame'], ['op', '='], ['kw', 'await'], ['fn', 'decoder.decode'], ['op', '('], ['id', 'packet'], ['op', ');'],
    ['kw', 'if'], ['op', '('], ['id', 'stats.framesDropped'], ['op', '>'], ['num', '0'], ['op', ')'], ['fn', 'console.warn'], ['str', "'drop'"],
    ['kw', 'return'], ['fn', 'render'], ['op', '('], ['id', 'surface'], ['op', ','], ['num', '3840'], ['op', ','], ['num', '2160'], ['op', ');'],
    ['cm', '// adapt bitrate to the measured bandwidth'], ['kw', 'for'], ['op', '('], ['kw', 'let'], ['id', 'i'], ['op', '='], ['num', '0'], ['op', ';'],
  ];
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const n = 3 + ((i * 7) % 9);
    const indent = (i * 3) % 4;
    const toks = [];
    for (let k = 0; k < n; k++) toks.push(words[(i * 5 + k * 3) % words.length]);
    lines.push({ indent, toks });
  }
  return lines;
}

const CODE_COLORS = { kw: '#c586c0', id: '#9cdcfe', op: '#d4d4d4', fn: '#dcdcaa', num: '#b5cea8', str: '#ce9178', cm: '#6a9955' };

/** Screen-sharing style content: sharp text that scrolls, a moving window, a blinking cursor. */
function drawScreen(ctx, w, h, frame, now, lines) {
  const s = h / 1080;
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#252526';
  ctx.fillRect(0, 0, w * 0.17, h);
  ctx.fillStyle = '#333333';
  ctx.fillRect(0, 0, w, 36 * s);
  const fh = Math.round(20 * s);
  const lh = Math.round(fh * 1.45);
  ctx.font = `${fh}px Consolas, "Cascadia Mono", monospace`;
  ctx.textBaseline = 'top';
  const scroll = (frame * 3 * s) % (lh * lines.length);
  const first = Math.floor(scroll / lh);
  const yOff = -(scroll % lh);
  const visible = Math.ceil(h / lh) + 1;
  const x0 = w * 0.17 + 70 * s;
  for (let i = 0; i < visible; i++) {
    const idx = (first + i) % lines.length;
    const y = 50 * s + yOff + i * lh;
    ctx.fillStyle = '#858585';
    ctx.fillText(String(idx + 1).padStart(4, ' '), w * 0.17 + 8 * s, y);
    let x = x0 + lines[idx].indent * fh * 1.2;
    for (const [kind, text] of lines[idx].toks) {
      ctx.fillStyle = CODE_COLORS[kind];
      ctx.fillText(text, x, y);
      x += ctx.measureText(`${text} `).width;
    }
  }
  // sidebar file list
  ctx.font = `${Math.round(17 * s)}px Segoe UI, sans-serif`;
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = i === (frame >> 5) % 24 ? '#37373d' : '#252526';
    ctx.fillRect(0, 50 * s + i * 30 * s, w * 0.17, 30 * s);
    ctx.fillStyle = '#cccccc';
    ctx.fillText(`module_${String(i).padStart(2, '0')}.ts`, 20 * s, 55 * s + i * 30 * s);
  }
  // moving dialog window
  const ww = w * 0.3;
  const wh = h * 0.28;
  const wx = (w - ww) * (0.5 + 0.45 * Math.sin(now * 0.0007));
  const wy = (h - wh) * (0.5 + 0.4 * Math.cos(now * 0.0009));
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(wx + 10 * s, wy + 10 * s, ww, wh);
  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = '#0078d4';
  ctx.fillRect(wx, wy, ww, 34 * s);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Build succeeded · 0 warnings', wx + 12 * s, wy + 8 * s);
  ctx.fillStyle = '#333';
  for (let i = 0; i < 5; i++) ctx.fillText(`Step ${i + 1}: compiled ${(frame * 13 + i * 97) % 1000} files`, wx + 16 * s, wy + 50 * s + i * 28 * s);
  // cursor
  if ((frame >> 4) % 2 === 0) {
    ctx.fillStyle = '#aeafad';
    ctx.fillRect(x0 + ((frame * 4) % 600) * s, 50 * s + 12 * lh, 2 * s, fh);
  }
}

const BAR_COLORS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];

/** Low-complexity baseline: SMPTE-like bars with a sweep bar and a moving square. */
function drawBars(ctx, w, h, frame) {
  const bw = w / BAR_COLORS.length;
  BAR_COLORS.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i * bw, 0, Math.ceil(bw), h * 0.7);
  });
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, '#fff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h * 0.7, w, h * 0.15);
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, h * 0.85, w, h * 0.15);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect((frame * 8 * (w / 1920)) % w, 0, Math.max(4, w / 240), h * 0.85);
  const sq = h * 0.08;
  ctx.fillStyle = '#ff4081';
  ctx.fillRect((frame * 5 * (w / 1920)) % (w - sq), h * 0.88, sq, sq * 0.9);
}
