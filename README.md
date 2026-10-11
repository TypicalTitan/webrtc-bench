# WebRTC Bench

Measures how well a Google TV (or any Android TV) receives and decodes WebRTC video streamed
from this PC. The PC app finds the TV on the LAN, pairs with a PIN, streams a test video through
a matrix of **codecs × resolutions × frame rates**, and writes a formatted **.xlsx** report.

| PC app | Google TV app |
|---|---|
| ![Results](docs/screenshots/desktop-results.png) | ![Receiving](docs/screenshots/tv-receiving.png) |
| ![Running](docs/screenshots/desktop-running.png) | ![Pairing](docs/screenshots/tv-pairing.png) |
| ![Test matrix](docs/screenshots/desktop-matrix.png) | ![Native NVENC overlay](docs/screenshots/tv-native.png) |

```
desktop/   Electron app (sender, test runner, report writer)
native/    wbsend.exe: native NVENC + RTP/UDP sender (C++)
release/   Packaged desktop app (WebRTC Bench.exe)
android/   Google TV app (receiver), Kotlin + io.github.webrtc-sdk:android
videos/    Benchmark clip library (marker file .webrtcbench)
reports/   Generated spreadsheets (+ raw JSON next to each)
tools/     make-icons.ps1 (regenerates icon / TV banner)
WebRTCBench-TV.apk   Latest TV build, used by the desktop "Install / update TV app" button
```

## Quick start

1. **Install the TV app.** Either click *Install / update TV app* in the desktop app's ADB panel
   (the TV must be connected with `adb connect <ip>:<port>`), or run:

   ```
   adb install -r WebRTCBench-TV.apk
   ```

   It appears on the Google TV home screen as **WebRTC Bench**. Open it.
2. **Start the desktop app.**

   ```
   cd desktop
   npm start
   ```

   or run `release\WebRTC Bench-win32-x64\WebRTC Bench.exe` (built by `npm run package`).
3. Pick the TV under *Receivers on your network*, click **Pair**, and type the 6-digit PIN the TV
   shows. Pairing is remembered on both sides.
4. Choose a test video, select codecs / resolutions / frame rates, and click **Start benchmark**.
5. When the run finishes, click **Open spreadsheet**.

Windows may ask whether *WebRTC Bench* (electron.exe) may use the network the first time it runs.
Discovery works either way because the PC sends the probe and the TV replies.

## What a test does

For every combination, the desktop:

1. renders the source into a canvas at the exact test resolution and paces it at the exact frame
   rate (with a label, clock and 16-bit frame code burned in so every frame differs). Every test
   restarts the clip at the same point (2:30 for Big Buck Bunny) so all tests see the same content,
2. opens a fresh `RTCPeerConnection` restricted to that codec, with bitrate hints so the
   bandwidth estimator starts near the target,
3. warms up (default 5 s), then samples `getStats()` on both ends once per second for the
   measurement window (default 10 s), plus TV CPU % and SoC temperature over ADB if connected.

### Verdicts

| Status | Meaning |
|---|---|
| PASS | Decoded ≥ 95 % of what was sent at full resolution, no freezes, < 2 % dropped |
| MARGINAL | 80–95 %, or brief freezes / drops |
| FAIL | Under 80 %, or no video |
| SENDER-LIMITED | The PC could not send the full resolution / frame rate, but the TV kept up with what it got |
| UNSUPPORTED | Codec not available on one side |

### Transports

