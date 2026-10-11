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
import org.webrtc.EncodedImage
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory
import org.webrtc.VideoFrame
import org.webrtc.WrappedNativeVideoDecoder
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

private const val TAG = "WebRTCBench"
private val SEI_UUID = "WebRTCBenchSEI01".toByteArray(Charsets.US_ASCII)

/** Prefer the dedicated low-latency hardware decoder (e.g. c2.mtk.avc.decoder.lowlatency). */
fun pickLowLatencyDecoder(mime: String): String {
    val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
        !info.isEncoder && !info.name.endsWith(".secure") && info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
    }
    fun hw(i: MediaCodecInfo) = Build.VERSION.SDK_INT < 29 || i.isHardwareAccelerated
    fun lowLatency(i: MediaCodecInfo) = Build.VERSION.SDK_INT >= 30 && try {
        i.getCapabilitiesForType(mime).isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
    } catch (_: Exception) {
        false
    }
    return (infos.firstOrNull { hw(it) && it.name.contains("lowlatency") }
        ?: infos.firstOrNull { hw(it) && lowLatency(it) }
        ?: infos.firstOrNull { hw(it) }
        ?: infos.first()).name
}

/**
 * The PC's timing SEI (user data unregistered, UUID "WebRTCBenchSEI01"): frame number and the
 * capture time already converted to this TV's clock. Same layout from wbsend.exe and from the
 * WebRTC sender's encoded transform (desktop/src/sei-worker.js).
 */
object TimingSei {
    class Tag(val frameNo: Long, val captureTvMs: Double)

    /** The timing tag of an Annex-B access unit, or null. Stops at the first picture NAL. */
    fun read(buf: ByteBuffer, hevc: Boolean): Tag? {
        val b = buf.duplicate()
        val start = b.position()
        val end = b.limit()
        var i = start
        while (i + 3 < end) {
            if (b.get(i) != 0.toByte() || b.get(i + 1) != 0.toByte() || b.get(i + 2) != 1.toByte()) {
                i++
                continue
            }
            val h = b.get(i + 3).toInt() and 0xff
            val type = if (hevc) (h shr 1) and 0x3f else h and 0x1f
            val vcl = if (hevc) type <= 31 else type in 1..5
            if (vcl) return null
            val isSei = if (hevc) type == 39 else type == 6
            if (isSei) {
                val payloadStart = i + 3 + if (hevc) 2 else 1
                var j = payloadStart
                while (j + 2 < end && !(b.get(j) == 0.toByte() && b.get(j + 1) == 0.toByte() && (b.get(j + 2) == 1.toByte() || b.get(j + 2) == 0.toByte()))) j++
                parse(b, payloadStart, (if (j + 2 >= end) end else j) - payloadStart)?.let { return it }
            }
            i += 3
        }
        return null
    }

    private fun parse(b: ByteBuffer, off: Int, len: Int): Tag? {
        val r = ByteArray(len)
        var n = 0
        var zeros = 0
        for (k in off until off + len) {
            val v = b.get(k).toInt() and 0xff
            if (zeros >= 2 && v == 3) {
                zeros = 0
                continue
            }
            r[n++] = v.toByte()
            zeros = if (v == 0) zeros + 1 else 0
        }
        var i = 0
        while (i < n && (r[i].toInt() and 0xff) != 0x80) {
            var type = 0
            while (i < n && (r[i].toInt() and 0xff) == 0xff) { type += 255; i++ }
            if (i >= n) return null
            type += r[i++].toInt() and 0xff
            var size = 0
            while (i < n && (r[i].toInt() and 0xff) == 0xff) { size += 255; i++ }
            if (i >= n) return null
            size += r[i++].toInt() and 0xff
            if (i + size > n) return null
            if (type == 5 && size >= 36 && (0 until 16).all { r[i + it] == SEI_UUID[it] }) {
                var frameNo = 0L
                for (k in 0 until 4) frameNo = (frameNo shl 8) or (r[i + 16 + k].toLong() and 0xff)
                var v = 0L
                for (k in 0 until 8) v = (v shl 8) or (r[i + 20 + k].toLong() and 0xff)
                return Tag(frameNo, java.lang.Double.longBitsToDouble(v))
            }
            i += size
        }
        return null
    }
}

/**
 * Per-test frame timing for the WebRTC receiver, keyed by the frame's RTP-derived timestamp
 * (EncodedImage.captureTimeNs -> decoded VideoFrame.timestampNs, in µs): capture -> decoded and,
 * for the direct decoder, capture -> shown plus display cadence. Thread-safe.
 */
