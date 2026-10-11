package dev.webrtcbench.tv

import org.json.JSONObject
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

internal fun posMod(x: Double, m: Double): Double = ((x % m) + m) % m

/** Wraps into (-m/2, m/2]. */
internal fun wrap(x: Double, m: Double): Double {
    val r = posMod(x, m)
    return if (r > m / 2) r - m else r
}

/**
 * Vsync-locked pacing. The compositor latches new buffers at a fixed point before each vsync and
 * shows them a fixed time later, so a frame decoded just after a latch waits a whole refresh
 * longer than one decoded just before it, and two frames decoded between the same two latches
 * cost a dropped frame plus a repeated one. The pacer finds the latch and asks the PC to move its
 * frame clock ([shift]: WBPH to wbsend.exe, or "pace-shift" to the desktop app's WebRTC source)
 * so frames finish decoding a small margin before it:
 *
 *  1. collect: shown-at times must sit on a vsync grid. Some devices (Fire OS 8) report the time
 *     a frame was handed to the compositor instead; then neither on-screen latency nor pacing is
 *     available. This check runs whether or not pacing is enabled ([active] = frames are shown);
 *  2. sweep: delay the PC by 0.5 ms per frame across one refresh; the shortest decode -> shown
 *     time seen is the latch lead L (frames must be ready L ms before the vsync that shows them);
 *  3. lock: every `window` frames, shift so that only ~2% of frames have less than `marginMs`
 *     slack before their latch (late frames count as negative slack).
 *
 * Not thread-safe: call from one thread (the decoder's callback thread).
 */
class VsyncPacer(
    active: Boolean,
    val enabled: Boolean,
    private val periodMs: Double,
    private val marginMs: Double,
    private val window: Int,
    private val shift: (Double) -> Boolean,
) {
    var state = if (active) "collect" else "off"
    var note = ""
    /** Null until checked: whether this device's shown-at times are real display times. */
    var timingValid: Boolean? = null
        private set
    private var sumSin = 0.0
    private var sumCos = 0.0
    private var nGrid = 0
    private var gridMs = Double.NaN // vsync phase on our clock (ms mod period)
    var leadMs = Double.NaN
        private set
    private var minU = Double.POSITIVE_INFINITY
    private var swept = 0.0
    private var settle = 0
    private var first = true
    private val slack = DoubleArray(window)
    private var nSlack = 0
    var shiftTotalMs = 0.0
        private set
    var slackLowMs = Double.NaN
        private set
    var slackMedMs = Double.NaN
        private set

    fun onPresented(decodedMs: Double, presentMs: Double) {
        if (state == "off" || state == "unavailable") return
        val phase = posMod(presentMs, periodMs)
        if (state == "collect") {
            val a = 2 * PI * phase / periodMs
            sumSin += sin(a)
            sumCos += cos(a)
            if (++nGrid < 30) return
            val r = hypot(sumSin, sumCos) / nGrid
            timingValid = r >= 0.9
            if (!timingValid!!) {
                state = "unavailable"
                note = String.format(Locale.US, "this TV does not report when frames reach the screen (R=%.2f)", r)
                return
            }
            gridMs = posMod(atan2(sumSin, sumCos) * periodMs / (2 * PI), periodMs)
            state = if (enabled) "sweep" else "off"
            return
        }
        gridMs = posMod(gridMs + 0.05 * wrap(phase - gridMs, periodMs), periodMs)
        if (!decodedMs.isNaN()) minU = min(minU, presentMs - decodedMs)
    }

    fun onDecoded(t: Double) {
        when (state) {
            "sweep" -> if (swept < periodMs + 1.0) {
                request(SWEEP_STEP_MS)
                swept += SWEEP_STEP_MS
            } else {
                state = "measure"
                settle = 20 // frames still in the pipeline report their shown-at times
            }
            "measure" -> if (--settle <= 0) {
                leadMs = minU
                state = "locked"
                settle = 0
            }
            "locked" -> {
                if (settle > 0) {
                    settle--
                    return
                }
                slack[nSlack++] = posMod(gridMs - leadMs - t, periodMs)
                if (nSlack == window) adjust()
            }
        }
    }

    private fun adjust() {
        // Slack is circular (a frame just past a latch has almost a full refresh of "slack" for
        // the next one), so unwrap around the window's circular mean rather than around the
        // target: a wide spread must not turn early frames into late ones.
        var sx = 0.0
        var cx = 0.0
        for (i in 0 until nSlack) {
            val a = 2 * PI * slack[i] / periodMs
            sx += sin(a)
            cx += cos(a)
        }
        val center = posMod(atan2(sx, cx) * periodMs / (2 * PI), periodMs)
        val x = DoubleArray(nSlack) { center + wrap(slack[it] - center, periodMs) }
        nSlack = 0
        x.sort()
        slackLowMs = x[(x.size * 0.02).toInt()]
        slackMedMs = x[x.size / 2]
        // Positive error: even the latest frames have spare time, so send later.
        val err = slackLowMs - marginMs
        val s = if (first) wrap(err, periodMs) else (0.5 * err).coerceIn(-2.0, 2.0)
        first = false
        if (abs(s) >= 0.1) {
            request(s)
            settle = 6 // wait for frames sent on the new clock
        }
    }

    private fun request(ms: Double) {
        if (shift(ms)) shiftTotalMs += ms
    }

    fun toJson(): JSONObject = JSONObject().put("state", state).put("note", note)
        .put("leadMs", leadMs.takeIf { it.isFinite() } ?: JSONObject.NULL)
        .put("slackLowMs", slackLowMs.takeIf { it.isFinite() } ?: JSONObject.NULL)
        .put("slackMedMs", slackMedMs.takeIf { it.isFinite() } ?: JSONObject.NULL)
        .put("shiftMs", shiftTotalMs).put("marginMs", marginMs)

    companion object {
        private const val SWEEP_STEP_MS = 0.5
    }
}