* **WebRTC**: Chromium's WebRTC stack on the PC sends to Android's WebRTC library on the TV,
  in one of two profiles (**WebRTC profile** option):
  * **Standard**: WebRTC as a browser or a stock Android app ships it. Frames go into Chromium
    (pushed into a `MediaStreamTrackGenerator`), Chromium's Media Foundation encoder (NVIDIA MFT),
    libwebrtc's pacer (1.1× the target bitrate), the TV's adaptive jitter buffer and WebRTC's
    texture renderer.
  * The app starts Chromium with GPU vsync off (`disable-gpu-vsync`). Each pushed frame is
    converted for the encoder in Chromium's GPU process, which otherwise waits on the PC
    monitor's vblank. With a 4K TV as the PC monitor, that throttled the source to 10–30 fps and
    added 100–400 ms before encoding. `--gpu-vsync=1` restores Chromium's default.
  * **Cloud gaming**: what a cloud-gaming service does with WebRTC.
    * PC: capture and encode happen in `wbsend.exe` (GPU decode or DXGI Desktop Duplication,
      NVENC P1), not in Chromium. Each finished frame goes over loopback TCP and a MessagePort
      into the WebRTC sender's encoded-frame transform (`nvenc-worker.js`), which puts it into the
      outgoing stream. Chromium's encoder only encodes tiny placeholder frames, 240 per second,
      that act as send slots. Chromium still does all of WebRTC: RTP, pacing (loosened to 8× with
      the `WebRTC-Video-Pacing` field trial, applied at app launch), congestion control, NACK,
      DTLS-SRTP, ICE.
    * TV: playout delay 0, and H.264/H.265 go to a **direct decoder**: the low-latency MediaCodec
      decoder renders straight onto a SurfaceView instead of through WebRTC's SurfaceTexture/GL
      renderer, which only takes one frame at a time and capped the Google TV at 40–50 fps.
      libwebrtc still gets a size-only frame per picture, so its stats and keyframe requests keep
      working. Vsync pacing (below) steers wbsend's clock over the control connection.
    * `--gaming-sender=chromium` keeps the cloud-gaming TV side but lets Chromium capture and
      encode, for comparison.
* **Per-frame timing (WebRTC, H.264/H.265):** the PC adds the same timing SEI as the native path
  to every encoded frame (encoded-frame transform), so the TV times every frame (capture →
  decoded, and → on screen where Android reports it) instead of reading a pixel code from every
  5th frame. Reading pixels back on the TV cost frames on the Google TV. Other codecs still use
  the burned-in frame code.
* **Native NVENC**: `native\build\wbsend.exe` (C++) decodes the clip on the GPU, scales it
  straight to NV12 with the D3D11 video processor, encodes with the **NVENC API directly**
  (preset P1, ultra-low-latency tuning, CBR with a one-frame VBV, no B-frames, keyframes only on
  request; H.265 from 1080p up is split across three NVENC engines) and sends each frame as RTP
  over UDP (port 47812) as soon as it is encoded, with no pacer and no jitter buffer. Every frame
  carries an SEI with its capture time, already converted to the TV's clock by a UDP ping/pong.
  The TV app reassembles frames and feeds the **low-latency MediaCodec decoder**
  (`c2.mtk.*.decoder.lowlatency` on the Google TV Streamer), releasing each frame for display as
  soon as it decodes. Lost packets make the TV request a keyframe (repeated after 80 ms if that
  is lost too). If frames ever pile up inside the decoder (one-in-one-out with a standing
  backlog), the TV flushes it and restarts from a keyframe. H.264 and H.265, video files or the
  display, and no encryption or congestion control: it is a LAN test path.

### Frame pacing (native)

The TV's compositor picks up new frames at a fixed point before each refresh and shows them a
fixed time later (on the Google TV Streamer: frames must be ready 17.5 ms before the vsync that
shows them). A frame that finishes decoding just after that point waits a whole extra refresh,
and two frames finishing between the same two pickups cost a dropped frame plus a repeated one.
With **Vsync-locked** pacing (default) the TV learns where the pickup is and steers wbsend's frame
clock (`WBPH` messages) so frames finish decoding 3 ms before it:

1. checks that Android reports real display times (vsync-aligned) for shown frames;
2. sweeps the PC's frame clock across one refresh to find the pickup point;
3. every second, shifts the clock so only ~2% of frames have less than 3 ms to spare.

Measured on the Google TV Streamer (60 fps, native): free-running, decoded → on screen varied
19–31 ms from test to test depending on where the phase happened to land, and some tests showed
only 51–58 fps on screen; locked, it is a steady 22–25 ms with 59.4–60.4 fps shown (lower only
while Wi-Fi drops packets).

Pacing needs a TV that reports when frames actually reach the screen. Fire OS 8 reports the time
a frame is handed to the compositor instead, so on Fire TV the report shows "pacing unavailable"
and no on-screen latency (decode latency is still measured).

### Mirroring mode

Pick **Mirror this PC's display** as the test video to stream your main monitor live, the way
screen mirroring and cloud gaming do. Run a game or a full-screen video on that monitor during
the run.

