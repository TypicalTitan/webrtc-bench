package dev.webrtcbench.tv

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketAddress
import java.net.SocketTimeoutException
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

private const val TAG = "WebRTCBench"
private val START_CODE = byteArrayOf(0, 0, 0, 1)
private val SEI_UUID = "WebRTCBenchSEI01".toByteArray(Charsets.US_ASCII)
private const val MAX_PENDING = 6

/** "key=value,flag" -> map (a bare flag means "1"). */
fun parseOpts(s: String): Map<String, String> = s.split(',').mapNotNull { part ->
    val t = part.trim()
    when {
        t.isEmpty() -> null
        '=' in t -> t.substringBefore('=').trim() to t.substringAfter('=').trim()
        else -> t to "1"
    }
}.toMap()

/**
 * Native receive path for wbsend.exe: RTP over UDP -> access units -> low-latency MediaCodec
 * decoder rendering straight to a SurfaceView. No jitter buffer: a frame is queued to the decoder
 * as soon as its last packet arrives and released for display as soon as it decodes.
 *
 * Two latencies per frame, both against the capture time in the frame's SEI (which the sender
 * already converted to this TV's clock via ping/pong on the same socket):
 *  - capture -> decoded: when the decoder hands the frame back;
 *  - capture -> on screen: when the display actually showed it (OnFrameRenderedListener).
 *
 * Receiver options (TestSpec.opts, for experiments): margin=<ms> pacing margin, prio=normal
 * (default thread priorities), allm=0 (don't request the TV's game mode; MainActivity).
 * Tried and dropped on the Google TV Streamer: tunneled playback (MediaTek's tunnel path waits
 * for an audio clock and never shows a frame without one) and a decoder operating-rate boost
 * (no change in decode time).
 */
