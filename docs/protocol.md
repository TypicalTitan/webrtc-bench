# Protocol

Wire formats between the desktop app, the TV app and the native sender. Back to the [README](../README.md).


* **Discovery:** the PC broadcasts `{"t":"wrtcb-discover"}` to UDP 47810, and TVs reply unicast
  with `{"t":"wrtcb-here", id, name, model, ip, wsPort, paired, busy}`. The TV also registers
  `_wrtcbench._tcp` over mDNS.
* **Control:** JSON over WebSocket to the TV on TCP 47811:
  * `hello`
  * `pair-request` → PIN on the TV → `pair-pin` → `pair-ok {token}` (token stored hashed on the
    TV, and DPAPI-encrypted on the PC)
  * `run-begin`, then per test: `test-start` / `offer` / `answer` / `ice` / `rx-stats` (1 Hz) /
    `test-stop`, then `run-end`
  * WebRTC `test-start` also carries `profile` (`standard`/`gaming`), `pacing` and `sei`;
    `rx-stats` then carries `timing` (per-frame decoded/on-screen latency, shown frames,
    repeats, pacer state), and the TV sends `pace-shift {ms}` to move the PC's frame clock
  * Native tests: `native-start` (with `pacing`, `opts`) → `native-ready`, `native-stats` (1 Hz),
    `native-stop` → `native-stopped`
  * Screen probe: `screen-probe-start` → `screen-probe-ready` / `screen-probe-error`,
    `screen-lat {samples: [[frame code, TV ms]...]}` (1 Hz), `screen-probe-dump {since}` →
    every sample since that TV time (after the TV was off the network), `screen-probe-stop`
* **Native side channel** (UDP 47812, same socket as the RTP): `WBPI`/`WBPO` clock-sync
  ping/pong, `WBKF` keyframe request, `WBPH` + float64 frame-clock shift in ms (TV → PC)
* **wbsend → desktop** (cloud-gaming WebRTC, loopback TCP): per frame `WBAU`, u32 length, u32
  frame number, u8 keyframe, 3 bytes padding, f64 capture time (QueryPerformanceCounter ms), then
  the Annex-B access unit. stdin commands: `stop`, `idr`, `shift <ms>`.