* **Native:** `wbsend.exe --source=display` captures with DXGI Desktop Duplication on the
  NVIDIA GPU. The display must be driven by that GPU, which is the dGPU mode on hybrid laptops.
  `wbsend --list-displays` shows the outputs. Latency starts at the moment Windows presented the
  frame.
* **WebRTC, standard profile:** Chromium screen capture (`getDisplayMedia`, main monitor, no
  picker). Latency starts at Chromium's capture timestamp. Cloud-gaming profile: Desktop
  Duplication in wbsend, as for the native path.
* Mirroring runs start Chromium without its fake capture device, which otherwise replaces screen
  capture with a synthetic test feed. WebRTC mirroring numbers from before this fix (October
  2026, 62–101 ms) timed that feed, not the screen.
* Frames where the screen did not change are still sent, but they are left out of latency. The
  Results sheet adds **Screen capture → encoder ms**: how long the capture pipeline held each
  frame before encoding.
* If Windows briefly blocks capture (UAC prompt, lock screen), the native sender repeats the last
  image and retries for up to 10 s.

### Screen probe: PC screen → TV screen, including Miracast

To compare technologies that can't be instrumented (Miracast, Cast) with our own, the app can
time the TV's screen itself:

* The PC shows a full-screen pattern (`pattern.html`) with the frame number as a black/white bar
  code across the middle of the screen, and records when each frame was drawn.
* The TV app captures its own screen (Android screen capture, `ScreenProbeService`) and reports
  when each frame number first appears. Android asks once per run for screen-capture permission
  on the TV.
* `--screen-probe=1` adds this to WebRTC tests whose video source is the display.
  `--screen-test=Miracast --video=display` measures only: start mirroring the PC screen to the
  TV (Fire TV: hold Home → Mirroring; PC: Win+K) and the run waits for the pattern to appear.
* Fire TV's Miracast receiver takes the TV off Wi-Fi for as long as its Mirroring screen is open
  (Miracast runs over Wi-Fi Direct). The run notices that the TV stopped answering. The TV keeps
  timing the pattern on its own, and you stop mirroring after 30 s or more. When the TV is back
  on the network, the PC reconnects and collects the samples (`screen-probe-dump`). TV times are
  converted with clock syncs taken before and after, interpolated for drift; the Google TV
  Streamer's clock drifted 27 ppm against the PC in a test.
* The number covers PC display and capture, encoding, Wi-Fi, decoding and the TV compositor. It
  excludes the TV panel's own processing.

### Pre-encoded streams

`--preencoded=1` makes wbsend encode the clip segment first (10 s, keyframe every 2 s), then
stream the stored frames, each timestamped when it is sent. The latency is then transfer,
receive and decode (and display) alone, for both the native path and the cloud-gaming WebRTC
path. A keyframe request from the TV jumps to the next stored keyframe.

Select both transports to run every configuration back to back on each. The Summary sheet then
opens with a WebRTC-vs-native comparison table.

### Options

* **TV decoder**: *Auto* (hardware with software fallback, like a normal app), *Hardware only*, *Software only*.
* **Jitter buffer**: *Adaptive* is WebRTC's default (the TV buffers more when the network
  jitters, for smoothness). *Low latency* forces the playout delay to 0 through libwebrtc field
  trials, so frames are shown as soon as they decode, like cloud-gaming receivers do.
* **Measure latency** (on by default, canvas source only): the PC timestamps every frame at
  capture and burns a 16-bit frame code into its corner (plus an inverted copy as a check). The
  TV reads the code back from about every 5th decoded frame, and ping/pong clock sync (error
  ≤ half the sync round trip, typically about 1 ms) turns that into **capture → decoded on TV**
  latency: median, p95 and min per test. TV display and panel delay are not included.
* **Frame pacing** (native only): *Vsync-locked* or *Free-running*, see above. During native tests
  the TV app also asks the TV set for its game / low-latency picture mode
  (`preferMinimalPostProcessing`, HDMI ALLM or content type "game"), which cuts the panel's own
  processing delay; that part happens after the HDMI output and is not in the measurements.
* **TV rendering**: *Full-res* draws into a surface at stream resolution (true 4K output);
  *Display-res* draws at the TV's UI resolution; *Decode only* discards frames after decoding to
  measure pure decoder throughput. Comparing the three shows whether a limit is the decoder or
  the render path.
