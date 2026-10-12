# Running benchmarks

Unattended runs, the scripts that produced the published results, and the things that go wrong.
Back to the [README](../README.md).

## Unattended runs

```
desktop\node_modules\.bin\electron.cmd desktop --auto --device=192.168.50.32 --codecs=H264,VP9,AV1 --res=1080,2160 --fps=60 --quit
```

The run writes `reports\WebRTCBench_<TV name>_<date-time>.xlsx` plus a `.json` with the same
data. Command-line overrides apply to that run only; they are not saved as settings.

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
| `--quit` | Exit when done |
| `--gpu=high-performance\|low-power\|auto` | GPU for the Chromium process (needs restart; default high-performance) |
| `--gpu-vsync=1` | Let Chromium's GPU process wait for the PC monitor's vsync (off by default, see [How it works](how-it-works.md#transports)) |
| `--verbose` | Echo renderer console output |

## Reproducing the comparison

The [results](results.md) come from these scripts in `tools\`, run from any directory:

```
powershell -File tools\run-set.ps1 -Device 192.168.50.32 -TvFileTag Shed -Name Shed
powershell -File tools\run-set.ps1 -Device 192.168.50.72 -TvFileTag Alexander_s_Fire_TV -Name FireTV
powershell -File tools\mirror-set.ps1 -Device 192.168.50.32 -Serial 192.168.50.32:44625 -TvFileTag Shed -Name Shed
node tools\compare-report.js
```

* **`run-set.ps1`** runs five configurations at 60 fps, H.264 and H.265, 720p to 4K: native live,
  native pre-encoded, cloud-gaming WebRTC live and pre-encoded, standard WebRTC. Each report is
  saved as `reports\WebRTCBench_<Name>_<config>.json/.xlsx`. `-Only <config>` runs one of them.
  `-TvFileTag` is the TV's name as it appears in report file names (non-alphanumerics become
  `_`); it lets two TVs run at the same time without mixing up reports.
* **`mirror-set.ps1`** mirrors the PC display to the TV over WebRTC (standard and cloud-gaming
  profiles) and times PC screen → TV screen with the screen probe. Runs share the full-screen
  pattern window, so run one TV at a time. It needs adb to the TV (`-Serial`) to accept
  Android's screen-capture prompt (`accept-screen-capture.ps1`).
* **`compare-report.js`** reads the named reports and writes
  `reports\WebRTCBench_Comparison.xlsx/.json`: WebRTC profiles against native, and mirroring
  against Miracast.

Running both TVs in parallel is fine for the NVENC paths (the GPU has headroom). For the
standard profile, check that the PC sent 60 fps (`tx` in the log); if it didn't, the numbers
time the PC, not the TV.

## Miracast (Fire TV)

The Google TV Streamer has no Miracast receiver. On Fire TV, the Mirroring screen takes the TV off
Wi-Fi for as long as it is open (Miracast runs over Wi-Fi Direct), so the run can't talk to the TV
while it measures:

1. Open WebRTC Bench on the TV and start
   `electron.cmd desktop --auto --device=<fire tv ip> --screen-test=Miracast --video=display --quit`.
   Allow screen capture on the TV when asked (or let `accept-screen-capture.ps1` do it).
2. The PC shows the pattern. On the Fire TV, hold Home → **Mirroring**. On the PC, press
   **Win+K** and pick the Fire TV.
3. The run notices the TV left the network; the TV keeps timing the pattern on its own.
   Mirror for 30 s or more, then stop mirroring (Win+K → Disconnect, or Back on the remote).
4. When the TV is back on Wi-Fi, the run reconnects, collects the samples and writes the report.
   Save it as `reports\WebRTCBench_FireTV_Mirror_Miracast.json/.xlsx` for `compare-report.js`.

## Troubleshooting

* **Standard WebRTC sends 10–30 fps with hundreds of ms before encoding.** Chromium's GPU process
  was waiting on the PC monitor's vsync. The app now turns GPU vsync off; if you passed
  `--gpu-vsync=1`, drop it.
* **The Fire TV disappears from the network.** Its Mirroring screen is open. Press Back on the
  remote.
* **adb shows the Google TV twice** (IP:port and an mDNS name). Use `adb -s <ip>:<port>`. Its
  wireless-debugging port changes after a reboot.
* **Fire TV switched to an HDMI input during a run.** Bring WebRTC Bench back to the front and
  rerun the affected tests.
* **No on-screen latency for Fire TV.** Fire OS reports when frames reach the compositor, not
  when they are shown, so only decode latency is measured there.
