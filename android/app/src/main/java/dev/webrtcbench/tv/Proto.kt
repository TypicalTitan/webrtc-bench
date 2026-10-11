package dev.webrtcbench.tv

/** Wire constants shared with the desktop app (desktop/lib/protocol.js). */
object Proto {
    const val VERSION = 1
    const val DISCOVERY_PORT = 47810
    const val WS_PORT = 47811
    /** UDP port the native (non-WebRTC) receiver listens on for RTP from wbsend.exe. */
    const val NATIVE_PORT = 47812
    const val NSD_TYPE = "_wrtcbench._tcp."
    const val APP_VERSION = "1.0.0"
}

/** A running test on the TV: a WebRTC peer connection or the native RTP receiver. */
interface BenchSession {
    val spec: TestSpec
    /** Tears the session down and returns its final statistics. Safe to call once. */
    fun close(): org.json.JSONObject?
}

data class TestSpec(
    val id: String,
    val index: Int,
    val total: Int,
    val codec: String,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrateKbps: Int,
    val decoder: String,
    val video: String,
    val showOverlay: Boolean,
    /** "native" = surface at stream size, "scaled" = surface at UI size, "none" = decode only. */
    val render: String,
    /** Read the PC's burned-in frame code from decoded frames to measure latency. */
    val latency: Boolean,
    /** "standard" = adaptive jitter buffer, "low" = playout delay forced to 0 (cloud-gaming style). */
    val playout: String,
    /** Advanced: explicit libwebrtc field-trial string, overrides [playout] when non-empty. */
    val fieldTrials: String,
    /** Native path: "vsync" = lock the PC's frame clock to this display's compositor, "off" = free-run. */
    val pacing: String = "vsync",
    /** Native path: experimental "key=value,..." receiver options (see NativeReceiver). */
    val opts: String = "",
    /** WebRTC: "gaming" = zero playout delay + low-latency decoder straight to the screen. */
    val profile: String = "standard",
    /** WebRTC: H.264/H.265 frames carry the PC's timing SEI (per-frame latency without the pixel probe). */
    val sei: Boolean = false,
) {
    val label: String get() = "$codec ${width}x$height @ $fps"

    companion object {
        fun from(j: org.json.JSONObject) = TestSpec(
            id = j.getString("id"),
            index = j.optInt("index", 0),
            total = j.optInt("total", 0),
            codec = j.optString("codec"),
            width = j.optInt("width"),
            height = j.optInt("height"),
            fps = j.optInt("fps"),
            bitrateKbps = j.optInt("bitrateKbps"),
            decoder = j.optString("decoder", "auto"),
            video = j.optString("video"),
            showOverlay = j.optBoolean("showOverlay", true),
            render = j.optString("render", "native"),
            latency = j.optBoolean("latency", true),
            playout = j.optString("playout", "standard"),
            fieldTrials = j.optString("fieldTrials", ""),
            pacing = j.optString("pacing", "vsync"),
            opts = j.optString("opts", ""),
            profile = j.optString("profile", "standard"),
            sei = j.optBoolean("sei", false),
        )
    }
}
