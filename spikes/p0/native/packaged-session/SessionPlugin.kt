package dev.klaxon.p0native

import android.app.Activity
import android.os.Process
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import dev.klaxon.p0session.FixtureStore
import dev.klaxon.p0session.FixtureStore.PublishBoundary
import java.io.File
import java.io.IOException

// JWT-shaped fixture value for the SDK's refresh state machine, with a fake signature.
private const val ROTATED_OWNER_A_ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0." +
    "cDAtbm90LWEtc2lnbmF0dXJl"

/** Available only in the offline x86_64 session fixture. The WebView has no marker API. */
@TauriPlugin
class SessionPlugin(private val host: Activity) : Plugin(host) {
    private enum class RefreshPause(val flag: String, val boundary: PublishBoundary) {
        BEFORE("refresh-pause-before-publish", PublishBoundary.BEFORE_PUBLISH),
        AFTER("refresh-pause-after-publish", PublishBoundary.AFTER_PUBLISH),
    }

    private enum class Owner(val id: String, val generation: Int, val access: String) {
        A("p0-fixture-owner-a", 1, "p0-inert-access-a"),
        B("p0-fixture-owner-b", 2, "p0-inert-access-b"),
    }

    private sealed interface Confirmation {
        data class Granted(val owner: Owner, val access: String) : Confirmation
        data class Denied(val status: String) : Confirmation
    }

    private val slot = "packaged"
    private var activeOwner: Owner? = null

    private external fun decodeRefresh(body: String): Array<String>?

    private fun providerFlag(name: String) = File(host.cacheDir, "p0-$name").isFile

    private fun clearSession(store: FixtureStore): String {
        store.forget(slot)
        return if (store.inventory(slot) == "no-key/no-file") "signed-out" else "unavailable"
    }

    private fun acceptRefresh(store: FixtureStore, owner: Owner, successor: ByteArray, body: String): Confirmation {
        val fields = decodeRefresh(body) ?: return Confirmation.Denied("unavailable")
        if (fields.isEmpty()) return Confirmation.Denied(clearSession(store))
        val (access, refresh, userId) = fields
        val grantedOwner = Owner.entries.firstOrNull { it.id == userId }
        val marker = refresh.toByteArray(Charsets.UTF_8)
        if (grantedOwner == null || grantedOwner != owner || access != ROTATED_OWNER_A_ACCESS ||
            !marker.contentEquals(successor)) return Confirmation.Denied("unavailable")
        store.rotate(slot, marker)
        return Confirmation.Granted(grantedOwner, access)
    }

    private fun confirm(store: FixtureStore, expectedOwner: Owner?): Confirmation {
        if (store.inventory(slot) == "no-key/no-file") return Confirmation.Denied("signed-out")
        if (!store.hasRecord(slot)) return Confirmation.Denied("unavailable")
        val marker = store.read(slot) ?: return Confirmation.Denied("unavailable")
        val successor = store.marker(slot, 3)
        val usesSuccessor = successor.contentEquals(marker)
        val owner = if (usesSuccessor) Owner.A else
            Owner.entries.firstOrNull { store.marker(slot, it.generation).contentEquals(marker) }
                ?: return Confirmation.Denied("unavailable")
        if (expectedOwner != null && owner != expectedOwner) return Confirmation.Denied("unavailable")
        if (providerFlag("provider-offline")) return Confirmation.Denied("retry-required")
        val canRotate = owner == Owner.A && !usesSuccessor
        if (providerFlag("provider-expired") || (canRotate && providerFlag("require-successor"))) {
            return acceptRefresh(store, owner, successor, """{"status":"success","value":{"kind":"noSession"}}""")
        }
        if (canRotate && providerFlag("provider-refresh")) {
            val response = if (providerFlag("provider-refresh-invalid")) {
                """{"status":"error","value":{"kind":"noSession"}}"""
            } else {
                // In-process response for the pinned Convex auth:refreshSession mutation.
                val id = if (providerFlag("provider-refresh-wrong-owner")) Owner.B.id else Owner.A.id
                """{"status":"success","value":{"kind":"rotated","tokens":{
                    "accessToken":"$ROTATED_OWNER_A_ACCESS",
                    "refreshToken":"KLAXON-P0-INERT/packaged/3",
                    "refreshTokenExpiresAt":4102444800000,
                    "userId":"$id"
                }}}"""
            }
            return acceptRefresh(store, owner, successor, response)
        }
        val access = if (usesSuccessor || (owner == Owner.A && expectedOwner != null && providerFlag("provider-rotated"))) {
            ROTATED_OWNER_A_ACCESS
        } else owner.access
        return Confirmation.Granted(owner, access)
    }

    private fun authorize(store: FixtureStore, expectedOwner: Owner? = null): String =
        when (val confirmation = confirm(store, expectedOwner)) {
            is Confirmation.Denied -> confirmation.status
            is Confirmation.Granted -> {
                activeOwner = confirmation.owner
                if (expectedOwner == null) "authenticated" else confirmation.access
            }
        }

    @Command
    @Synchronized
    fun change(invoke: Invoke) {
        activeOwner = null
        val status = try {
            val store = FixtureStore(host)
            when (invoke.getArgs().getString("operation")) {
                "seed" -> {
                    store.seed(slot, Owner.A.generation)
                    "fixture-ready"
                }
                "seed-peer" -> {
                    store.seed(slot, Owner.B.generation)
                    "fixture-ready"
                }
                "resume" -> authorize(store)
                "sign-out" -> clearSession(store)
                else -> "unavailable"
            }
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolveObject(status)
    }

    @Command
    fun sdkAccess(invoke: Invoke) {
        val pause = RefreshPause.entries.firstOrNull { providerFlag(it.flag) }
        if (pause == null) {
            replySdkAccess(invoke)
        } else {
            // Tauri dispatches plugin commands on the UI thread. Keep the WebView observable
            // while the isolated test writer is parked until its process is killed.
            Thread({ replySdkAccess(invoke, pause) }, "p0-refresh-writer").start()
        }
    }

    @Synchronized
    private fun replySdkAccess(invoke: Invoke, pause: RefreshPause? = null) {
        val owner = activeOwner
        activeOwner = null
        val reply = try {
            if (owner == null) "signed-out" else {
                val store = if (pause == null) FixtureStore(host) else FixtureStore(host) { boundary ->
                    if (boundary == pause.boundary) {
                        File(host.cacheDir, "p0-${pause.flag}-reached").writeText(Process.myPid().toString())
                        // Fail closed if the controlling runner disappears before force-stop.
                        Thread.sleep(60_000)
                        throw IOException("Fixture checkpoint timed out")
                    }
                }
                authorize(store, owner)
            }
        } catch (_: Exception) {
            activeOwner = null
            "unavailable"
        }
        invoke.resolveObject(reply)
    }
}
