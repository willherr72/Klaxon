package com.klaxon.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Isolated characterization of the real Android/native lifecycle. Seed the
 * disposable emulator with SyncLifecycleTest first, then run one phase per
 * instrumentation process with waitForActivitiesToComplete=false.
 *
 * A triggered marker without completed is NOT a passing test. For finish it
 * identifies an intentional destruction probe whose exit must be classified
 * by the host using logcat/exit-info; Back and recreation require completion.
 */
@RunWith(AndroidJUnit4::class)
class NativeLifecycleTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val arguments = InstrumentationRegistry.getArguments()
    private val events = JSONArray()
    private lateinit var phase: String

    private fun marker(status: String) {
        val event = JSONObject().apply {
            put("status", status)
            put("elapsed_ms", SystemClock.elapsedRealtime())
        }
        events.put(event)
        val result = JSONObject().apply {
            put("phase", phase)
            put("status", status)
            put("pid", Process.myPid())
            put("events", events)
        }
        // finish() can kill this process before instrumentation reports a result.
        // AtomicFile.finishWrite flushes the marker before the lifecycle trigger.
        val file = AtomicFile(File(context.filesDir, "ci-native-lifecycle-$phase.json"))
        val stream = file.startWrite()
        try {
            stream.write(result.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Throwable) {
            file.failWrite(stream)
            throw error
        }
        val message = "KLAXON_NATIVE_LIFECYCLE $result"
        Log.i("KlaxonLifecycleProbe", message)
        println(message)
        instrumentation.sendStatus(2, Bundle().apply { putString("lifecycle_probe", result.toString()) })
    }

    private fun await(description: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        throw AssertionError("Timed out: $description")
    }

    private fun resumedActivity(): MainActivity? {
        var activity: MainActivity? = null
        instrumentation.runOnMainSync {
            activity = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().singleOrNull()
        }
        return activity
    }

    private fun launch(): MainActivity {
        // API 31+ Back backgrounds a root LAUNCHER Activity. A component-only
        // intent would not reproduce the same launch contract as the app icon.
        context.startActivity(Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            setClass(context, MainActivity::class.java)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        })
        await("MainActivity resumed") { resumedActivity() != null }
        return requireNotNull(resumedActivity())
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    private fun evaluate(activity: Activity, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            val webview = findWebView(activity.window.decorView)
            if (webview == null) {
                latch.countDown()
            } else {
                webview.evaluateJavascript(script) {
                    result = it
                    latch.countDown()
                }
            }
        }
        assertTrue("WebView JavaScript callback timed out", latch.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun snapshot(activity: MainActivity): JSONObject {
        await("rendered frontend and Tauri IPC") {
            evaluate(activity, "Boolean(document.getElementById('app')?.children.length && window.__TAURI_INTERNALS__?.invoke)") == "true"
        }
        // Only public, non-secret fields cross back into diagnostics. The real
        // Rust commands must finish; evaluating JavaScript alone is insufficient.
        evaluate(activity, """
            (() => {
              window.__klaxonLifecycleProbe = {status: 'pending'};
              Promise.all([
                window.__TAURI_INTERNALS__.invoke('device_identity'),
                window.__TAURI_INTERNALS__.invoke('list_reminders')
              ]).then(([identity, reminders]) => {
                const task = reminders.find(item => item.id === 'ci-preserved');
                window.__klaxonLifecycleProbe = {
                  status: 'ok', device_id: identity.device_id,
                  sync_enabled: identity.sync_enabled,
                  title: task?.title ?? null
                };
              }).catch(() => { window.__klaxonLifecycleProbe = {status: 'invoke_failed'}; });
              return true;
            })()
        """.trimIndent())
        var result: JSONObject? = null
        await("native identity and persisted reminder response") {
            val value = evaluate(activity, "window.__klaxonLifecycleProbe")
            if (value != null && value != "null") {
                val parsed = JSONObject(value)
                assertNotEquals("Production Tauri invocation failed", "invoke_failed", parsed.optString("status"))
                if (parsed.optString("status") == "ok") result = parsed
            }
            result != null
        }
        return requireNotNull(result).also {
            assertTrue("Device identity missing", it.getString("device_id").isNotBlank())
            val identityFile = File(context.filesDir, "ci-identity.json")
            assertTrue("Run the identity seed phase before lifecycle probes", identityFile.isFile)
            val expectedDeviceId = JSONObject(identityFile.readText()).getString("device_id")
            assertEquals("Persisted device identity changed", expectedDeviceId, it.getString("device_id"))
            assertTrue("Seeded sync preference lost", it.getBoolean("sync_enabled"))
            assertEquals("Persisted fixture lost", "Synthetic upgrade sentinel", it.getString("title"))
        }
    }

    @Test
    fun lifecycleProbe() {
        assertEquals("Emulator guard is required", "true", arguments.getString("disposable_emulator"))
        assertTrue("Physical devices are forbidden", android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.MODEL.contains("sdk_gphone"))
        phase = requireNotNull(arguments.getString("phase"))
        require(phase in listOf("normal_back", "recreate", "finish"))
        marker("started")
        try {
            val original = launch()
            val before = snapshot(original)
            marker("ready")
            when (phase) {
                "normal_back" -> {
                    marker("triggered")
                    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                    await("Back moves root Activity out of RESUMED") { resumedActivity() == null }
                    marker("backgrounded")
                    val reopened = launch()
                    if (android.os.Build.VERSION.SDK_INT >= 31) {
                        assertSame("Root launcher Back must retain the Activity on API 31+", original, reopened)
                    }
                    val after = snapshot(reopened)
                    assertEquals("Device identity changed after Back", before.getString("device_id"), after.getString("device_id"))
                }
                "recreate" -> {
                    marker("triggered")
                    instrumentation.runOnMainSync { original.recreate() }
                    await("replacement MainActivity resumed") {
                        resumedActivity()?.let { it !== original } == true
                    }
                    val replacement = requireNotNull(resumedActivity())
                    val after = snapshot(replacement)
                    assertEquals("Device identity changed after recreation", before.getString("device_id"), after.getString("device_id"))
                }
                "finish" -> {
                    marker("triggered")
                    instrumentation.runOnMainSync { original.finish() }
                    await("finished MainActivity destroyed") {
                        var destroyed = false
                        instrumentation.runOnMainSync { destroyed = original.isDestroyed }
                        destroyed
                    }
                    marker("destroyed")
                    // This bounded observation window distinguishes an Activity
                    // callback returning from process shutdown immediately after it.
                    SystemClock.sleep(2000)
                }
            }
            marker("completed")
        } catch (error: Throwable) {
            marker("failed")
            throw error
        }
    }
}
