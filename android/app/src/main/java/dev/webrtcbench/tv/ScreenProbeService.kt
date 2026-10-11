package dev.webrtcbench.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import kotlin.math.abs

private const val TAG = "WebRTCBench"

/**
 * Measures what is actually on the TV's screen, whichever app shows it (Miracast, Cast, our own
 * WebRTC receiver): screen capture (MediaProjection) into a small mirror of the display, reading
 * the frame number from the PC's test pattern (desktop/src/pattern.html). Each captured image
 * carries the time the compositor produced it, so (frame number, TV ms) pairs give PC screen ->
 * TV screen latency with the same method for every technology.
 *
 * Pattern geometry (fractions of the screen): a band from 40% to 60% of the height, 16 columns;
 * the top row holds the 16 bits of the frame number (white = 1), the bottom row the inverse.
 */
class ScreenProbeService : Service() {
    companion object {
        const val EXTRA_RESULT = "result"
        const val EXTRA_DATA = "data"
        private const val W = 960
        private const val H = 540
        /** Receives (frame code, TV clock ms, image width) for every readable captured frame. */
        @Volatile var listener: ((Int, Double) -> Unit)? = null
        @Volatile var running = false
            private set
        @Volatile var lastError: String? = null
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel("probe", "Screen latency probe", NotificationManager.IMPORTANCE_LOW))
        val notification = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "probe") else @Suppress("DEPRECATION") Notification.Builder(this))
            .setContentTitle("WebRTC Bench is timing the screen")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(1, notification)

        val result = intent?.getIntExtra(EXTRA_RESULT, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        else @Suppress("DEPRECATION") intent?.getParcelableExtra(EXTRA_DATA)
        try {
            start(result, data ?: throw IllegalStateException("no screen-capture permission"))
            running = true
            lastError = null
        } catch (e: Exception) {
            Log.w(TAG, "screen probe failed", e)
            lastError = e.message ?: e.toString()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun start(result: Int, data: Intent) {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(result, data) ?: throw IllegalStateException("screen capture refused")
        projection = p
        val t = HandlerThread("screen-probe").apply { start() }
        thread = t
        val h = Handler(t.looper)
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                running = false
            }
        }, h)
        val r = ImageReader.newInstance(W, H, PixelFormat.RGBA_8888, 3)
        reader = r
        r.setOnImageAvailableListener({ ir ->
            val img = try {
                ir.acquireLatestImage()
            } catch (_: Exception) {
                null
            } ?: return@setOnImageAvailableListener
            try {
                val tvMs = (img.timestamp + (SystemClock.elapsedRealtimeNanos() - System.nanoTime())) / 1e6
                val plane = img.planes[0]
                val buf = plane.buffer
                val rs = plane.rowStride
                val ps = plane.pixelStride
                fun luma(x: Int, y: Int): Int {
                    val o = y * rs + x * ps
                    return ((buf.get(o).toInt() and 0xff) + (buf.get(o + 1).toInt() and 0xff) + (buf.get(o + 2).toInt() and 0xff)) / 3
                }
                var code = 0
                var ok = true
                for (i in 0 until 16) {
                    val x = ((i + 0.5) * img.width / 16).toInt()
                    val a = luma(x, (img.height * 0.45).toInt())
                    val b = luma(x, (img.height * 0.55).toInt())
                    if (abs(a - b) < 80) {
                        ok = false
                        break
                    }
                    if (a > b) code = code or (1 shl (15 - i))
                }
                if (ok) listener?.invoke(code, tvMs)
            } finally {
                img.close()
            }
        }, h)
        val dpi = resources.displayMetrics.densityDpi
        display = p.createVirtualDisplay(
            "wrtcbench-probe", W, H, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, h,
        )
    }

    override fun onDestroy() {
        running = false
        display?.release()
        reader?.close()
        projection?.stop()
        thread?.quitSafely()
        display = null
        reader = null
        projection = null
        super.onDestroy()
    }
}

/** Starts / stops the probe from an activity (the screen-capture consent needs one). */
object ScreenProbe {
    fun start(ctx: Context, result: Int, data: Intent) {
        val i = Intent(ctx, ScreenProbeService::class.java).putExtra(ScreenProbeService.EXTRA_RESULT, result).putExtra(ScreenProbeService.EXTRA_DATA, data)
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }

    fun stop(ctx: Context) {
        ctx.stopService(Intent(ctx, ScreenProbeService::class.java))
    }
}
