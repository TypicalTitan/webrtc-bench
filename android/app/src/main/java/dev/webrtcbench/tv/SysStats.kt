package dev.webrtcbench.tv

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File

/**
 * Per-second device telemetry an unprivileged app can read: this process's CPU share
 * (software decoders run in-process), thermal status and free memory.
 */
class SysStats(ctx: Context) {
    private val clkTck = Os.sysconf(OsConstants._SC_CLK_TCK).toDouble().takeIf { it > 0 } ?: 100.0
    private val cores = Runtime.getRuntime().availableProcessors()
    private val pm = ctx.getSystemService(PowerManager::class.java)
    private val am = ctx.getSystemService(ActivityManager::class.java)
    private val wifi = ctx.applicationContext.getSystemService(WifiManager::class.java)
    private val cm = ctx.getSystemService(ConnectivityManager::class.java)
    private var lastTicks = -1L
    private var lastWall = 0L

    @Synchronized
    fun sample(): JSONObject {
        val j = JSONObject()
        val ticks = readSelfTicks()
        val now = SystemClock.elapsedRealtime()
        if (ticks >= 0 && lastTicks >= 0 && now > lastWall) {
            val cpuSec = (ticks - lastTicks) / clkTck
            val wallSec = (now - lastWall) / 1000.0
            j.put("appCpuPct", 100.0 * cpuSec / wallSec / cores)
        }
        lastTicks = ticks
        lastWall = now
        if (Build.VERSION.SDK_INT >= 29) j.put("thermalStatus", pm.currentThermalStatus)
        if (Build.VERSION.SDK_INT >= 30) {
            val h = pm.getThermalHeadroom(0)
            if (h.isFinite()) j.put("thermalHeadroom", h.toDouble())
        }
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        j.put("availMemMb", mi.availMem / 1_048_576)
        j.put("lowMemory", mi.lowMemory)
        network(j)
        return j
    }

    /** Transport plus Wi-Fi signal and link rate (no SSID: that needs location permission). */
    fun network(j: JSONObject): JSONObject {
        try {
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            val transport = when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                else -> "other"
            }
            j.put("transport", transport)
            if (transport == "wifi") {
                @Suppress("DEPRECATION")
                val wi = wifi.connectionInfo
                if (wi != null) {
                    j.put("wifiRssi", wi.rssi)
                    j.put("wifiLinkMbps", wi.linkSpeed)
                    j.put("wifiFreqMhz", wi.frequency)
                }
            }
        } catch (_: Exception) {
        }
        return j
    }

    private fun readSelfTicks(): Long = try {
        val s = File("/proc/self/stat").readText()
        // Fields after "(comm) " start at field 3, so utime (14) and stime (15) are indexes 11 and 12.
        val rest = s.substring(s.lastIndexOf(')') + 2).split(' ')
        rest[11].toLong() + rest[12].toLong()
    } catch (_: Exception) {
        -1
    }

    companion object {
        fun thermalName(status: Int): String = when (status) {
            0 -> "OK"
            1 -> "light"
            2 -> "moderate"
            3 -> "severe"
            4 -> "critical"
            5 -> "emergency"
            6 -> "shutdown"
            else -> "?"
        }
    }
}