class FrameTimingCollector(private val vsyncMs: Double, fps: Int) {
    private class Entry(val frameNo: Long, val captureTvMs: Double) {
        var decodedMs = Double.NaN
    }
    private val lock = Any()
    private val entries = LinkedHashMap<Long, Entry>()
    private var decoded = ArrayList<Double>()
    private var screen = ArrayList<Double>()
    /** [frame code, decoded TV ms] for every 4th frame: cross-check against the pixel probe. */
    private var codes = ArrayList<DoubleArray>()
    private var decodedCount = 0
    private var shown = 0
    private var repeats = 0
    private var replaced = 0
    private var tagged = 0
    private val vsyncsPerFrame = max(1, (1000.0 / max(1, fps) / vsyncMs).roundToInt())
    private var lastPresentMs = Double.NaN
    // Shown-at times must sit on a vsync grid to count as real display times (Fire OS reports
    // queue times instead); null until 30 frames were seen.
    private var sumSin = 0.0
    private var sumCos = 0.0
    private var nGrid = 0
    @Volatile var displayValid: Boolean? = null
        private set
    @Volatile var direct = false

    fun onInput(key: Long, tag: TimingSei.Tag?) = synchronized(lock) {
        if (tag == null || tag.captureTvMs.isNaN()) return
        tagged++
        entries[key] = Entry(tag.frameNo, tag.captureTvMs)
        if (entries.size > 600) entries.remove(entries.keys.first())
    }

    fun onDecoded(key: Long, nowMs: Double) = synchronized(lock) {
        decodedCount++
        val e = entries[key] ?: return
        e.decodedMs = nowMs
        val lat = nowMs - e.captureTvMs
        if (lat > -5 && lat < 5000) decoded.add(lat)
        if (e.frameNo % 4 == 0L) codes.add(doubleArrayOf((e.frameNo and 0xffff).toDouble(), nowMs))
        if (!direct) entries.remove(key)
    }

    fun onShown(key: Long, presentMs: Double) = synchronized(lock) {
        val e = entries.remove(key)
        if (displayValid == null) {
            val a = 2 * PI * (((presentMs % vsyncMs) + vsyncMs) % vsyncMs) / vsyncMs
            sumSin += sin(a)
            sumCos += cos(a)
            if (++nGrid >= 30) displayValid = hypot(sumSin, sumCos) / nGrid >= 0.9
        }
        shown++
        if (e != null) {
            val lat = presentMs - e.captureTvMs
            if (lat > -5 && lat < 5000) screen.add(lat)
        }
        if (!lastPresentMs.isNaN() && presentMs > lastPresentMs) {
            val k = ((presentMs - lastPresentMs) / vsyncMs).roundToInt()
            if (k > vsyncsPerFrame) repeats += k - vsyncsPerFrame
        }
        if (lastPresentMs.isNaN() || presentMs > lastPresentMs) lastPresentMs = presentMs
    }

    /** Per-second snapshot for rx-stats; display numbers only when the times are real. */
    fun drain(): JSONObject = synchronized(lock) {
        val now = tvClockMs()
        if (direct) {
            val it = entries.values.iterator()
            while (it.hasNext()) {
                val e = it.next()
                if (!e.decodedMs.isNaN() && now - e.decodedMs > 1000) {
                    replaced++
                    it.remove()
                }
            }
        }
        val o = JSONObject().put("direct", direct).put("tagged", tagged).put("decodedCount", decodedCount)
            .put("decoded", JSONArray(decoded.map { Math.round(it * 100) / 100.0 }))
            .put("codes", JSONArray(codes.map { JSONArray().put(it[0].toInt()).put(it[1]) }))
        if (direct && displayValid == true) {
            o.put("displayValid", true).put("shown", shown).put("repeats", repeats).put("replaced", replaced)
                .put("screen", JSONArray(screen.map { Math.round(it * 100) / 100.0 }))
        } else if (direct && displayValid == false) {
            o.put("displayValid", false)
        }
        decoded = ArrayList()
        screen = ArrayList()
        codes = ArrayList()
        decodedCount = 0
        shown = 0
        repeats = 0
        replaced = 0
        tagged = 0
        o
    }
}

/** What the decoder factory needs to know about the test that is starting. */
/** `pacer` (direct decoding only) steers the PC's frame clock to this display's vsync. */
class DecodeContext(val spec: TestSpec, val timing: FrameTimingCollector, val surface: Surface?, val pacer: VsyncPacer? = null)

/**
 * Wraps the stock decoder factory. H.264/H.265 decoders are timed through the SEI; with a
 * direct surface (cloud-gaming profile) they are replaced by [DirectSurfaceDecoder].
 */
