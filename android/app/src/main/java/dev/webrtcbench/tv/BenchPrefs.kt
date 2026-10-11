package dev.webrtcbench.tv

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** Persistent TV identity and the desktops that completed PIN pairing. */
class BenchPrefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("bench", Context.MODE_PRIVATE)

    val tvId: String = sp.getString("tvId", null)
        ?: UUID.randomUUID().toString().also { sp.edit().putString("tvId", it).apply() }

    data class PairedDesktop(val id: String, val name: String, val tokenHash: String, val pairedAt: Long)

    @Synchronized
    fun pairedDesktops(): List<PairedDesktop> {
        val obj = JSONObject(sp.getString("paired", "{}")!!)
        return obj.keys().asSequence().map { id ->
            val o = obj.getJSONObject(id)
            PairedDesktop(id, o.optString("name"), o.optString("tokenHash"), o.optLong("pairedAt"))
        }.sortedBy { it.pairedAt }.toList()
    }

    fun isKnown(desktopId: String?): Boolean =
        desktopId != null && pairedDesktops().any { it.id == desktopId }

    fun isPaired(desktopId: String?, token: String?): Boolean {
        if (desktopId == null || token.isNullOrEmpty()) return false
        val p = pairedDesktops().firstOrNull { it.id == desktopId } ?: return false
        return MessageDigest.isEqual(p.tokenHash.toByteArray(), sha256(token).toByteArray())
    }

    /** Stores the desktop and returns the new bearer token it must present on reconnect. */
    @Synchronized
    fun addPaired(desktopId: String, name: String): String {
        val token = randomHex(32)
        val obj = JSONObject(sp.getString("paired", "{}")!!)
        obj.put(desktopId, JSONObject().apply {
            put("name", name)
            put("tokenHash", sha256(token))
            put("pairedAt", System.currentTimeMillis())
        })
        sp.edit().putString("paired", obj.toString()).apply()
        return token
    }

    @Synchronized
    fun removePaired(desktopId: String) {
        val obj = JSONObject(sp.getString("paired", "{}")!!)
        obj.remove(desktopId)
        sp.edit().putString("paired", obj.toString()).apply()
    }

    @Synchronized
    fun clearPaired() {
        sp.edit().putString("paired", "{}").apply()
    }

    companion object {
        private val rng = SecureRandom()

        fun sha256(s: String): String =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

        fun randomHex(bytes: Int): String {
            val b = ByteArray(bytes)
            rng.nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }

        fun randomPin(): String = (0 until 6).map { rng.nextInt(10) }.joinToString("")
    }
}
