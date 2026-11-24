package dev.klaxon.p0native

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import dev.klaxon.p0session.FixtureStore

/** Available only in the offline x86_64 session fixture. The WebView has no marker API. */
@TauriPlugin
class SessionPlugin(private val host: Activity) : Plugin(host) {
    private val owner = "packaged"

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
                    store.hasRecord(owner) && store.marker(owner, 1).contentEquals(store.read(owner)) -> "authenticated"
                    else -> "unavailable"
                }
                "sign-out" -> {
                    store.forget(owner)
                    if (store.inventory(owner) == "no-key/no-file") "signed-out" else "unavailable"
                }
                else -> "unavailable"
            }
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolveObject(status)
    }
}
