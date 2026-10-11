package dev.webrtcbench.tv

import android.app.Activity
import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.net.ConnectivityManager
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.VideoDecoderFactory
import java.net.Inet4Address
import java.net.NetworkInterface

/** Static facts about this TV that the desktop records in its report. */
object DeviceInfo {

    fun name(ctx: Context): String =
        Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: Build.MODEL

    fun ipv4(ctx: Context): String? {
        try {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val lp = cm.getLinkProperties(cm.activeNetwork)
            lp?.linkAddresses?.map { it.address }
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
                ?.let { return it.hostAddress }
        } catch (_: Exception) {
        }
        return try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { it is Inet4Address }?.hostAddress
        } catch (_: Exception) {
            null
        }
    }

    fun basic(ctx: Context, prefs: BenchPrefs): JSONObject = JSONObject().apply {
        put("id", prefs.tvId)
        put("name", name(ctx))
        put("model", Build.MODEL)
        put("manufacturer", Build.MANUFACTURER)
        put("device", Build.DEVICE)
        put("android", Build.VERSION.RELEASE)
        put("sdk", Build.VERSION.SDK_INT)
        put("build", Build.ID)
        put("securityPatch", Build.VERSION.SECURITY_PATCH)
        if (Build.VERSION.SDK_INT >= 31) put("soc", "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}")
        put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        put("cpuCores", Runtime.getRuntime().availableProcessors())
        put("ip", ipv4(ctx))
        put("wsPort", Proto.WS_PORT)
        put("appVersion", Proto.APP_VERSION)
        put("protocol", Proto.VERSION)
    }

    fun display(a: Activity): JSONObject {
        val o = JSONObject()
        val d = (if (Build.VERSION.SDK_INT >= 30) a.display else null)
            ?: @Suppress("DEPRECATION") a.windowManager.defaultDisplay
            ?: return o
        val m = d.mode
        o.put("width", m.physicalWidth)
        o.put("height", m.physicalHeight)
        o.put("refreshRate", m.refreshRate.toDouble())
        o.put("modes", JSONArray(d.supportedModes.map {
            "${it.physicalWidth}x${it.physicalHeight}@${"%.2f".format(it.refreshRate)}"
        }.distinct()))
        try {
            @Suppress("DEPRECATION")
            val types = d.hdrCapabilities?.supportedHdrTypes ?: intArrayOf()
            o.put("hdr", JSONArray(types.map { hdrName(it) }))
        } catch (_: Exception) {
        }
        return o
    }

    private fun hdrName(t: Int) = when (t) {
        1 -> "Dolby Vision"
        2 -> "HDR10"
        3 -> "HLG"
        4 -> "HDR10+"
        else -> "type$t"
    }

    /** Every MediaCodec video decoder with its declared limits for the sizes the bench tests. */
    fun decoders(): JSONArray {
        val arr = JSONArray()
        val sizes = listOf(1280 to 720, 1920 to 1080, 2560 to 1440, 3840 to 2160)
        for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
            if (info.isEncoder || info.name.endsWith(".secure")) continue
            if (Build.VERSION.SDK_INT >= 29 && info.isAlias) continue
            for (type in info.supportedTypes) {
                if (!type.startsWith("video/")) continue
                val caps = try {
                    info.getCapabilitiesForType(type)
                } catch (_: Exception) {
                    continue
                }
                val vc = caps.videoCapabilities ?: continue
                val o = JSONObject()
                o.put("name", info.name)
                o.put("type", type)
                if (Build.VERSION.SDK_INT >= 29) {
                    o.put("hardware", info.isHardwareAccelerated)
                    o.put("softwareOnly", info.isSoftwareOnly)
                }
                o.put("maxInstances", caps.maxSupportedInstances)
                o.put("maxWidth", vc.supportedWidths.upper)
                o.put("maxHeight", vc.supportedHeights.upper)
                if (Build.VERSION.SDK_INT >= 30) {
                    o.put("lowLatency", caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency))
                }
                val perSize = JSONObject()
                for ((w, h) in sizes) {
                    val s = JSONObject()
                    s.put("supported", vc.isSizeSupported(w, h))
                    s.put("30", vc.areSizeAndRateSupported(w, h, 30.0))
                    s.put("60", vc.areSizeAndRateSupported(w, h, 60.0))
                    try {
                        vc.getAchievableFrameRatesFor(w, h)?.let { s.put("achievable", "${it.lower.toInt()}-${it.upper.toInt()}") }
                    } catch (_: Exception) {
                    }
                    perSize.put("${w}x$h", s)
                }
                o.put("sizes", perSize)
                if (Build.VERSION.SDK_INT >= 29) {
                    vc.supportedPerformancePoints?.let { pts -> o.put("performancePoints", JSONArray(pts.map { it.toString() })) }
                }
                arr.put(o)
            }
        }
        return arr
    }

    fun factoryCodecs(f: VideoDecoderFactory): JSONArray = JSONArray().apply {
        for (c in f.supportedCodecs) {
            put(JSONObject().put("name", c.name).put("params", JSONObject(c.params as Map<*, *>)))
        }
    }
}