class TimedDecoderFactory(
    private val inner: VideoDecoderFactory,
    /** "auto" mode: the stock factory pairs H.264/H.265 hardware with a platform software
     *  fallback inside a native wrapper that Java cannot intercept; take the hardware one directly. */
    private val hardware: VideoDecoderFactory?,
    private val context: () -> DecodeContext?,
) : VideoDecoderFactory {
    override fun getSupportedCodecs(): Array<VideoCodecInfo> = inner.supportedCodecs

    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? {
        val ctx = context()
        val name = info.name.uppercase()
        val timed = name == "H264" || name == "H265"
        if (ctx != null && timed && ctx.surface != null) return DirectSurfaceDecoder(name == "H265", ctx.surface, ctx.timing, ctx.pacer)
        if (ctx != null && timed && hardware != null) {
            hardware.createDecoder(info)?.takeIf { it !is WrappedNativeVideoDecoder }?.let { return TimedDecoder(it, name == "H265", ctx.timing) }
        }
        val d = inner.createDecoder(info) ?: return null
        // Native-backed decoders (libvpx, dav1d, the sw/hw fallback) never see Java decode().
        return if (ctx != null && timed && d !is WrappedNativeVideoDecoder) TimedDecoder(d, name == "H265", ctx.timing) else d
    }
}

/** Pass-through around the stock MediaCodec decoder that records SEI capture and decode times. */
class TimedDecoder(private val inner: VideoDecoder, private val hevc: Boolean, private val timing: FrameTimingCollector) : VideoDecoder {
    override fun initDecode(settings: VideoDecoder.Settings, callback: VideoDecoder.Callback): VideoCodecStatus =
        inner.initDecode(settings) { frame, decodeTimeMs, qp ->
            timing.onDecoded(frame.timestampNs / 1000, tvClockMs())
            callback.onDecodedFrame(frame, decodeTimeMs, qp)
        }

    override fun decode(frame: EncodedImage, info: VideoDecoder.DecodeInfo?): VideoCodecStatus {
        timing.onInput(frame.captureTimeNs / 1000, TimingSei.read(frame.buffer, hevc))
        return inner.decode(frame, info)
    }

    override fun release(): VideoCodecStatus = inner.release()
    override fun getImplementationName(): String = inner.implementationName
}

/** Stands in for a decoded picture that went straight to the screen: size only, no pixels. */
private class SizeOnlyBuffer(private val w: Int, private val h: Int) : VideoFrame.Buffer {
    override fun getWidth() = w
    override fun getHeight() = h
    override fun toI420(): VideoFrame.I420Buffer = JavaI420Buffer.allocate(w, h)
    override fun retain() {}
    override fun release() {}
    override fun cropAndScale(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int, scaleWidth: Int, scaleHeight: Int): VideoFrame.Buffer =
        SizeOnlyBuffer(scaleWidth, scaleHeight)
}

/**
 * Cloud-gaming decode path for WebRTC: the low-latency MediaCodec decoder renders straight onto
 * the native SurfaceView (no SurfaceTexture, no GL renderer, no one-texture-at-a-time handoff,
 * which is what capped the Google TV at 40-50 fps), and each frame is released for display the
 * moment it decodes. libwebrtc still gets a size-only frame per decoded picture, so its jitter
 * buffer, stats and keyframe requests work as usual.
 */
