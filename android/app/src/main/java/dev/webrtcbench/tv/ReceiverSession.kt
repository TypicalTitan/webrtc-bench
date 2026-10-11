package dev.webrtcbench.tv

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.math.BigInteger
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private const val TAG = "WebRTCBench"

/**
 * Counts frames on their way to the renderer so we can report delivered fps. With
 * [forward] off, frames are dropped here (decode-only mode), which hands the decoder's
 * output buffer straight back and measures pure decode throughput.
 */
class CountingSink(private val target: VideoSink) : VideoSink {
    @Volatile var frames = 0L
        private set
    @Volatile var width = 0
        private set
    @Volatile var height = 0
        private set
    @Volatile var forward = true
    @Volatile var probe: LatencyProbe? = null

    override fun onFrame(frame: VideoFrame) {
        frames++
        width = frame.rotatedWidth
        height = frame.rotatedHeight
        probe?.onFrame(frame, frames)
        if (forward) target.onFrame(frame)
    }
}

/** One receive-only peer connection for a single test case, plus its 1 Hz stats reporting. */
class ReceiverSession(
    private val factory: PeerConnectionFactory,
    override val spec: TestSpec,
    private val sink: CountingSink,
    private val sys: SysStats,
    private val timing: FrameTimingCollector? = null,
    private val pacer: VsyncPacer? = null,
    private val send: (JSONObject) -> Unit,
    private val onOverlay: (String) -> Unit,
) : BenchSession {
    private val thread = HandlerThread("rx-${spec.index}").apply { start() }
    private val handler = Handler(thread.looper)
    @Volatile private var closed = false
    private var pc: PeerConnection? = null
    private var track: VideoTrack? = null
    private var remoteSet = false
    private val pendingIce = ArrayList<IceCandidate>()
    private var prev: Snapshot? = null
    private var connState = "new"

    private class Snapshot(
        val tsUs: Double, val decoded: Double, val dropped: Double, val decodeTime: Double,
        val bytes: Double, val jbDelay: Double, val jbCount: Double, val lost: Double,
        val received: Double, val sinkFrames: Long,
    )

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(s: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
        override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
            connState = s.name.lowercase(Locale.US)
            send(JSONObject().put("t", "rx-state").put("id", spec.id).put("state", connState))
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
        override fun onIceCandidate(c: IceCandidate) {
            send(
                JSONObject().put("t", "ice").put("id", spec.id)
                    .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)
            )
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(dc: DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onTrack(transceiver: RtpTransceiver) {
            val t = transceiver.receiver.track()
            if (t is VideoTrack) {
                track = t
                t.addSink(sink)
            }
        }
    }

    private open inner class Sdp(private val what: String) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) = fail("$what failed: $error")
        override fun onSetFailure(error: String?) = fail("$what failed: $error")
    }

    fun start() {
        val cfg = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        pc = factory.createPeerConnection(cfg, observer) ?: throw IllegalStateException("createPeerConnection returned null")
        onOverlay(header() + "\nwaiting for offer…")
        handler.postDelayed(statsTick, 1000)
    }

    fun onOffer(sdp: String) = handler.post {
        val p = pc ?: return@post
        p.setRemoteDescription(object : Sdp("setRemoteDescription") {
            override fun onSetSuccess() {
                handler.post {
                    remoteSet = true
                    pendingIce.forEach { p.addIceCandidate(it) }
                    pendingIce.clear()
                    createAnswer(p)
                }
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun createAnswer(p: PeerConnection) {
        p.createAnswer(object : Sdp("createAnswer") {
            override fun onCreateSuccess(desc: SessionDescription) {
                p.setLocalDescription(object : Sdp("setLocalDescription") {
                    override fun onSetSuccess() {
                        send(JSONObject().put("t", "answer").put("id", spec.id).put("sdp", desc.description))
                    }
                }, desc)
            }
        }, MediaConstraints())
    }

    fun addIce(sdpMid: String?, sdpMLineIndex: Int, candidate: String) = handler.post {
        val c = IceCandidate(sdpMid, sdpMLineIndex, candidate)
        if (remoteSet) pc?.addIceCandidate(c) else pendingIce.add(c)
    }

    private fun fail(message: String) {
        Log.w(TAG, message)
        send(JSONObject().put("t", "rx-error").put("id", spec.id).put("message", message))
    }

    private val statsTick = object : Runnable {
        override fun run() {
            if (closed) return
            pc?.getStats { report -> handler.post { if (!closed) onReport(report) } }
            handler.postDelayed(this, 1000)
        }
    }

    private fun onReport(report: RTCStatsReport) {
        val msg = buildSample(report)
        send(msg)
        onOverlay(overlayText(msg))
    }

    private fun buildSample(report: RTCStatsReport): JSONObject {
        val map = report.statsMap
        val inbound = map.values.firstOrNull {
            it.type == "inbound-rtp" && (it.members["kind"] == "video" || it.members["mediaType"] == "video")
        }
        val codec = (inbound?.members?.get("codecId") as? String)?.let { map[it] }
        val transport = map.values.firstOrNull { it.type == "transport" }
        val pair = (transport?.members?.get("selectedCandidatePairId") as? String)?.let { map[it] }
            ?: map.values.firstOrNull { it.type == "candidate-pair" && it.members["nominated"] == true }

        val msg = JSONObject().put("t", "rx-stats").put("id", spec.id).put("ts", System.currentTimeMillis())
        msg.put("state", connState)
        inbound?.let { msg.put("inbound", membersToJson(it)) }
        codec?.let {
            msg.put("codec", JSONObject().put("mimeType", it.members["mimeType"]).put("sdpFmtpLine", it.members["sdpFmtpLine"]))
        }
        pair?.let {
            msg.put(
                "pair", JSONObject()
                    .put("currentRoundTripTime", it.members["currentRoundTripTime"])
                    .put("availableIncomingBitrate", it.members["availableIncomingBitrate"])
            )
        }
        msg.put("sink", JSONObject().put("frames", sink.frames).put("width", sink.width).put("height", sink.height))
        msg.put("sys", sys.sample())
        sink.probe?.drain()?.takeIf { it.isNotEmpty() }?.let { list ->
            msg.put("lat", JSONArray().apply { list.forEach { put(JSONArray().put(it[0].toInt()).put(it[1])) } })
        }
        timing?.let { t -> msg.put("timing", t.drain().also { j -> pacer?.let { j.put("pacing", it.toJson()) } }) }
        return msg
    }

    private fun header() = "Test ${spec.index}/${spec.total} · ${spec.codec} ${spec.width}×${spec.height} @ ${spec.fps}" +
        " · ${"%.1f".format(Locale.US, spec.bitrateKbps / 1000.0)} Mbps · decoder ${spec.decoder} · render ${spec.render}" +
        when {
            spec.profile == "gaming" -> " · cloud-gaming profile"
            spec.playout == "low" -> " · low-latency playout"
            else -> ""
        }

    private fun median(a: JSONArray?): Double? {
        val v = (0 until (a?.length() ?: 0)).map { a!!.getDouble(it) }.sorted()
        return v.getOrNull(v.size / 2)
    }

    private fun overlayText(msg: JSONObject): String {
        val inb = msg.optJSONObject("inbound") ?: return header() + "\nstate $connState · waiting for video…"
        fun d(k: String) = inb.optDouble(k, 0.0)
        val now = Snapshot(
            d("timestamp"), d("framesDecoded"), d("framesDropped"), d("totalDecodeTime"), d("bytesReceived"),
            d("jitterBufferDelay"), d("jitterBufferEmittedCount"), d("packetsLost"), d("packetsReceived"),
            msg.optJSONObject("sink")?.optLong("frames") ?: 0L,
        )
        val p = prev
        prev = now
        val impl = inb.optString("decoderImplementation", "?")
        val hw = when {
            inb.has("powerEfficientDecoder") -> if (inb.optBoolean("powerEfficientDecoder")) "HW" else "SW"
            impl.startsWith("c2.") || impl.startsWith("OMX.") -> "HW"
            else -> "SW"
        }
        val sys = msg.optJSONObject("sys")
        val lines = mutableListOf(header(), "decoder  $impl ($hw)")
        if (p != null && now.tsUs > p.tsUs) {
            val dt = (now.tsUs - p.tsUs) / 1e6
            val dec = now.decoded - p.decoded
            val fps = dec / dt
            val sinkFps = (now.sinkFrames - p.sinkFrames) / dt
            val decMs = if (dec > 0) (now.decodeTime - p.decodeTime) / dec * 1000 else 0.0
            val jbN = now.jbCount - p.jbCount
            val jbMs = if (jbN > 0) (now.jbDelay - p.jbDelay) / jbN * 1000 else 0.0
            val mbps = (now.bytes - p.bytes) * 8 / dt / 1e6
            val lost = now.lost - p.lost
            val recv = now.received - p.received
            val loss = if (lost + recv > 0) 100.0 * lost / (lost + recv) else 0.0
            lines += String.format(
                Locale.US, "frames   %.1f fps decoded · %.1f rendered · %d dropped total",
                fps, sinkFps, now.dropped.toLong()
            )
            lines += String.format(
                Locale.US, "stream   %d×%d · %.1f Mbps · loss %.2f%%",
                inb.optInt("frameWidth"), inb.optInt("frameHeight"), mbps, loss
            )
            lines += String.format(Locale.US, "timing   decode %.1f ms · jitter buffer %.0f ms", decMs, jbMs)
        }
        msg.optJSONObject("timing")?.let { t ->
            val dec = median(t.optJSONArray("decoded"))
            val scr = median(t.optJSONArray("screen"))
            if (dec != null || scr != null) {
                lines += String.format(
                    Locale.US, "latency  %s ms capture → decoded%s%s",
                    dec?.let { "%.0f".format(Locale.US, it) } ?: "–",
                    scr?.let { String.format(Locale.US, " · %.0f ms → on screen", it) } ?: "",
                    if (t.optBoolean("direct")) " · direct to screen" else "",
                )
            }
        }
        if (sys != null) {
            lines += String.format(
                Locale.US, "device   app CPU %.0f%% · thermal %s · %d MB free",
                sys.optDouble("appCpuPct", 0.0), SysStats.thermalName(sys.optInt("thermalStatus", -1)),
                sys.optLong("availMemMb")
            )
        }
        return lines.joinToString("\n")
    }

    /** Stops stats, grabs one last report, and tears the connection down. Safe to call once. */
    override fun close(): JSONObject? {
        if (closed) return null
        closed = true
        handler.removeCallbacksAndMessages(null)
        val p = pc
        var final: JSONObject? = null
        if (p != null) {
            val ref = AtomicReference<RTCStatsReport?>()
            val latch = CountDownLatch(1)
            p.getStats { r -> ref.set(r); latch.countDown() }
            latch.await(1500, TimeUnit.MILLISECONDS)
            ref.get()?.let { final = buildSample(it).put("t", "rx-final") }
            track?.removeSink(sink)
            track = null
            p.close()
            p.dispose()
        }
        pc = null
        thread.quitSafely()
        return final
    }

    companion object {
        fun membersToJson(s: RTCStats): JSONObject {
            val o = JSONObject()
            o.put("timestamp", s.timestampUs)
            for ((k, v) in s.members) {
                val j = toJsonValue(v) ?: continue
                o.put(k, j)
            }
            return o
        }

        private fun toJsonValue(v: Any?): Any? = when (v) {
            null -> null
            is BigInteger -> v.toLong()
            is Double -> if (v.isFinite()) v else null
            is Float -> if (v.isFinite()) v.toDouble() else null
            is Number, is Boolean, is String -> v
            is Array<*> -> JSONArray().apply { v.forEach { x -> toJsonValue(x)?.let { put(it) } } }
            is Map<*, *> -> JSONObject().apply {
                v.forEach { (k, x) -> toJsonValue(x)?.let { put(k.toString(), it) } }
            }
            else -> v.toString()
        }
    }
}
