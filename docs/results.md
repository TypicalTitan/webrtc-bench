# Results (October 2026)

Google TV Streamer (MT8696, Android 14) and Fire TV AFTHY7ABBA (MT5896, Fire OS 8.1), both on
Wi-Fi, receiving from a PC with an RTX 5090 Laptop GPU on Ethernet. 60 fps, Big Buck Bunny 4K60
from 2:30, "Normal" bitrate. Charts of the same data: [tv-bench-results.html](tv-bench-results.html).
How to rerun: [benchmarking.md](benchmarking.md#reproducing-the-comparison). Back to the
[README](../README.md).

Latency is capture on the PC → frame decoded on the TV, median ms, with synchronized clocks
(error ≤ half the ping round trip, about 1 ms). Every cloud-gaming and native cell held 60 fps.

## Google TV Streamer

| H.264 / H.265 | 720p | 1080p | 1440p | 4K |
|---|---|---|---|---|
| Standard WebRTC | 121 / 119 | 160 / 191 | 203 / 352 (37 fps) | 215 (40 fps) / 142 (36 fps) |
| Cloud-gaming WebRTC | 12.5 / 13.5 | 16.9 / 15.7 | 20.4 / 18.2 | 31.0 / 24.8 |
| Cloud gaming, pre-encoded | 11.2 / 11.6 | 14.2 / 12.9 | 17.3 / 17.1 | 24.9 / 22.3 |
| Native NVENC | 8.4 / 8.4 | 11.0 / 9.8 | 14.6 / 13.5 | 24.7 / 19.0 |
| Native, pre-encoded | 7.0 / 6.8 | 8.7 / 8.2 | 11.8 / 11.3 | 16.2 / 15.6 |
| Cloud gaming, capture → on screen | 36.8 / 39.2 | 40.6 / 39.6 | 45.4 / 43.7 | 57.0 / 49.9 |

## Fire TV

| H.264 / H.265 | 720p | 1080p | 1440p | 4K |
|---|---|---|---|---|
| Standard WebRTC | 117 / 176 | 177 / 317 | 228 / 246 | 205 (48 fps) / 146 |
| Cloud-gaming WebRTC | 12.2 / 12.6 | 16.6 / 15.9 | 19.8 / 16.1 | 24.6 / 21.3 |
| Cloud gaming, pre-encoded | 12.0 / 10.4 | 12.5 / 13.4 | 15.7 / 15.0 | 22.3 / 19.7 |
| Native NVENC | 8.1 / 8.2 | 11.2 / 9.1 | 12.0 / 11.0 | 18.6 / 14.4 |
| Native, pre-encoded | 8.3 / 6.7 | 9.6 / 8.6 | 8.8 / 8.7 | 12.4 / 10.6 |

Fire OS reports when frames reach the compositor, not when they are shown, so there is no
on-screen row for the Fire TV.

## PC screen → TV screen (mirroring, 1080p60)

Timed on the TV's own screen with the screen probe; includes PC capture, encode, Wi-Fi, decode
and the TV compositor, not the panel. Median / p95.

| | Google TV | Fire TV |
|---|---|---|
| Standard WebRTC | 134 / 151 ms | 131 / 147 ms |
| Cloud-gaming WebRTC | 73 / 80 ms | 70 / 71 ms |
| Miracast | no receiver | not measured yet |

## What the numbers say

* **Cloud gaming cuts WebRTC latency about tenfold** (117–352 ms → 12–31 ms) and holds 60 fps to
  4K, where standard WebRTC drops as low as 36 fps on the Google TV. Standard WebRTC's delay is
  mostly the TV's adaptive jitter buffer (80–300 ms).
* **Cloud gaming stays 5–7 ms behind native at 1080p**: a few ms to hand each NVENC frame into
  Chromium's sender, the rest in the TV's WebRTC receive path.
* **Pre-encoded streams** take encoding out of the number, leaving transfer, receive and decode:
  12.5–14.2 ms at 1080p over WebRTC and 8.7–9.6 ms native.
* **On the Google TV, the display pipeline is the largest single piece**: about 24 ms from
  decoded to on screen, because Android's compositor needs frames ~17.5 ms before the refresh
  that shows them. Vsync pacing keeps that steady instead of varying by a whole refresh.
* **Fire TV decodes 4K faster** (about 4 ms per frame against 12 ms on the Google TV), so its
  native 4K latency is lower.

## Caveats

* Standard WebRTC was re-measured after fixing a PC-side stall (Chromium's GPU process waited on
  the PC monitor's vsync, which throttled the source when a 4K TV was the PC monitor). Earlier
  standard-profile numbers from the same day are invalid.
* WebRTC mirroring numbers from before the fake-capture-device fix (62–101 ms) timed Chromium's
  synthetic test feed, not the screen.
* One native pre-encoded run on the Google TV (H.265 1080p) had a Wi-Fi hiccup: 45 fps shown,
  p95 321 ms. Its median is still representative.
* Each configuration ran once (5 s warm-up, 8 s measured; mirroring 6 s / 15 s). Run-to-run
  spread is a few ms for the low-latency paths and tens of ms for standard WebRTC.
