package dev.klaxon.p0native

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import dev.klaxon.p0session.FixtureStore
import java.io.File

/** Available only in the offline x86_64 session fixture. The WebView has no marker API. */
@TauriPlugin
class SessionPlugin(private val host: Activity) : Plugin(host) {
    private enum class Owner(val generation: Int, val access: String) {
        A(1, "p0-inert-access-a"),
        B(2, "p0-inert-access-b"),
    }

    private val slot = "packaged"
    private var activeOwner: Owner? = null

    private fun clearSession(store: FixtureStore): String {
        store.forget(slot)
        return if (store.inventory(slot) == "no-key/no-file") "signed-out" else "unavailable"
    }

    private fun confirm(store: FixtureStore, expectedOwner: Owner? = null): String {
        if (store.inventory(slot) == "no-key/no-file") return "signed-out"
        if (!store.hasRecord(slot)) return "unavailable"
        val marker = store.read(slot) ?: return "unavailable"
        // The local provider recognizes only these two authenticated marker generations.
        val owner = Owner.entries.firstOrNull { store.marker(slot, it.generation).contentEquals(marker) }
            ?: return "unavailable"
        if (expectedOwner != null && owner != expectedOwner) return "unavailable"
        if (File(host.cacheDir, "p0-provider-offline").isFile) return "retry-required"
        if (File(host.cacheDir, "p0-provider-expired").isFile) return clearSession(store)
        activeOwner = owner
        return "authenticated"
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
                "resume" -> confirm(store)
                "sign-out" -> clearSession(store)
                else -> "unavailable"
            }
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolveObject(status)
    }

    @Command
    @Synchronized
    fun sdkAccess(invoke: Invoke) {
        val owner = activeOwner
        activeOwner = null
        val reply = try {
            if (owner == null) {
                "signed-out"
            } else {
                val status = confirm(FixtureStore(host), owner)
                if (status == "authenticated") owner.access else status
            }
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolveObject(reply)
    }
}