* **H.264 profile**: Chromium hardware-encodes Baseline/High but only software-encodes
  Constrained Baseline, which is the only profile Android's WebRTC decoder factory advertises.
  *Baseline · GPU* (default) and *High · GPU* tell the TV "Constrained Baseline" and the PC the
  real profile; MediaCodec decodes either. *Constrained Baseline · CPU* is strict negotiation.
  The H.264 level is also raised to 5.2 because Android always advertises 3.1.
* **Bitrate**: Normal is 4/8/14/25 Mbps for 720p/1080p/1440p/2160p at 30 fps, ×1.5 at 60 fps.
  Low halves it, High doubles it.
* **Source**: *Canvas + overlay* (default) or *Direct* (the decoded file is sent as-is and the
  encoder downscales).

## The report

| Sheet | Contents |
|---|---|
| Summary | Decoded-fps grid per frame rate (color = verdict), latency grids (capture → decoded, and capture → on screen for native tests), decoder used, highest passing setting per codec, legend |
| Results | One row per test: sender, receiver, display (repeated refreshes, frames replaced before shown, pacing), latency, network and TV device metrics, negotiated codec, notes |
| Timeline | Per-second samples for every test (warm-up rows greyed), including on-screen latency and shown fps |
| TV decoders | Every MediaCodec video decoder with declared limits and performance points |
| Run info | Settings, video credit, TV and PC details |

## Measured results (October 2026)

RTX 5090 Laptop GPU sender on Ethernet; TVs on Wi-Fi. Capture → decoded on the TV, median ms
(Google TV Streamer / Fire TV AFTHY7ABBA). All cloud-gaming and native rows hold 60 fps.

| 60 fps, H.264 | 1080p | 4K |
|---|---|---|
| WebRTC, standard profile | 160 / 177 | 215 (40 fps) / 205 (48 fps) |
| WebRTC, cloud gaming | 16.9 / 16.6 | 31.0 / 24.6 |
| WebRTC, cloud gaming, pre-encoded stream | 14.2 / 12.5 | 24.9 / 22.3 |
| Native NVENC → MediaCodec | 11.0 / 11.2 | 24.7 / 18.6 |
| Native, pre-encoded stream | 8.7 / 9.6 | 16.2 / 12.4 |

Pre-encoded rows time transfer, receive and decode alone (the frame is timestamped when sent).
Capture → on screen on the Google TV adds about 24 ms (cloud gaming 1080p: 40.6 ms). Fire OS
doesn't report real display times.

PC screen → TV screen, 1080p60 mirroring, median / p95 (screen probe):

| | Google TV | Fire TV |
|---|---|---|
| WebRTC, standard profile | 134 / 151 ms | 131 / 147 ms |
| WebRTC, cloud gaming | 73 / 80 ms | 70 / 71 ms |

`node tools/compare-report.js` rebuilds `reports/WebRTCBench_Comparison.xlsx` from saved runs.

## Test videos

