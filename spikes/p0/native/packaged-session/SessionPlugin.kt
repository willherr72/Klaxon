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
    private val owner = "packaged"

    private fun clearSession(store: FixtureStore): String {
        store.forget(owner)
        return if (store.inventory(owner) == "no-key/no-file") "signed-out" else "unavailable"
    }

    @Command
    @Synchronized
    fun change(invoke: Invoke) {
        val status = try {
            val store = FixtureStore(host)
            when (invoke.getArgs().getString("operation")) {
                "seed" -> {
                    store.seed(owner)
                    "fixture-ready"
                }
                "resume" -> when {
                    store.inventory(owner) == "no-key/no-file" -> "signed-out"
                    // Simulated provider accepts only the native fixture's known generation.
                    store.hasRecord(owner) && store.marker(owner, 1).contentEquals(store.read(owner)) -> when {
                        File(host.cacheDir, "p0-provider-offline").isFile -> "retry-required"
                        File(host.cacheDir, "p0-provider-expired").isFile -> clearSession(store)
                        else -> "authenticated"
                    }
                    else -> "unavailable"
                }
                "sign-out" -> clearSession(store)
                else -> "unavailable"
            }
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolveObject(status)
    }
}