class DirectSurfaceDecoder(
    private val hevc: Boolean,
    private val surface: Surface,
    private val timing: FrameTimingCollector,
    private val pacer: VsyncPacer?,
) : VideoDecoder {
    private val mime = if (hevc) MediaFormat.MIMETYPE_VIDEO_HEVC else MediaFormat.MIMETYPE_VIDEO_AVC
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var codec: MediaCodec? = null
    // libwebrtc asks for the implementation name before initDecode, so pick the decoder now.
    private var name = pickLowLatencyDecoder(mime)
    private var callback: VideoDecoder.Callback? = null
    private val pending = ArrayDeque<Triple<ByteArray, Long, Boolean>>()
    private val freeInputs = ArrayDeque<Int>()
    private val queuedAt = HashMap<Long, Double>()
    private val decodedAt = LinkedHashMap<Long, Double>()
    @Volatile private var width = 0
    @Volatile private var height = 0
    @Volatile private var failed = false

    override fun initDecode(settings: VideoDecoder.Settings, callback: VideoDecoder.Callback): VideoCodecStatus {
        this.callback = callback
        timing.direct = true
        width = max(settings.width, 16)
        height = max(settings.height, 16)
        return try {
            val t = HandlerThread("direct-dec").apply { start() }
            thread = t
            val h = Handler(t.looper)
            handler = h
            h.post {
                try {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
                } catch (_: Exception) {
                }
            }
            val c = MediaCodec.createByCodecName(name)
            val fmt = MediaFormat.createVideoFormat(mime, width, height).apply {
                if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, max(3840 * 2160, 2 shl 20))
            }
            c.setCallback(object : MediaCodec.Callback() {
                override fun onInputBufferAvailable(mc: MediaCodec, index: Int) {
                    freeInputs.addLast(index)
                    feed()
                }

                override fun onOutputBufferAvailable(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                    val now = tvClockMs()
                    mc.releaseOutputBuffer(index, System.nanoTime())
                    val key = info.presentationTimeUs
                    timing.onDecoded(key, now)
                    pacer?.onDecoded(now)
                    decodedAt[key] = now
                    if (decodedAt.size > 120) decodedAt.remove(decodedAt.keys.first())
                    val q = queuedAt.remove(key)
                    val frame = VideoFrame(SizeOnlyBuffer(width, height), 0, key * 1000)
                    this@DirectSurfaceDecoder.callback?.onDecodedFrame(frame, q?.let { (now - it).roundToInt() }, null)
                }

                override fun onError(mc: MediaCodec, e: MediaCodec.CodecException) {
                    Log.w(TAG, "direct decoder error", e)
                    failed = true
                }

                override fun onOutputFormatChanged(mc: MediaCodec, format: MediaFormat) {
                    if (format.containsKey("crop-right") && format.containsKey("crop-bottom")) {
                        val left = if (format.containsKey("crop-left")) format.getInteger("crop-left") else 0
                        val top = if (format.containsKey("crop-top")) format.getInteger("crop-top") else 0
                        width = format.getInteger("crop-right") - left + 1
                        height = format.getInteger("crop-bottom") - top + 1
                    }
                }
            }, h)
            c.setOnFrameRenderedListener({ _, ptsUs, nanoTime ->
                val presentMs = (nanoTime + (SystemClock.elapsedRealtimeNanos() - System.nanoTime())) / 1e6
                timing.onShown(ptsUs, presentMs)
                pacer?.onPresented(decodedAt.remove(ptsUs) ?: Double.NaN, presentMs)
            }, h)
            c.configure(fmt, surface, null, 0)
            c.setVideoScalingMode(MediaCodec.VIDEO_SCALING_MODE_SCALE_TO_FIT)
            c.start()
            codec = c
            VideoCodecStatus.OK
        } catch (e: Exception) {
            Log.w(TAG, "direct decoder init failed", e)
            VideoCodecStatus.FALLBACK_SOFTWARE
        }
    }

    override fun decode(frame: EncodedImage, info: VideoDecoder.DecodeInfo?): VideoCodecStatus {
        val h = handler ?: return VideoCodecStatus.UNINITIALIZED
        if (failed) return VideoCodecStatus.ERROR
        val src = frame.buffer.duplicate()
        val data = ByteArray(src.remaining())
        src.get(data)
        val key = frame.captureTimeNs / 1000
        timing.onInput(key, TimingSei.read(frame.buffer, hevc))
        if (frame.encodedWidth > 0 && frame.encodedHeight > 0) {
            width = frame.encodedWidth
            height = frame.encodedHeight
        }
        val keyframe = frame.frameType == EncodedImage.FrameType.VideoFrameKey
        h.post {
            pending.addLast(Triple(data, key, keyframe))
            feed()
        }
        return VideoCodecStatus.OK
    }

    private fun feed() {
        val c = codec ?: return
        while (freeInputs.isNotEmpty() && pending.isNotEmpty()) {
            val (data, key, keyframe) = pending.removeFirst()
            val index = freeInputs.removeFirst()
            val buf = c.getInputBuffer(index) ?: continue
            buf.clear()
            if (data.size > buf.capacity()) {
                freeInputs.addFirst(index)
                continue
            }
            buf.put(data)
            queuedAt[key] = tvClockMs()
            if (queuedAt.size > 120) queuedAt.remove(queuedAt.keys.first())
            c.queueInputBuffer(index, 0, data.size, key, if (keyframe) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        }
    }

    override fun release(): VideoCodecStatus {
        val h = handler
        val done = CountDownLatch(1)
        if (h == null) return VideoCodecStatus.OK
        h.post {
            try {
                codec?.stop()
            } catch (_: Exception) {
            }
            codec?.release()
            codec = null
            done.countDown()
        }
        done.await(2, TimeUnit.SECONDS)
        thread?.quitSafely()
        handler = null
        return VideoCodecStatus.OK
    }

    override fun getImplementationName(): String = "$name (direct to screen)"
}