class NativeReceiver(
    override val spec: TestSpec,
    surface: Surface,
    private val sys: SysStats,
    /** Display refresh period (ms). */
    private val vsyncMs: Double,
    private val send: (JSONObject) -> Unit,
    private val onOverlay: (String) -> Unit,
) : BenchSession {
    private val opts = parseOpts(spec.opts)
    private val hevc = spec.codec == "H265"
    private val mime = if (hevc) MediaFormat.MIMETYPE_VIDEO_HEVC else MediaFormat.MIMETYPE_VIDEO_AVC
    private val render = spec.render != "none"
    private val frameIntervalMs = 1000.0 / max(1, spec.fps)
    /** Refreshes each frame should stay on screen (1 for 60 fps on 60 Hz, 2 for 30 fps). */
    private val vsyncsPerFrame = max(1, (frameIntervalMs / vsyncMs).roundToInt())

    private val socket = DatagramSocket(null).apply {
        reuseAddress = true
        receiveBufferSize = 8 shl 20
        soTimeout = 200
        bind(InetSocketAddress(Proto.NATIVE_PORT))
    }
    private val urgent = opts["prio"] != "normal"
    private val codecThread = HandlerThread("native-codec").apply { start() }
    private val codecHandler = Handler(codecThread.looper).apply { if (urgent) post { raisePriority() } }
    private val codec: MediaCodec
    val decoderName: String
    @Volatile private var closed = false
    private val rxThread: Thread

    // ---- access-unit assembly (rx thread) ----
    private val au = ByteArrayOutputStream(1 shl 20)
    private var auOpen = false
    private var auTs = -1L
    private var auBroken = false
    private var auKey = false
    private var auFirstMs = 0.0
    private var auFrameNo = -1L
    private var auCaptureTvMs = Double.NaN
    private var expectedSeq = -1
    @Volatile private var waitingForKey = true
    @Volatile private var sender: SocketAddress? = null
    private var lastKeyRequestMs = 0.0

    // ---- decoder feeding and output (codec thread) ----
    private class Au(val data: ByteArray, val key: Boolean, val frameNo: Long, val captureTvMs: Double, val firstMs: Double, val completeMs: Double)
    private class Meta(val captureTvMs: Double, val firstMs: Double, val completeMs: Double, val queuedMs: Double) {
        var decodedMs = Double.NaN
    }
    private val pending = ArrayDeque<Au>()
    private val freeInputs = ArrayDeque<Int>()
    /** pts -> frame, until it is shown (or decoded, without rendering) or expires. */
    private val inFlight = HashMap<Long, Meta>()
    private var lastPts = 0L
    private var lastOutputMs = 0.0
    private var lastPresentMs = Double.NaN
    private val pacer: VsyncPacer
    // Standing-queue detection: frames still inside the decoder each time one comes out.
    private var queuedToDecoder = 0L
    private var outOfDecoder = 0L
    private var minBacklog = Int.MAX_VALUE
    private var backlogSamples = 0
    private var drains = 0
    private var decoderNeedsKey = false

    // ---- statistics: per-second deltas plus run totals (guarded by `stats`) ----
    private class Counters {
        var aus = 0; var decoded = 0; var dropped = 0; var bytes = 0L; var packets = 0; var lost = 0
        var keyRequests = 0; var keyframes = 0; var freezes = 0; var freezeMs = 0.0; var drains = 0
        var decodeMsSum = 0.0; var assembleMsSum = 0.0; var netToDecodedSum = 0.0; var timed = 0
        val latency = ArrayList<Double>()
        // display side
        var displayed = 0; var displayDropped = 0; var decoderLost = 0; var paceErrors = 0; var repeats = 0
        var decodeToDisplaySum = 0.0; var displayTimed = 0
        val displayLatency = ArrayList<Double>()
    }
    private val stats = Any()
    private var cur = Counters()
    private val total = Counters()
    private var outW = spec.width
    private var outH = spec.height

    init {
        decoderName = pickDecoder()
        codec = MediaCodec.createByCodecName(decoderName)
        val fmt = MediaFormat.createVideoFormat(mime, spec.width, spec.height).apply {
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            setInteger(MediaFormat.KEY_PRIORITY, 0) // realtime
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, max(spec.width * spec.height, 2 shl 20))
        }
        codec.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
                freeInputs.addLast(index)
                feed()
            }

            override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                val now = tvClockMs()
                val meta = inFlight[info.presentationTimeUs]
                // An explicit "now" timestamp: show at the next vsync the compositor can make.
                if (render) c.releaseOutputBuffer(index, System.nanoTime()) else c.releaseOutputBuffer(index, false)
                if (meta == null) return
                meta.decodedMs = now
                if (!render) inFlight.remove(info.presentationTimeUs)
                onDecoded(now, meta)
                pacer.onDecoded(now)
                checkBacklog(now)
            }

            override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
                Log.w(TAG, "native decoder error", e)
                send(JSONObject().put("t", "rx-error").put("id", spec.id).put("message", "decoder: ${e.diagnosticInfo}"))
            }

            override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
                // KEY_WIDTH/HEIGHT are the (padded) buffer size; the crop rect is the picture.
                if (format.containsKey("crop-right") && format.containsKey("crop-bottom")) {
                    val left = if (format.containsKey("crop-left")) format.getInteger("crop-left") else 0
                    val top = if (format.containsKey("crop-top")) format.getInteger("crop-top") else 0
                    outW = format.getInteger("crop-right") - left + 1
                    outH = format.getInteger("crop-bottom") - top + 1
                } else {
                    outW = format.getInteger(MediaFormat.KEY_WIDTH)
                    outH = format.getInteger(MediaFormat.KEY_HEIGHT)
                }
            }
        }, codecHandler)
        if (render) codec.setOnFrameRenderedListener({ _, ptsUs, nanoTime -> onRendered(ptsUs, nanoTime) }, codecHandler)
        codec.configure(fmt, surface, null, 0)
        codec.setVideoScalingMode(MediaCodec.VIDEO_SCALING_MODE_SCALE_TO_FIT)

        val rateOk = abs(frameIntervalMs - vsyncsPerFrame * vsyncMs) < 0.02 * vsyncMs
        pacer = VsyncPacer(
            active = render,
            enabled = render && spec.pacing == "vsync" && rateOk,
            periodMs = vsyncMs,
            // 3 ms keeps ~99.5% of frames on their refresh on the Google TV Streamer (1 ms: ~98%).
            marginMs = opts["margin"]?.toDoubleOrNull() ?: 3.0,
            window = max(30, spec.fps),
        ) { ms ->
            val msg = ByteArray(12)
            "WBPH".toByteArray().copyInto(msg)
            putF64(msg, 4, ms)
            sendToSender(msg)
        }
        if (spec.pacing == "vsync" && !pacer.enabled) {
            pacer.note = if (!render) "decode-only test"
            else String.format(Locale.US, "%d fps does not divide the %.2f Hz display", spec.fps, 1000 / vsyncMs)
        }

        codec.start()
        rxThread = Thread({
            if (urgent) raisePriority()
            receiveLoop()
        }, "native-rx").apply { start() }
        codecHandler.postDelayed({ statsTick.run() }, 1000)
        onOverlay(header() + "\nwaiting for stream…")
    }

    /** Prefer the dedicated low-latency hardware decoder (e.g. c2.mtk.avc.decoder.lowlatency). */
    private fun pickDecoder(): String {
        val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
            !info.isEncoder && !info.name.endsWith(".secure") && info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
        }
        fun hw(i: MediaCodecInfo) = Build.VERSION.SDK_INT < 29 || i.isHardwareAccelerated
        fun feature(i: MediaCodecInfo, f: String) = try {
            i.getCapabilitiesForType(mime).isFeatureSupported(f)
        } catch (_: Exception) {
            false
        }
        fun lowLatency(i: MediaCodecInfo) = Build.VERSION.SDK_INT >= 30 && feature(i, MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
        return (infos.firstOrNull { hw(it) && it.name.contains("lowlatency") }
            ?: infos.firstOrNull { hw(it) && lowLatency(it) }
            ?: infos.firstOrNull { hw(it) }
            ?: infos.first()).name
    }

    // ---------------------------------------------------------------- network

    private fun receiveLoop() {
        val buf = ByteArray(65536)
        val pkt = DatagramPacket(buf, buf.size)
        while (!closed) {
            try {
                socket.receive(pkt)
            } catch (_: SocketTimeoutException) {
                continue
            } catch (e: Exception) {
                if (closed) break
                Log.w(TAG, "native receive", e)
                continue
            }
            val now = tvClockMs()
            val n = pkt.length
            if (n >= 16 && buf[0] == 'W'.code.toByte() && buf[1] == 'B'.code.toByte() && buf[2] == 'P'.code.toByte() && buf[3] == 'I'.code.toByte()) {
                // Clock sync: echo seq + sender time, append our clock.
                val reply = ByteArray(24)
                "WBPO".toByteArray().copyInto(reply)
                buf.copyInto(reply, 4, 4, 16)
                putF64(reply, 16, now)
                try {
                    socket.send(DatagramPacket(reply, reply.size, pkt.socketAddress))
                } catch (_: Exception) {
                }
                continue
            }
            if (n < 12 || (buf[0].toInt() and 0xC0) != 0x80) continue
            sender = pkt.socketAddress
            onRtp(buf, n, now)
        }
    }

    private fun onRtp(b: ByteArray, n: Int, now: Double) {
        val seq = ((b[2].toInt() and 0xff) shl 8) or (b[3].toInt() and 0xff)
        val ts = ((b[4].toLong() and 0xff) shl 24) or ((b[5].toLong() and 0xff) shl 16) or
            ((b[6].toLong() and 0xff) shl 8) or (b[7].toLong() and 0xff)
        val marker = (b[1].toInt() and 0x80) != 0
        val cc = b[0].toInt() and 0x0F
        val hasExt = (b[0].toInt() and 0x10) != 0
        var off = 12 + 4 * cc
        if (hasExt && n >= off + 4) off += 4 + 4 * (((b[off + 2].toInt() and 0xff) shl 8) or (b[off + 3].toInt() and 0xff))
        if (off >= n) return

        var lost = 0
        if (expectedSeq >= 0 && seq != expectedSeq) {
            val gap = (seq - expectedSeq) and 0xffff
            if (gap in 1..999) lost = gap
        }
        expectedSeq = (seq + 1) and 0xffff
        synchronized(stats) {
            cur.packets++; total.packets++
            cur.bytes += n; total.bytes += n
            cur.lost += lost; total.lost += lost
        }

        if (ts != auTs) {
            if (auOpen) {
                auBroken = true // previous frame never got its marker packet
                finishAu(now)
            }
            startAu(ts, now)
            auBroken = lost > 0
        } else if (lost > 0) {
            auBroken = true
        }
        depacketize(b, off, n - off)
        if (marker) finishAu(now)
    }

    private fun startAu(ts: Long, now: Double) {
        au.reset()
        auOpen = true
        auTs = ts
        auKey = false
        auFirstMs = now
        auFrameNo = -1
        auCaptureTvMs = Double.NaN
    }

    private fun writeNalStart(nalType: Int) {
        au.write(START_CODE)
        if (hevc) {
            if (nalType in 16..21) auKey = true // IRAP pictures
        } else if (nalType == 5) {
            auKey = true // IDR
        }
    }

    private fun depacketize(b: ByteArray, off: Int, len: Int) {
        if (len < 2) return
        val p0 = b[off].toInt() and 0xff
        if (!hevc) {
            when (val type = p0 and 0x1F) {
                in 1..23 -> {
                    writeNalStart(type)
                    au.write(b, off, len)
                    if (type == 6) parseSei(b, off + 1, len - 1)
                }
                24 -> { // STAP-A
                    var i = off + 1
                    while (i + 2 <= off + len) {
                        val sz = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
                        i += 2
                        if (sz <= 0 || i + sz > off + len) break
                        val t = b[i].toInt() and 0x1F
                        writeNalStart(t)
                        au.write(b, i, sz)
                        if (t == 6) parseSei(b, i + 1, sz - 1)
                        i += sz
                    }
                }
                28 -> { // FU-A
                    val fh = b[off + 1].toInt() and 0xff
                    if (fh and 0x80 != 0) {
                        val t = fh and 0x1F
                        writeNalStart(t)
                        au.write((p0 and 0xE0) or t)
                    }
                    au.write(b, off + 2, len - 2)
                }
            }
        } else {
            if (len < 3) return
            when (val type = (p0 shr 1) and 0x3F) {
                49 -> { // FU
                    val fh = b[off + 2].toInt() and 0xff
                    if (fh and 0x80 != 0) {
                        val t = fh and 0x3F
                        writeNalStart(t)
                        au.write((p0 and 0x81) or (t shl 1))
                        au.write(b[off + 1].toInt() and 0xff)
                    }
                    au.write(b, off + 3, len - 3)
                }
                48 -> { // aggregation packet
                    var i = off + 2
                    while (i + 2 <= off + len) {
                        val sz = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
                        i += 2
                        if (sz <= 0 || i + sz > off + len) break
                        val t = (b[i].toInt() shr 1) and 0x3F
                        writeNalStart(t)
                        au.write(b, i, sz)
                        if (t == 39) parseSei(b, i + 2, sz - 2)
                        i += sz
                    }
                }
                else -> {
                    writeNalStart(type)
                    au.write(b, off, len)
                    if (type == 39) parseSei(b, off + 2, len - 2)
                }
            }
        }
    }

    /** Reads our user-data-unregistered SEI: frame number + capture time on this TV's clock. */
    private fun parseSei(b: ByteArray, off: Int, len: Int) {
        val rbsp = ByteArrayOutputStream(len)
        var zeros = 0
        for (i in off until off + len) {
            val v = b[i].toInt() and 0xff
            if (zeros >= 2 && v == 3) {
                zeros = 0
                continue
            }
            rbsp.write(v)
            zeros = if (v == 0) zeros + 1 else 0
        }
        val r = rbsp.toByteArray()
        var i = 0
        while (i < r.size && (r[i].toInt() and 0xff) != 0x80) {
            var type = 0
            while (i < r.size && (r[i].toInt() and 0xff) == 0xff) { type += 255; i++ }
            if (i >= r.size) return
            type += r[i++].toInt() and 0xff
            var size = 0
            while (i < r.size && (r[i].toInt() and 0xff) == 0xff) { size += 255; i++ }
            if (i >= r.size) return
            size += r[i++].toInt() and 0xff
            if (i + size > r.size) return
            if (type == 5 && size >= 36 && (0 until 16).all { r[i + it] == SEI_UUID[it] }) {
                auFrameNo = ((r[i + 16].toLong() and 0xff) shl 24) or ((r[i + 17].toLong() and 0xff) shl 16) or
                    ((r[i + 18].toLong() and 0xff) shl 8) or (r[i + 19].toLong() and 0xff)
                auCaptureTvMs = getF64(r, i + 20)
            }
            i += size
        }
    }

    private fun finishAu(now: Double) {
        auOpen = false
        val data = au.toByteArray()
        synchronized(stats) { cur.aus++; total.aus++ }
        if (data.isEmpty()) return
        if (auBroken) {
            dropped(1)
            waitingForKey = true
            requestKeyframe(now)
            return
        }
        if (waitingForKey) {
            if (!auKey) {
                dropped(1)
                requestKeyframe(now)
                return
            }
            waitingForKey = false
        }
        if (auKey) synchronized(stats) { cur.keyframes++; total.keyframes++ }
        val unit = Au(data, auKey, auFrameNo, auCaptureTvMs, auFirstMs, now)
        codecHandler.post {
            pending.addLast(unit)
            if (pending.size > MAX_PENDING) {
                // Decoder can't keep up: drop the backlog and restart from a keyframe rather
                // than letting latency grow without bound.
                dropped(pending.size)
                pending.clear()
                waitingForKey = true
                requestKeyframe(tvClockMs())
            }
            feed()
        }
    }

    private fun dropped(n: Int) = synchronized(stats) { cur.dropped += n; total.dropped += n }

    /** Asks wbsend for an IDR; repeats at most every 80 ms (a lost keyframe is re-requested quickly). */
    private fun requestKeyframe(now: Double, force: Boolean = false) {
        if (!force && now - lastKeyRequestMs < 80) return
        if (sendToSender("WBKF".toByteArray() + byteArrayOf(0, 0, 0, 0))) {
            lastKeyRequestMs = now
            synchronized(stats) { cur.keyRequests++; total.keyRequests++ }
        }
    }

    private fun sendToSender(msg: ByteArray): Boolean {
        val to = sender ?: return false
        return try {
            socket.send(DatagramPacket(msg, msg.size, to))
            true
        } catch (_: Exception) {
            false
        }
    }

    // ---------------------------------------------------------------- decoder (codec thread)

    private fun feed() {
        while (!closed && freeInputs.isNotEmpty() && pending.isNotEmpty()) {
            val unit = pending.removeFirst()
            if (decoderNeedsKey) {
                // After a flush the decoder has no references: skip until a keyframe.
                if (!unit.key) {
                    dropped(1)
                    continue
                }
                decoderNeedsKey = false
            }
            val index = freeInputs.removeFirst()
            val buf = codec.getInputBuffer(index) ?: continue
            buf.clear()
            if (unit.data.size > buf.capacity()) {
                Log.w(TAG, "access unit ${unit.data.size} B exceeds input buffer ${buf.capacity()} B")
                freeInputs.addFirst(index)
                dropped(1)
                continue
            }
            buf.put(unit.data)
            // Presentation time = capture time on our clock (µs), strictly increasing. Display
            // timing ignores it (frames are released with "now"); it identifies the frame.
            val capUs = if (unit.captureTvMs.isFinite()) (unit.captureTvMs * 1000).roundToLong() else 0L
            val pts = max(capUs, lastPts + 1)
            lastPts = pts
            inFlight[pts] = Meta(unit.captureTvMs, unit.firstMs, unit.completeMs, tvClockMs())
            codec.queueInputBuffer(index, 0, unit.data.size, pts, if (unit.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            queuedToDecoder++
        }
    }

    /**
     * A low-latency decoder returns each frame before the next one arrives. If a hiccup (often at
     * startup) leaves frames queued inside it, it keeps decoding one-in-one-out with that backlog
     * forever, adding whole frames of latency. When every output for a second still has frames
     * queued behind it, flush the decoder and restart from a fresh keyframe (at most twice per
     * test, in case a decoder genuinely needs look-ahead).
     */
    private fun checkBacklog(now: Double) {
        outOfDecoder++
        minBacklog = min(minBacklog, (queuedToDecoder - outOfDecoder).toInt())
        if (++backlogSamples < max(30, spec.fps)) return
        val standing = minBacklog
        backlogSamples = 0
        minBacklog = Int.MAX_VALUE
        if (standing < 1 || drains >= 2) return
        drains++
        Log.i(TAG, "decoder backlog of $standing frame(s): flushing")
        try {
            codec.flush()
        } catch (e: Exception) {
            Log.w(TAG, "flush failed", e)
            return
        }
        freeInputs.clear()
        val lost = inFlight.values.count { it.decodedMs.isNaN() }
        inFlight.clear()
        dropped(lost + pending.size)
        pending.clear()
        queuedToDecoder = 0
        outOfDecoder = 0
        decoderNeedsKey = true
        requestKeyframe(now, force = true)
        synchronized(stats) { cur.drains++; total.drains++ }
        codec.start() // asynchronous mode: resume after flush
    }

    private fun onDecoded(now: Double, m: Meta) {
        synchronized(stats) {
            for (c in arrayOf(cur, total)) {
                c.decoded++
                c.decodeMsSum += now - m.queuedMs
                c.assembleMsSum += m.completeMs - m.firstMs
                c.netToDecodedSum += now - m.firstMs
                c.timed++
                if (!m.captureTvMs.isNaN()) {
                    val lat = now - m.captureTvMs
                    if (lat > -5 && lat < 5000) c.latency.add(lat)
                }
            }
            if (lastOutputMs > 0) {
                val gap = now - lastOutputMs
                if (gap > max(3 * frameIntervalMs, 150.0)) {
                    for (c in arrayOf(cur, total)) { c.freezes++; c.freezeMs += gap }
                }
            }
            lastOutputMs = now
        }
    }

    /** The display showed frame `ptsUs` at `nanoTime` (System.nanoTime clock). */
    private fun onRendered(ptsUs: Long, nanoTime: Long) {
        val m = inFlight.remove(ptsUs) ?: return
        val presentMs = (nanoTime + (SystemClock.elapsedRealtimeNanos() - System.nanoTime())) / 1e6
        synchronized(stats) {
            for (c in arrayOf(cur, total)) {
                c.displayed++
                if (!m.decodedMs.isNaN()) {
                    c.decodeToDisplaySum += presentMs - m.decodedMs
                    c.displayTimed++
                }
                if (!m.captureTvMs.isNaN()) {
                    val lat = presentMs - m.captureTvMs
                    if (lat > -5 && lat < 5000) c.displayLatency.add(lat)
                }
            }
            if (!lastPresentMs.isNaN() && presentMs > lastPresentMs) {
                val k = ((presentMs - lastPresentMs) / vsyncMs).roundToInt()
                if (k != vsyncsPerFrame) for (c in arrayOf(cur, total)) {
                    c.paceErrors++
                    if (k > vsyncsPerFrame) c.repeats += k - vsyncsPerFrame
                }
            }
            if (lastPresentMs.isNaN() || presentMs > lastPresentMs) lastPresentMs = presentMs
        }
        pacer.onPresented(m.decodedMs, presentMs)
    }

    /** Frames that were never shown: released but replaced before a vsync, or lost in the decoder. */
    private fun expireInFlight(now: Double) {
        if (!render) return
        var shown = 0
        var lostInDecoder = 0
        val it = inFlight.values.iterator()
        while (it.hasNext()) {
            val m = it.next()
            if (now - m.queuedMs < 1000) continue
            if (m.decodedMs.isNaN()) lostInDecoder++ else shown++
            it.remove()
        }
        if (shown + lostInDecoder == 0) return
        synchronized(stats) {
            for (c in arrayOf(cur, total)) { c.displayDropped += shown; c.decoderLost += lostInDecoder }
        }
    }

    // ---------------------------------------------------------------- vsync pacing (codec thread)


    // ---------------------------------------------------------------- stats

    private val statsTick = object : Runnable {
        override fun run() {
            if (closed) return
            expireInFlight(tvClockMs())
            val msg = synchronized(stats) {
                val c = cur
                cur = Counters()
                buildStats("native-stats", c)
            }
            send(msg)
            onOverlay(overlayText(msg))
            codecHandler.postDelayed(this, 1000)
        }
    }

    private fun buildStats(type: String, c: Counters): JSONObject {
        val o = JSONObject().put("t", type).put("id", spec.id).put("ts", System.currentTimeMillis())
            .put("decoder", decoderName).put("width", outW).put("height", outH)
            .put("aus", c.aus).put("decoded", c.decoded).put("dropped", c.dropped)
            .put("bytes", c.bytes).put("packets", c.packets).put("lost", c.lost)
            .put("keyRequests", c.keyRequests).put("keyframes", c.keyframes)
            .put("freezes", c.freezes).put("freezeMs", c.freezeMs).put("drains", c.drains)
        if (c.timed > 0) {
            o.put("decodeMs", c.decodeMsSum / c.timed)
            o.put("assembleMs", c.assembleMsSum / c.timed)
            o.put("netToDecodedMs", c.netToDecodedSum / c.timed)
        }
        o.put("latency", JSONArray(c.latency.map { Math.round(it * 100) / 100.0 }))
        if (render) {
            o.put("pacing", pacer.toJson()).put("vsyncMs", vsyncMs).put("decoderLost", c.decoderLost)
            // Only with real display times (see Pacer.timingValid); otherwise these would just
            // repeat the decode times.
            if (pacer.timingValid == true) {
                o.put("displayed", c.displayed).put("displayDropped", c.displayDropped)
                    .put("paceErrors", c.paceErrors).put("repeats", c.repeats)
                if (c.displayTimed > 0) o.put("decodeToDisplayMs", c.decodeToDisplaySum / c.displayTimed)
                o.put("displayLatency", JSONArray(c.displayLatency.map { Math.round(it * 100) / 100.0 }))
            }
        }
        if (type == "native-stats") o.put("sys", sys.sample())
        return o
    }

    private fun header() = "Native NVENC · ${spec.codec} ${spec.width}×${spec.height} @ ${spec.fps} · " +
        "${"%.1f".format(Locale.US, spec.bitrateKbps / 1000.0)} Mbps · Test ${spec.index}/${spec.total}"

    private fun medianP95(a: JSONArray?): Pair<Double?, Double?> {
        val sorted = (0 until (a?.length() ?: 0)).map { a!!.getDouble(it) }.sorted()
        return sorted.getOrNull(sorted.size / 2) to sorted.getOrNull(((sorted.size - 1) * 0.95).toInt())
    }

    private fun overlayText(m: JSONObject): String {
        fun f(v: Double?) = v?.let { "%.0f".format(Locale.US, it) } ?: "–"
        val (med, p95) = medianP95(m.optJSONArray("latency"))
        val lines = mutableListOf(
            header(),
            "decoder  $decoderName",
            String.format(Locale.US, "frames   %d decoded · %d dropped · %d lost packets", m.optInt("decoded"), m.optInt("dropped"), m.optInt("lost")),
            "latency  ${f(med)} ms median · ${f(p95)} p95 (capture → decoded)",
        )
        if (render && pacer.timingValid == false) {
            lines += "display  on-screen time not reported by this TV · pacing unavailable"
        } else if (render) {
            val (dMed, dP95) = medianP95(m.optJSONArray("displayLatency"))
            lines += "         ${f(dMed)} ms median · ${f(dP95)} p95 (capture → on screen)"
            lines += String.format(
                Locale.US, "display  %d shown · %d replaced · %d repeats · pacing %s%s",
                m.optInt("displayed"), m.optInt("displayDropped"), m.optInt("repeats"), pacer.state,
                if (pacer.state == "locked") String.format(Locale.US, " (slack %.1f ms)", pacer.slackLowMs) else "",
            )
        }
        lines += String.format(
            Locale.US, "timing   packets→decoded %.1f ms · decode %.1f ms · %.1f Mbps",
            m.optDouble("netToDecodedMs", 0.0), m.optDouble("decodeMs", 0.0), m.optLong("bytes") * 8 / 1e6
        )
        return lines.joinToString("\n")
    }

    override fun close(): JSONObject? {
        if (closed) return null
        closed = true
        socket.close()
        try {
            rxThread.join(500)
        } catch (_: InterruptedException) {
        }
        val done = CountDownLatch(1)
        codecHandler.post {
            try {
                codec.stop()
            } catch (_: Exception) {
            }
            codec.release()
            done.countDown()
        }
        done.await(2, TimeUnit.SECONDS)
        codecThread.quitSafely()
        return synchronized(stats) { buildStats("native-final", total) }
    }

    companion object {
        /** Display-thread priority for the packet and codec threads (ignored if not permitted). */
        private fun raisePriority() {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            } catch (e: Exception) {
                Log.w(TAG, "cannot raise thread priority", e)
            }
        }

        private fun putF64(b: ByteArray, at: Int, d: Double) {
            val v = java.lang.Double.doubleToRawLongBits(d)
            for (i in 0 until 8) b[at + i] = (v ushr (56 - 8 * i)).toByte()
        }

        private fun getF64(b: ByteArray, at: Int): Double {
            var v = 0L
            for (i in 0 until 8) v = (v shl 8) or (b[at + i].toLong() and 0xff)
            return java.lang.Double.longBitsToDouble(v)
        }
    }
}
