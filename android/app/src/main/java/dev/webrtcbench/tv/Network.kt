package dev.webrtcbench.tv

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress

private const val TAG = "WebRTCBench"

/**
 * Answers the desktop's UDP broadcast probes ("wrtcb-discover") with a unicast "wrtcb-here".
 * The desktop sends and we reply, so the PC never has to accept inbound UDP through its firewall.
 */
class Discovery(
    private val ctx: Context,
    private val reply: (desktopId: String?) -> JSONObject,
    private val onProbe: (probe: JSONObject, ip: String) -> Unit,
) {
    private var socket: DatagramSocket? = null
    private var lock: WifiManager.MulticastLock? = null

    fun start() {
        try {
            val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            lock = wifi.createMulticastLock("wrtcbench").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "multicast lock unavailable", e)
        }
        val s = DatagramSocket(null).apply {
            reuseAddress = true
            broadcast = true
            bind(InetSocketAddress(Proto.DISCOVERY_PORT))
        }
        socket = s
        Thread({ loop(s) }, "discovery").apply { isDaemon = true }.start()
    }

    private fun loop(s: DatagramSocket) {
        val buf = ByteArray(4096)
        while (!s.isClosed) {
            try {
                val p = DatagramPacket(buf, buf.size)
                s.receive(p)
                val probe = JSONObject(String(p.data, 0, p.length, Charsets.UTF_8))
                if (probe.optString("t") != "wrtcb-discover") continue
                val ip = p.address.hostAddress ?: continue
                onProbe(probe, ip)
                val resp = reply(probe.optString("desktopId").ifEmpty { null })
                    .put("t", "wrtcb-here")
                    .put("v", Proto.VERSION)
                val bytes = resp.toString().toByteArray(Charsets.UTF_8)
                s.send(DatagramPacket(bytes, bytes.size, p.address, p.port))
            } catch (e: Exception) {
                if (s.isClosed) break
                Log.w(TAG, "discovery packet ignored: ${e.message}")
            }
        }
    }

    fun stop() {
        socket?.close()
        socket = null
        try {
            lock?.release()
        } catch (_: Exception) {
        }
    }
}

/** Also advertises the control port over mDNS/DNS-SD for other LAN tools. */
class NsdAdvertiser(ctx: Context) {
    private val nsd = ctx.getSystemService(NsdManager::class.java)
    private var listener: NsdManager.RegistrationListener? = null

    fun start(name: String, port: Int, attrs: Map<String, String>) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = Proto.NSD_TYPE
            this.port = port
            attrs.forEach { (k, v) -> setAttribute(k, v) }
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) = Unit.also { Log.w(TAG, "NSD register failed $e") }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        }
        listener = l
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (e: Exception) {
            Log.w(TAG, "NSD unavailable", e)
        }
    }

    fun stop() {
        listener?.let {
            try {
                nsd.unregisterService(it)
            } catch (_: Exception) {
            }
        }
        listener = null
    }
}

/** WebSocket control channel: pairing, signaling (offer/answer/ICE) and stats all flow over it. */
class ControlServer(port: Int, private val l: Listener) : WebSocketServer(InetSocketAddress(port)) {
    interface Listener {
        fun onOpen(c: WebSocket)
        fun onClose(c: WebSocket)
        fun onText(c: WebSocket, text: String)
    }

    init {
        setReuseAddr(true)
        setConnectionLostTimeout(15)
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) = l.onOpen(conn)
    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) = l.onClose(conn)
    override fun onMessage(conn: WebSocket, message: String) = l.onText(conn, message)
    override fun onError(conn: WebSocket?, ex: Exception) {
        Log.w(TAG, "control socket error", ex)
    }

    override fun onStart() {
        Log.i(TAG, "control server listening on ${address.port}")
    }
}
