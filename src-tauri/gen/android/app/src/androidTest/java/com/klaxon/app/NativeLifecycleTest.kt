package com.klaxon.app

import android.app.Activity
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
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
    private var observedActivity: MainActivity? = null
    private var launchHomePackage: String? = null

    private fun marker(status: String) {
        val event = JSONObject().apply {
            put("status", status)
            put("elapsed_ms", SystemClock.elapsedRealtime())
            put("launch_method", "home_launcher_icon")
            put("launcher_package", launchHomePackage ?: JSONObject.NULL)
            observedActivity?.let { activity ->
                instrumentation.runOnMainSync {
                    put("activity_instance", System.identityHashCode(activity))
                    put("task_id", activity.taskId)
                    put("is_task_root", activity.isTaskRoot)
                    put("is_finishing", activity.isFinishing)
                    put("is_destroyed", activity.isDestroyed)
                    put("intent_action", activity.intent.action)
                    put("intent_flags", activity.intent.flags)
                }
            }
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
        // Android 15 also checks LAUNCH_SOURCE_TYPE_HOME before backgrounding
        // on Back. startActivity() from our own UID fails that check even with
        // MAIN/LAUNCHER flags. Tap the actual launcher's app icon instead.
        shell("input keyevent KEYCODE_HOME")
        val homeComponent = shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
            .lineSequence().last { it.contains('/') }.trim()
        val homePackage = homeComponent.substringBefore('/')
        launchHomePackage = homePackage
        await("home launcher visible") {
            instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == homePackage
        }
        val label = context.applicationInfo.loadLabel(context.packageManager).toString()
        var clicked = clickLauncherIcon(homePackage, label)
        // Fresh emulators have no desktop shortcut for an ADB-installed app.
        // Swipe up to open the app drawer, then scroll within it if necessary.
        for (attempt in 0 until 6) {
            if (clicked) break
            val bounds = android.graphics.Rect()
            requireNotNull(instrumentation.uiAutomation.rootInActiveWindow).getBoundsInScreen(bounds)
            shell("input swipe ${bounds.centerX()} ${bounds.bottom - bounds.height() / 8} ${bounds.centerX()} ${bounds.top + bounds.height() / 4} 400")
            instrumentation.uiAutomation.waitForIdle(200, 5000)
            clicked = clickLauncherIcon(homePackage, label)
        }
        if (!clicked) {
            Log.e("KlaxonLifecycleProbe", "Launcher icon missing; bounded hierarchy: ${launcherHierarchy()}")
            fail("Launcher app drawer must contain the Klaxon icon; see bounded hierarchy log")
        }
        await("MainActivity resumed") { resumedActivity() != null }
        return requireNotNull(resumedActivity()).also { observedActivity = it }
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private fun clickLauncherIcon(homePackage: String, label: String): Boolean {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return false
        if (root.packageName?.toString() != homePackage) return false
        for (match in root.findAccessibilityNodeInfosByText(label)) {
            if (match.text?.toString() != label && match.contentDescription?.toString() != label) continue
            var candidate: AccessibilityNodeInfo? = match
            repeat(4) {
                val node = candidate ?: return@repeat
                if (node.isVisibleToUser && node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
                candidate = node.parent
            }
        }
        return false
    }

    private fun launcherHierarchy(): String {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return "No active window"
        val pending = java.util.ArrayDeque<AccessibilityNodeInfo>()
        pending.add(root)
        val output = StringBuilder()
        var count = 0
        while (pending.isNotEmpty() && count++ < 100 && output.length < 6000) {
            val node = pending.removeFirst()
            output.append("[class=").append(node.className?.take(70))
                .append(" text=").append(node.text?.take(120))
                .append(" desc=").append(node.contentDescription?.take(120)).append("] ")
            for (index in 0 until node.childCount) node.getChild(index)?.let { pending.add(it) }
        }
        return output.toString().take(6000)
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
                    await("Back stops the root launcher Activity") {
                        var stopped = false
                        instrumentation.runOnMainSync {
                            assertFalse("Launcher Back must not finish the Activity", original.isFinishing)
                            assertFalse("Launcher Back must not destroy the Activity", original.isDestroyed)
                            stopped = ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(original) == Stage.STOPPED
                        }
                        stopped
                    }
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
                    observedActivity = replacement
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
