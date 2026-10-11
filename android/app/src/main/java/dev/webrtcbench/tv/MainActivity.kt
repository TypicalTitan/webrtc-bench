package dev.webrtcbench.tv

import android.app.Activity
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {
    private lateinit var prefs: BenchPrefs
    private lateinit var eglBase: EglBase
    private lateinit var renderer: SurfaceViewRenderer
    private lateinit var sink: CountingSink
    private lateinit var controller: Controller
    private var server: ControlServer? = null
    private var discovery: Discovery? = null
    private val nsd by lazy { NsdAdvertiser(this) }
    private val main = Handler(Looper.getMainLooper())

    private lateinit var idlePanel: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var addrText: TextView
    private lateinit var desktopsText: TextView
    private lateinit var pairedText: TextView
    private lateinit var overlayText: TextView
    private lateinit var pinPanel: View
    private lateinit var pinTitle: TextView
    private lateinit var pinText: TextView
    private lateinit var nativeVideo: SurfaceView
    @Volatile private var nativeSurface: Surface? = null
    @Volatile private var nativeSurfaceReady: CountDownLatch? = null

    @Volatile var displayInfo: JSONObject = JSONObject()
        private set
    @Volatile private var runActive = false
    @Volatile private var showOverlay = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        renderer = findViewById(R.id.video)
        idlePanel = findViewById(R.id.idlePanel)
        statusText = findViewById(R.id.statusText)
        addrText = findViewById(R.id.addrText)
        desktopsText = findViewById(R.id.desktopsText)
        pairedText = findViewById(R.id.pairedText)
        overlayText = findViewById(R.id.overlayText)
        pinPanel = findViewById(R.id.pinPanel)
        pinTitle = findViewById(R.id.pinTitle)
        pinText = findViewById(R.id.pinText)
        nativeVideo = findViewById(R.id.nativeVideo)
        nativeVideo.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {}
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                nativeSurface = holder.surface
                nativeSurfaceReady?.countDown()
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                nativeSurface = null
            }
        })

        prefs = BenchPrefs(this)
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
        )
        eglBase = EglBase.create()
        renderer.init(eglBase.eglBaseContext, null)
        renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        renderer.setEnableHardwareScaler(true)
        sink = CountingSink(renderer)
        displayInfo = DeviceInfo.display(this)

        controller = Controller(this, prefs, eglBase, sink)
        server = ControlServer(Proto.WS_PORT, controller).also { it.start() }
        discovery = Discovery(this, { id -> controller.discoveryReply(id) }, { p, ip -> controller.onProbe(p, ip) })
            .also { it.start() }
        nsd.start(
            "WebRTC Bench (${DeviceInfo.name(this)})", Proto.WS_PORT,
            mapOf("id" to prefs.tvId, "model" to Build.MODEL, "v" to Proto.VERSION.toString())
        )

        findViewById<Button>(R.id.forgetButton).apply {
            setOnClickListener {
                prefs.clearPaired()
                controller.onPairingsCleared()
                setStatus("Forgot all paired desktops")
                refreshIdle()
            }
            requestFocus()
        }
        main.post(idleTicker)
    }

    private val idleTicker = object : Runnable {
        override fun run() {
            refreshIdle()
            main.postDelayed(this, 2000)
        }
    }

    fun refreshIdle() = runOnUiThread {
        val ip = DeviceInfo.ipv4(this) ?: "no network"
        addrText.text = "${DeviceInfo.name(this)}  ·  ${Build.MODEL}  ·  $ip:${Proto.WS_PORT}"
        val now = System.currentTimeMillis()
        val seen = controller.desktopsSeen.values
            .filter { it.connected || now - it.lastSeen < 30_000 }
            .sortedBy { it.name }
        desktopsText.text = if (seen.isEmpty()) "None yet. Open WebRTC Bench on a PC on this network."
        else seen.joinToString("\n") {
            val state = if (it.connected) "connected" else "seen ${(now - it.lastSeen) / 1000}s ago"
            "${it.name}  ·  ${it.ip}  ·  $state"
        }
        val paired = prefs.pairedDesktops()
        pairedText.text = if (paired.isEmpty()) "None" else paired.joinToString("\n") { it.name }
    }

    fun setStatus(text: String) = runOnUiThread { statusText.text = text }

    fun showPin(desktopName: String, pin: String) = runOnUiThread {
        pinTitle.text = "Pair with $desktopName?"
        pinText.text = pin.chunked(3).joinToString(" ")
        pinPanel.visibility = View.VISIBLE
        pinPanel.bringToFront()
    }

    fun hidePin() = runOnUiThread { pinPanel.visibility = View.GONE }

    fun runBegin(desktopName: String, total: Int, video: String) = runOnUiThread {
        runActive = true
        idlePanel.visibility = View.GONE
        overlayText.visibility = View.VISIBLE
        overlayText.text = "Benchmark from $desktopName · $total tests · $video\nStarting…"
    }

    fun runEnd(message: String) = runOnUiThread {
        runActive = false
        setMinimalPostProcessing(false)
        renderer.clearImage()
        overlayText.visibility = View.GONE
        idlePanel.visibility = View.VISIBLE
        setStatus(message)
        refreshIdle()
    }

    fun enterTest(spec: TestSpec) {
        // Set before the first frame arrives (the session starts after this returns).
        sink.forward = spec.render != "none"
        runOnUiThread {
            renderer.setEnableHardwareScaler(spec.render == "native")
            if (spec.render == "none") renderer.clearImage()
            // Decode-only shows nothing, so keep the stats visible regardless of the setting.
            showOverlay = spec.showOverlay || spec.render == "none"
            idlePanel.visibility = View.GONE
            overlayText.visibility = if (showOverlay) View.VISIBLE else View.GONE
            overlayText.text = "Test ${spec.index}/${spec.total} · ${spec.label}\nconnecting…"
        }
    }

    /**
     * Shows the native video surface (sized to the stream for full-res output, or to the view)
     * and blocks until it exists. Called off the UI thread.
     */
    fun prepareNativeSurface(spec: TestSpec): Surface? {
        val latch = CountDownLatch(1)
        nativeSurfaceReady = latch
        runOnUiThread {
            // Ask the TV for its game / low-latency picture mode (HDMI ALLM or content type
            // "game"): panel processing is usually the largest delay after the HDMI output.
            if (parseOpts(spec.opts)["allm"] != "0") setMinimalPostProcessing(true)
            renderer.visibility = View.GONE
            if (spec.render == "native") nativeVideo.holder.setFixedSize(spec.width, spec.height)
            else nativeVideo.holder.setSizeFromLayout()
            nativeVideo.visibility = View.VISIBLE
        }
        latch.await(3, TimeUnit.SECONDS)
        nativeSurfaceReady = null
        return nativeSurface
    }

    fun releaseNativeSurface() = runOnUiThread {
        nativeVideo.visibility = View.GONE
        renderer.visibility = View.VISIBLE
    }

    /** Kept on for the whole run (cleared in runEnd) so the TV does not switch modes between tests. */
    private fun setMinimalPostProcessing(on: Boolean) {
        if (Build.VERSION.SDK_INT < 30) return
        val lp = window.attributes
        if (lp.preferMinimalPostProcessing == on) return
        lp.preferMinimalPostProcessing = on
        window.attributes = lp
    }

    /** Refresh period of the display this activity is on, in ms. */
    fun vsyncPeriodMs(): Double {
        val hz = (if (Build.VERSION.SDK_INT >= 30) display?.refreshRate else null)
            ?: @Suppress("DEPRECATION") windowManager.defaultDisplay.refreshRate
        return 1000.0 / (if (hz > 1f) hz else 60f)
    }

    fun setOverlay(text: String) = runOnUiThread {
        if (showOverlay) overlayText.text = text
    }

    fun exitTest() = runOnUiThread {
        renderer.clearImage()
        if (runActive) {
            overlayText.visibility = View.VISIBLE
            overlayText.text = "Preparing next test…"
        } else {
            overlayText.visibility = View.GONE
            idlePanel.visibility = View.VISIBLE
        }
    }

    // Without this, Wi-Fi power save batches packets at low bitrates and causes stalls that
    // look like decoder problems. Streaming receivers hold it while in the foreground.
    private var wifiLock: WifiManager.WifiLock? = null

    /** Tests need the app on screen: Android gives background apps no video surface. */
    @Volatile var inForeground = false
        private set

    override fun onResume() {
        super.onResume()
        inForeground = true
        if (wifiLock?.isHeld != true) {
            val wm = applicationContext.getSystemService(WifiManager::class.java)
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "wrtcbench:low-latency").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    override fun onPause() {
        inForeground = false
        wifiLock?.takeIf { it.isHeld }?.release()
        super.onPause()
    }

    // ---- Screen latency probe: Android asks the person at the TV to allow screen capture ----
    private var probeDone: ((String?) -> Unit)? = null

    fun requestScreenProbe(done: (String?) -> Unit) = runOnUiThread {
        if (ScreenProbeService.running) {
            done(null)
            return@runOnUiThread
        }
        probeDone = done
        val mpm = getSystemService(android.media.projection.MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN_PROBE)
    }

    fun stopScreenProbe() = ScreenProbe.stop(this)

    @Deprecated("Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        if (requestCode != REQ_SCREEN_PROBE) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val done = probeDone ?: return
        probeDone = null
        if (resultCode != RESULT_OK || data == null) {
            done("screen capture was not allowed on the TV")
            return
        }
        ScreenProbe.start(this, resultCode, data)
        main.postDelayed({ done(if (ScreenProbeService.running) null else ScreenProbeService.lastError ?: "screen probe did not start") }, 1500)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && pinPanel.visibility == View.VISIBLE) {
            controller.cancelPairingFromTv()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        nsd.stop()
        discovery?.stop()
        try {
            server?.stop(500)
        } catch (_: Exception) {
        }
        controller.shutdown()
        renderer.release()
        eglBase.release()
        super.onDestroy()
    }

    companion object {
        private const val REQ_SCREEN_PROBE = 7001
    }
}
