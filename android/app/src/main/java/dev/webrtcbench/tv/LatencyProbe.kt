package dev.webrtcbench.tv

import android.os.SystemClock
import org.webrtc.VideoFrame
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/** Monotonic milliseconds; the PC maps this clock onto its own with ping/pong. */
fun tvClockMs(): Double = SystemClock.elapsedRealtimeNanos() / 1e6

/**
 * Reads the 16-bit frame code the PC burns into the bottom-right corner of every frame:
 * row A holds the bits, row B the same bits inverted (a cheap integrity check against
 * compression smear). Pairs of (frame code, time the decoded frame reached us) let the PC
 * compute capture-to-decoded latency per frame.
 *
 * Geometry must match desktop/src/source.js (_overlay).
 */
class LatencyProbe(private val every: Int = 5) {
    private val samples = ArrayList<DoubleArray>()

    fun onFrame(frame: VideoFrame, count: Long) {
        if (count % every != 0L) return
        val t = tvClockMs()
        val code = readCode(frame.buffer) ?: return
        synchronized(samples) { samples.add(doubleArrayOf(code.toDouble(), t)) }
    }

    fun drain(): List<DoubleArray> = synchronized(samples) {
        val out = ArrayList(samples)
        samples.clear()
        out
    }

    private fun readCode(buffer: VideoFrame.Buffer): Int? {
        val w = buffer.width
        val h = buffer.height
        val s = h / 1080.0
        val pad = (20 * s).roundToInt()
        val bs = max(12, (16 * s).roundToInt())
        val x0 = w - pad - 16 * bs
        val y0 = h - pad - 2 * bs
        if (x0 < 0 || y0 < 0) return null
        val crop = buffer.cropAndScale(x0, y0, 16 * bs, 2 * bs, 16 * bs, 2 * bs)
        val i420 = try {
            crop.toI420()
        } finally {
            crop.release()
        } ?: return null
        try {
            val y = i420.dataY
            val stride = i420.strideY
            var code = 0
            for (i in 0 until 16) {
                val cx = i * bs + bs / 2
                val a = y.get((bs / 2) * stride + cx).toInt() and 0xff
                val b = y.get((bs + bs / 2) * stride + cx).toInt() and 0xff
                if (abs(a - b) < 80) return null // smeared or not our pattern
                if (a > b) code = code or (1 shl (15 - i))
            }
            return code
        } finally {
            i420.release()
        }
    }
}
