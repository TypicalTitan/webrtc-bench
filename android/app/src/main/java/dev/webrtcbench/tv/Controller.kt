package dev.webrtcbench.tv

import android.util.Log
import org.java_websocket.WebSocket
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.HardwareVideoDecoderFactory
import org.webrtc.PeerConnectionFactory
import org.webrtc.PlatformSoftwareVideoDecoderFactory
import org.webrtc.SoftwareVideoDecoderFactory
import org.webrtc.SoftwareVideoEncoderFactory
import org.webrtc.VideoDecoderFactory
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val TAG = "WebRTCBench"
private const val PIN_TTL_MS = 120_000L
private const val PIN_ATTEMPTS = 3
private const val PROBE_ARCHIVE_MAX = 200_000 // ~55 min of 60 fps pattern frames
private const val LOW_LATENCY_TRIALS =
    "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/WebRTC-ZeroPlayoutDelay/min_pacing:0ms,max_decode_queue_size:8/"

/**
 * Protocol state machine. Every control message is handled on one executor thread, so pairing,
 * test sessions and factories never race each other.
 */
class Controller(
    private val ui: MainActivity,
    private val prefs: BenchPrefs,
    private val eglBase: EglBase,
    private val sink: CountingSink,
) : ControlServer.Listener {

    private class Client(val conn: WebSocket) {
        var desktopId: String? = null
        var desktopName: String = "Desktop"
        var authed = false
        var pin: String? = null
        var pinExpires = 0L
        var pinAttempts = 0
    }

    data class Seen(val name: String, val ip: String, val lastSeen: Long, val connected: Boolean)

    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "controller") }
    private val clients = ConcurrentHashMap<WebSocket, Client>()
    private val factories = HashMap<String, PeerConnectionFactory>()
    private val sys = SysStats(ui.applicationContext)
    private var session: BenchSession? = null
    private var sessionOwner: WebSocket? = null
    private var runOwner: WebSocket? = null
    private var pinOwner: WebSocket? = null
    private var cachedDecoders: org.json.JSONArray? = null
    val desktopsSeen = ConcurrentHashMap<String, Seen>()

    // ---- ControlServer.Listener (socket threads) -> executor ----

    override fun onOpen(c: WebSocket) {
        exec.execute { clients[c] = Client(c) }
    }

    override fun onClose(c: WebSocket) {
        exec.execute {
            val cl = clients.remove(c)
            cl?.desktopId?.let { id -> desktopsSeen[id]?.let { desktopsSeen[id] = it.copy(connected = false) } }
            if (sessionOwner == c) stopSession(null)
            if (runOwner == c) {
                runOwner = null
                ui.runEnd("Desktop disconnected")
            }
            if (pinOwner == c) {
                pinOwner = null
                ui.hidePin()
            }
            ui.refreshIdle()
        }
    }

    override fun onText(c: WebSocket, text: String) {
        // Clock-sync pings are answered right here on the socket thread: queueing them behind
        // other work would inflate the round trip and skew the PC's clock-offset estimate.
        if (text.contains("\"t\":\"ping\"")) {
            val tv = tvClockMs()
            try {
                sendTo(c, JSONObject().put("t", "pong").put("ts", JSONObject(text).opt("ts")).put("tv", tv))
            } catch (e: Exception) {
                Log.w(TAG, "bad ping", e)
            }
            return
        }
        exec.execute {
            try {
                handle(c, JSONObject(text))
            } catch (e: Exception) {
                Log.w(TAG, "message failed: $text", e)
                sendTo(c, JSONObject().put("t", "error").put("message", e.message ?: e.toString()))
            }
        }
    }

    // ---- Discovery hooks (discovery thread) ----

    fun onProbe(probe: JSONObject, ip: String) {
        val id = probe.optString("desktopId").ifEmpty { return }
        val connected = clients.values.any { it.desktopId == id }
        desktopsSeen[id] = Seen(probe.optString("desktopName", "Desktop"), ip, System.currentTimeMillis(), connected)
    }

    fun discoveryReply(desktopId: String?): JSONObject =
        DeviceInfo.basic(ui, prefs)
            .put("paired", prefs.isKnown(desktopId))
            .put("busy", session != null)

    // ---- Message handling (executor thread) ----

    private fun handle(c: WebSocket, m: JSONObject) {
        val cl = clients.getOrPut(c) { Client(c) }
        when (m.optString("t")) {
            "hello" -> {
                cl.desktopId = m.optString("desktopId").ifEmpty { null }
                cl.desktopName = m.optString("desktopName", "Desktop")
                cl.authed = prefs.isPaired(cl.desktopId, m.optString("token"))
                cl.desktopId?.let { id ->
                    val ip = c.remoteSocketAddress?.address?.hostAddress ?: "?"
                    desktopsSeen[id] = Seen(cl.desktopName, ip, System.currentTimeMillis(), true)
                }
                sendTo(c, helloOk(cl))
                ui.setStatus(if (cl.authed) "Connected to ${cl.desktopName}" else "${cl.desktopName} wants to connect")
                ui.refreshIdle()
            }
            "pair-request" -> startPairing(cl)
            "pair-pin" -> checkPin(cl, m.optString("pin"))
            "pair-cancel" -> if (pinOwner == c) {
                cl.pin = null
                pinOwner = null
                ui.hidePin()
            }
            "unpair" -> {
                cl.desktopId?.let { prefs.removePaired(it) }
                cl.authed = false
                sendTo(c, JSONObject().put("t", "unpaired"))
                ui.refreshIdle()
            }
            else -> if (!cl.authed) {
                sendTo(c, JSONObject().put("t", "error").put("code", "not-paired").put("message", "Pair this desktop first"))
            } else {
                handleAuthed(c, cl, m)
            }
        }
    }

    private fun handleAuthed(c: WebSocket, cl: Client, m: JSONObject) {
        val id = m.optString("id")
        when (m.optString("t")) {
            "run-begin" -> {
                runOwner = c
                ui.runBegin(cl.desktopName, m.optInt("total"), m.optString("video"))
            }
            "run-end" -> {
                stopSession(null)
                if (runOwner == c) runOwner = null
                ui.runEnd(m.optString("message", "Run finished"))
            }
            "test-start" -> startTest(c, TestSpec.from(m))
            "offer" -> (session as? ReceiverSession)?.takeIf { it.spec.id == id }?.onOffer(m.getString("sdp"))
            "ice" -> (session as? ReceiverSession)?.takeIf { it.spec.id == id }
                ?.addIce(m.optString("sdpMid").ifEmpty { null }, m.optInt("sdpMLineIndex"), m.getString("candidate"))
            "test-stop" -> {
                val fin = stopSession(id)
                sendTo(c, JSONObject().put("t", "test-stopped").put("id", id).put("final", fin ?: JSONObject.NULL))
            }
            "native-start" -> startNative(c, TestSpec.from(m))
            "native-stop" -> {
                val fin = stopSession(id)
                sendTo(c, JSONObject().put("t", "native-stopped").put("id", id).put("final", fin ?: JSONObject.NULL))
            }
            "screen-probe-start" -> startScreenProbe(c, id)
            "screen-probe-dump" -> dumpScreenProbe(c, id, m.optDouble("since", 0.0))
            "screen-probe-stop" -> {
                stopScreenProbe()
                sendTo(c, JSONObject().put("t", "screen-probe-stopped").put("id", id))
            }
            else -> sendTo(c, JSONObject().put("t", "error").put("message", "unknown message ${m.optString("t")}"))
        }
    }

    private fun helloOk(cl: Client): JSONObject {
        val o = JSONObject().put("t", "hello-ok").put("paired", cl.authed)
            .put("tv", DeviceInfo.basic(ui, prefs).put("network", sys.network(JSONObject())))
            .put("display", ui.displayInfo)
        if (cl.authed) {
            val decoders = cachedDecoders ?: DeviceInfo.decoders().also { cachedDecoders = it }
            o.put("decoders", decoders)
            o.put(
                "receiverCodecs", JSONObject()
                    .put("auto", DeviceInfo.factoryCodecs(decoderFactory("auto")))
                    .put("hw", DeviceInfo.factoryCodecs(decoderFactory("hw")))
                    .put("sw", DeviceInfo.factoryCodecs(decoderFactory("sw")))
            )
        }
        return o
    }

    // ---- Pairing ----

    private fun startPairing(cl: Client) {
        if (cl.desktopId == null) {
            sendTo(cl.conn, JSONObject().put("t", "pair-fail").put("reason", "send hello first"))
            return
        }
        pinOwner?.takeIf { it != cl.conn }?.let { other ->
            clients[other]?.pin = null
            sendTo(other, JSONObject().put("t", "pair-fail").put("reason", "superseded"))
        }
        val pin = BenchPrefs.randomPin()
        cl.pin = pin
        cl.pinExpires = System.currentTimeMillis() + PIN_TTL_MS
        cl.pinAttempts = 0
        pinOwner = cl.conn
        ui.showPin(cl.desktopName, pin)
        sendTo(cl.conn, JSONObject().put("t", "pair-pin-shown").put("expiresInSec", PIN_TTL_MS / 1000))
    }

    private fun checkPin(cl: Client, pin: String) {
        val expected = cl.pin
        if (expected == null || System.currentTimeMillis() > cl.pinExpires) {
            cl.pin = null
            if (pinOwner == cl.conn) {
                pinOwner = null
                ui.hidePin()
            }
            sendTo(cl.conn, JSONObject().put("t", "pair-fail").put("reason", "expired"))
            return
        }
        if (MessageDigest.isEqual(pin.trim().toByteArray(), expected.toByteArray())) {
            val token = prefs.addPaired(cl.desktopId!!, cl.desktopName)
            cl.authed = true
            cl.pin = null
            pinOwner = null
            ui.hidePin()
            ui.setStatus("Paired with ${cl.desktopName}")
            sendTo(cl.conn, JSONObject().put("t", "pair-ok").put("token", token))
            sendTo(cl.conn, helloOk(cl))
            ui.refreshIdle()
        } else {
            cl.pinAttempts++
            val left = PIN_ATTEMPTS - cl.pinAttempts
            if (left <= 0) {
                cl.pin = null
                pinOwner = null
                ui.hidePin()
            }
            sendTo(cl.conn, JSONObject().put("t", "pair-fail").put("reason", "wrong-pin").put("attemptsLeft", left))
        }
    }

    fun cancelPairingFromTv() = exec.execute {
        pinOwner?.let { c ->
            clients[c]?.pin = null
            sendTo(c, JSONObject().put("t", "pair-fail").put("reason", "cancelled-on-tv"))
        }
        pinOwner = null
        ui.hidePin()
    }

    fun onPairingsCleared() = exec.execute {
        clients.values.forEach { it.authed = false }
    }

    // ---- Tests ----

    /** The WebRTC test being set up; the decoder factory reads it when the decoder is created. */
    @Volatile private var decodeContext: DecodeContext? = null
    private var directSurface = false

    private fun decoderFactory(mode: String): VideoDecoderFactory = TimedDecoderFactory(
        when (mode) {
            "hw" -> HardwareVideoDecoderFactory(eglBase.eglBaseContext)
            "sw" -> SoftwareVideoDecoderFactory()
            "platform-sw" -> PlatformSoftwareVideoDecoderFactory(eglBase.eglBaseContext)
            else -> DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        },
        hardware = if (mode == "auto") HardwareVideoDecoderFactory(eglBase.eglBaseContext) else null,
    ) { decodeContext }

    private fun factoryFor(mode: String): PeerConnectionFactory = factories.getOrPut(mode) {
        PeerConnectionFactory.builder()
            .setVideoDecoderFactory(decoderFactory(mode))
            .setVideoEncoderFactory(SoftwareVideoEncoderFactory())
            .createPeerConnectionFactory()
    }

    private fun startTest(c: WebSocket, spec: TestSpec) {
        stopSession(null)
        if (notInForeground(c, spec)) return
        // Field trials are global and read when the receive stream is created, so set them
        // for every test. "low" forces playout delay to 0: frames are rendered as soon as
        // they are decoded instead of after an adaptive jitter-buffer delay.
        val gaming = spec.profile == "gaming"
        PeerConnectionFactory.initializeFieldTrials(
            spec.fieldTrials.ifEmpty { if (spec.playout == "low" || gaming) LOW_LATENCY_TRIALS else "" }
        )
        // Cloud-gaming profile: H.264/H.265 go to the low-latency decoder straight onto the
        // native video surface (DirectSurfaceDecoder) instead of through WebRTC's GL renderer.
        val timed = spec.codec == "H264" || spec.codec == "H265"
        ui.enterTest(spec)
        val surface = if (gaming && timed && spec.render != "none") ui.prepareNativeSurface(spec) else null
        directSurface = surface != null
        val vsyncMs = ui.vsyncPeriodMs()
        val timing = FrameTimingCollector(vsyncMs, spec.fps)
        // Direct decoding shows each frame as soon as it decodes, so the PC's frame clock can be
        // locked to this display exactly as for the native path (pace-shift messages).
        val pacer = surface?.let {
            val perVsync = maxOf(1, Math.round(1000.0 / spec.fps / vsyncMs).toInt())
            val rateOk = Math.abs(1000.0 / spec.fps - perVsync * vsyncMs) < 0.02 * vsyncMs
            VsyncPacer(
                active = true,
                enabled = spec.pacing == "vsync" && rateOk,
                periodMs = vsyncMs,
                marginMs = parseOpts(spec.opts)["margin"]?.toDoubleOrNull() ?: 3.0,
                window = maxOf(30, spec.fps),
            ) { ms ->
                sendTo(c, JSONObject().put("t", "pace-shift").put("id", spec.id).put("ms", ms))
                true
            }
        }
        decodeContext = DecodeContext(spec, timing, surface, pacer)
        sink.forward = surface == null && spec.render != "none"
        // With SEI timing every frame is timed by the decoder; the pixel probe is only for other
        // codecs (or explicitly asked for, to cross-check: opts "probe=1").
        val probe = spec.latency && surface == null && (!spec.sei || !timed || parseOpts(spec.opts)["probe"] == "1")
        sink.probe = if (probe) LatencyProbe() else null
        val s = ReceiverSession(
            factory = factoryFor(spec.decoder),
            spec = spec,
            sink = sink,
            sys = sys,
            timing = timing,
            pacer = pacer,
            send = { msg -> sendTo(c, msg) },
            onOverlay = { text -> ui.setOverlay(text) },
        )
        session = s
        sessionOwner = c
        s.start()
        sendTo(c, JSONObject().put("t", "test-ready").put("id", spec.id))
    }

    private fun notInForeground(c: WebSocket, spec: TestSpec): Boolean {
        if (ui.inForeground) return false
        sendTo(
            c, JSONObject().put("t", "rx-error").put("id", spec.id)
                .put("message", "WebRTC Bench is not open on the TV (another app is in front). Open it on the TV and run again.")
        )
        return true
    }

    /** Native path: wbsend.exe streams RTP straight to a low-latency MediaCodec decoder. */
    private fun startNative(c: WebSocket, spec: TestSpec) {
        stopSession(null)
        if (notInForeground(c, spec)) return
        ui.enterTest(spec)
        val surface = ui.prepareNativeSurface(spec)
        if (surface == null) {
            ui.releaseNativeSurface()
            sendTo(c, JSONObject().put("t", "rx-error").put("id", spec.id).put("message", "native video surface not available"))
            return
        }
        val s = try {
            NativeReceiver(spec, surface, sys, ui.vsyncPeriodMs(), { msg -> sendTo(c, msg) }, { text -> ui.setOverlay(text) })
        } catch (e: Exception) {
            Log.w(TAG, "native receiver failed", e)
            ui.releaseNativeSurface()
            sendTo(c, JSONObject().put("t", "rx-error").put("id", spec.id).put("message", "native receiver: ${e.message}"))
            return
        }
        session = s
        sessionOwner = c
        sendTo(c, JSONObject().put("t", "native-ready").put("id", spec.id).put("port", Proto.NATIVE_PORT).put("decoder", s.decoderName))
    }

    private fun stopSession(id: String?): JSONObject? {
        val s = session ?: return null
        if (id != null && id.isNotEmpty() && s.spec.id != id) return null
        session = null
        sessionOwner = null
        sink.probe = null
        val fin = try {
            s.close()
        } catch (e: Exception) {
            Log.w(TAG, "close failed", e)
            null
        }
        if (s is NativeReceiver || directSurface) ui.releaseNativeSurface()
        directSurface = false
        decodeContext = null
        ui.exitTest()
        return fin
    }

    fun isBusy() = session != null

    fun shutdown() {
        try {
            exec.submit {
                stopSession(null)
                factories.values.forEach { it.dispose() }
                factories.clear()
            }.get(3, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "shutdown", e)
        }
        exec.shutdownNow()
    }

    // ---- Screen latency probe: times what is on screen (Miracast, Cast, our own receiver) ----

    private var probeTimer: java.util.concurrent.ScheduledExecutorService? = null
    private val probeSamples = ArrayList<DoubleArray>()
    // Every sample since the probe started, for "screen-probe-dump": Fire TV's Miracast receiver
    // takes the TV off Wi-Fi, so the desktop collects those samples after it reconnects.
    private val probeArchive = ArrayList<DoubleArray>()
    @Volatile private var probeConn: WebSocket? = null

    private fun startScreenProbe(c: WebSocket, id: String) {
        var lastCode = -1
        probeConn = c
        synchronized(probeArchive) { probeArchive.clear() }
        // Only the first frame showing a new pattern code counts: that is when it reached the screen.
        ScreenProbeService.listener = { code, tvMs ->
            if (code != lastCode) {
                lastCode = code
                val s = doubleArrayOf(code.toDouble(), tvMs)
                synchronized(probeSamples) { probeSamples.add(s) }
                synchronized(probeArchive) { if (probeArchive.size < PROBE_ARCHIVE_MAX) probeArchive.add(s) }
            }
        }
        ui.requestScreenProbe { err ->
            if (err != null) {
                sendTo(c, JSONObject().put("t", "screen-probe-error").put("id", id).put("message", err))
                return@requestScreenProbe
            }
            probeTimer?.shutdownNow()
            probeTimer = Executors.newSingleThreadScheduledExecutor().apply {
                scheduleAtFixedRate({
                    val batch = synchronized(probeSamples) { ArrayList(probeSamples).also { probeSamples.clear() } }
                    val arr = org.json.JSONArray()
                    batch.forEach { arr.put(org.json.JSONArray().put(it[0].toInt()).put(it[1])) }
                    sendTo(probeConn ?: c, JSONObject().put("t", "screen-lat").put("id", id).put("samples", arr).put("running", ScreenProbeService.running))
                }, 1, 1, TimeUnit.SECONDS)
            }
            sendTo(c, JSONObject().put("t", "screen-probe-ready").put("id", id))
        }
    }

    /** Archived probe samples with TV time >= `since`; later live batches go to this connection. */
    private fun dumpScreenProbe(c: WebSocket, id: String, since: Double) {
        probeConn = c
        val arr = org.json.JSONArray()
        synchronized(probeArchive) { probeArchive.forEach { if (it[1] >= since) arr.put(org.json.JSONArray().put(it[0].toInt()).put(it[1])) } }
        sendTo(c, JSONObject().put("t", "screen-probe-dump").put("id", id).put("samples", arr).put("running", ScreenProbeService.running))
    }

    private fun stopScreenProbe() {
        probeTimer?.shutdownNow()
        probeTimer = null
        probeConn = null
        ScreenProbeService.listener = null
        ui.stopScreenProbe()
    }

    private fun sendTo(c: WebSocket, msg: JSONObject) {
        if (!c.isOpen) return
        try {
            c.send(msg.toString())
        } catch (e: Exception) {
            Log.w(TAG, "send failed", e)
        }
    }
}
