# How it works

What each test does, the transports and profiles, how latency is timed, and what the report contains. Back to the [README](../README.md).

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