| Clip | Format | License / credit |
|---|---|---|
| Big Buck Bunny | 3840×2160 60 fps H.264 | CC BY 3.0, (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org |
| Big Buck Bunny | 1920×1080 60 fps H.264 | CC BY 3.0, as above |
| Christmas Surprise | 3840×2160 59.94 fps H.264 | CC BY-ND 4.0, CDGriffith Photography ([source](https://codecalamity.com/projects/benchmark-videos)) |
| High-motion stress, Desktop & text, Color bars | generated at any size / rate | — |

Missing clips can be downloaded from inside the app. *Add a video file* uses your own clips.

## Unattended runs

```
desktop\node_modules\.bin\electron.cmd desktop --auto --device=192.168.50.32 --codecs=H264,VP9,AV1 --res=1080,2160 --fps=60 --quit
```

| Flag | |
|---|---|
| `--device=<ip>` | TV to test (required) |
| `--pin-file=<path>` | If not yet paired, the app requests a PIN and polls this file for it |
| `--codecs`, `--res`, `--fps` | Comma lists, e.g. `H264,VP8,VP9,AV1,H265`, `720,1080,1440,2160`, `30,60` |
| `--decoder=auto\|hw\|sw`, `--render=native\|scaled\|none`, `--h264=baseline\|high\|cb` | As in the UI |
| `--bitrate=low\|normal\|high`, `--warmup=<s>`, `--measure=<s>`, `--video=<id>` | Video ids: `bbb-2160p60`, `xmas-2160p60`, `bbb-1080p60`, `display` (mirroring), `pattern-motion`, `pattern-screen`, `pattern-bars` |
| `--transport=webrtc,native` | Transports to run (comma list) |
| `--playout=standard\|low`, `--latency=0\|1` | Jitter buffer mode; latency measurement |
| `--pacing=vsync\|off` | Vsync pacing (native, and cloud-gaming WebRTC) |
| `--latency-profile=standard\|gaming` | WebRTC profile; `gaming` also loosens the PC pacer at launch |
| `--gaming-sender=nvenc\|chromium` | Cloud gaming: frames from wbsend/NVENC (default) or from Chromium's own capture and encoder |
| `--preencoded=1` | wbsend encodes the clip first and streams stored frames: latency = transfer + receive + decode |
| `--screen-probe=1`, `--screen-test=<label>` | Time the TV's screen (pattern on the PC screen); `--screen-test` measures external mirroring such as Miracast |
| `--allow-multiple` | Run a second instance, e.g. against a second TV at the same time |
| `--push-frames=0`, `--chromium-features=A,B`, `--sender-trials=<trials>`, `--slot-fps=<n>` | Experiments: canvas.captureStream source, extra Chromium features, sender field trials, placeholder slot rate |
| `--nvenc-preset=1..7`, `--sender-args="--split=disable --input=bgra"` | Native sender tuning (defaults: P1, NV12, best split) |
| `--native-opts=margin=3,prio=normal,allm=0` | Advanced TV receiver options: pacing margin (ms), default thread priority, no game-mode request |
| `--tv-trials=<string>` | Advanced: raw libwebrtc field-trial string for the TV (overrides `--playout`) |
| `--adb-telemetry=0\|1` | Record TV CPU % and SoC temperature over adb (default on when the TV is connected to adb) |
| `--shot-dir=<dir>` | Save window screenshots during the run |
| `--quit` | Exit when done. Overrides apply to that run only. |
| `--gpu=high-performance\|low-power\|auto` | GPU for the Chromium process (needs restart; default high-performance) |
| `--gpu-vsync=1` | Let Chromium's GPU process wait for the PC monitor's vsync (off by default, see Transports) |
| `--verbose` | Echo renderer console output |

## Building

**Desktop:** Node 20+.

```
cd desktop
npm install
npm start
npm run package   # -> release/WebRTC Bench-win32-x64/ (bundles WebRTCBench-TV.apk)
```

**Native sender:** Visual Studio C++ Build Tools. NVENC headers come from FFmpeg's
nv-codec-headers (MIT) in `native\third_party\nvenc`, and the NVENC runtime ships with the
NVIDIA driver.

```
native\build.cmd   # -> native\build\wbsend.exe
```

`wbsend.exe --tv=<ip> (--file=<video> | --source=display) [--codec=h264|hevc --width --height --fps --kbps --start --duration --preset=1..7 --profile=baseline|main|high --input=nv12|bgra --split=best|auto|disable|2|3|4]`
prints JSON lines (`ready`, per-second `stats` with prep/encode/send times, `error`, `done`) and
accepts `stop` / `idr` on stdin. `--tv=127.0.0.1 --nosync` measures encode cost without a TV.

Encode time per frame on the RTX 5090 Laptop GPU (preset P1, 60 fps): H.264 1.5 ms at 1080p,
2.9 ms at 1440p, 6.7 ms at 4K; H.265 (three-way split) 0.8 / 1.1 / 2.4 ms. The previous default
(P3) took 4–11 ms. NVENC's own RGB → YUV conversion turned out to be nearly free, so NV12 input
matters mostly for correct BT.709 colour signalling.

**TV app:** JDK 17 and the Android SDK (platform 35, build-tools 35). `android/local.properties`
points at the SDK.

```
cd android
gradlew assembleRelease
```

The APK lands in `app/build/outputs/apk/release/app-release.apk`. It is signed with the debug key
for sideloading. Copy it to `WebRTCBench-TV.apk` at the repo root for the desktop install button.

## Protocol

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
