/**
 * Frame clock for the WebRTC source in push mode: posts "tick" at exact frame times instead of
 * following the PC monitor's refresh (requestAnimationFrame), so the TV's vsync pacer can move
 * the phase in fractions of a millisecond ("shift"). Sleeps with setTimeout and spins the last
 * couple of milliseconds, which setTimeout alone cannot hit reliably.
 */
let SPIN_MS = 2.5; // 0 for clocks that need no sub-millisecond precision (send slots)
let interval = 1000 / 60;
let next = 0;
let running = false;
let timer = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'start') {
    interval = 1000 / m.fps;
    if (typeof m.spinMs === 'number') SPIN_MS = m.spinMs;
    next = performance.now() + interval;
    running = true;
    clearTimeout(timer);
    schedule();
  } else if (m.t === 'shift') {
    next += m.ms;
  } else if (m.t === 'stop') {
    running = false;
    clearTimeout(timer);
  }
};

function schedule() {
  if (!running) return;
  const wait = next - performance.now();
  if (wait > SPIN_MS) {
    timer = setTimeout(schedule, wait - SPIN_MS);
    return;
  }
  while (performance.now() < next) {
    // spin to the exact frame time
  }
  self.postMessage({ t: 'tick', at: performance.timeOrigin + next });
  next += interval;
  if (performance.now() - next > 4 * interval) next = performance.now() + interval; // fell behind
  timer = setTimeout(schedule, 0);
}
