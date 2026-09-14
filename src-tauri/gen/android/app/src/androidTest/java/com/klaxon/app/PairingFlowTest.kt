package com.klaxon.app

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Incoming real QUIC offers exercise PairHandler and the shipped Svelte modal. */
@RunWith(AndroidJUnit4::class)
class PairingFlowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val arguments = InstrumentationRegistry.getArguments()
    private lateinit var webView: WebView
    private lateinit var sqliteExecutable: String
    private val modal = "document.querySelector('[role=alertdialog][aria-labelledby=pair-title]')"

    private fun await(description: String, seconds: Long = 45, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + seconds * 1000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(200)
        }
        throw AssertionError("Timed out: $description")
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

    private fun evaluate(script: String): String {
        val completed = CountDownLatch(1)
        var value = "null"
        instrumentation.runOnMainSync {
            webView.evaluateJavascript(script) { result ->
                value = result
                completed.countDown()
            }
        }
        assertTrue("WebView JavaScript callback", completed.await(10, TimeUnit.SECONDS))
        return JSONTokener(value).nextValue().toString()
    }

    // Invoke the same public command API used by the UI. Only the temporary
    // promise result lives in this test's JavaScript; no production test hook.
    private fun invoke(command: String, args: JSONObject = JSONObject()): JSONObject {
        evaluate("window.__ciPairResult = null; window.__TAURI_INTERNALS__.invoke(${JSONObject.quote(command)}, $args).then(value => window.__ciPairResult = {ok:true,value}, error => window.__ciPairResult = {ok:false,error:String(error)}); null")
        var result = "null"
        await("public command $command") {
            result = evaluate("JSON.stringify(window.__ciPairResult)")
            result != "null"
        }
        return JSONObject(result)
    }

    private fun shellQuote(value: String) = "'" + value.replace("'", "'\"'\"'") + "'"
    private fun sqlQuote(value: String) = "'" + value.replace("'", "''") + "'"

    private fun shell(command: String): String {
        val pipes = instrumentation.uiAutomation.executeShellCommandRw("/system/bin/sh")
        val reader = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "pair-shell-output").apply { isDaemon = true }
        }
        try {
            val output = reader.submit<String> {
                ParcelFileDescriptor.AutoCloseInputStream(pipes[0]).bufferedReader().use { it.readText() }
            }
            ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]).bufferedWriter().use {
                it.write("exec 2>&1\n$command\nci_status=\$?\nprintf '\\n__KLAXON_EXIT__%d\\n' \"\$ci_status\"\nexit\n")
            }
            val value = output.get(20, TimeUnit.SECONDS)
            val marker = Regex("\n__KLAXON_EXIT__(\\d+)\\s*$").find(value)
                ?: throw AssertionError("Shell command did not finish")
            // Never include query results: an assertion may be reading a secret.
            check(marker.groupValues[1] == "0") { "Pairing fixture shell command failed" }
            return value.substring(0, marker.range.first).trim()
        } finally {
            pipes.forEach { runCatching { it.close() } }
            reader.shutdownNow()
        }
    }

    private fun sql(statement: String): JSONArray {
        // Use a separate process; Android SQLite and bundled Rust SQLite cannot
        // safely share POSIX locks in the same process.
        val path = File(context.applicationInfo.dataDir, "klaxon.db").absolutePath
        val output = shell("run-as ${context.packageName} ${shellQuote(sqliteExecutable)} -batch -bail -json -cmd ${shellQuote(".timeout 5000")} ${shellQuote(path)} ${shellQuote(statement)}")
        return JSONArray(output.ifBlank { "[]" })
    }

    private fun controlFile(name: String) = File(context.filesDir, "ci-pair-$name.json")

    private fun readControl(name: String, scenario: String, seconds: Long): JSONObject {
        var result: JSONObject? = null
        await("host $name for $scenario", seconds) {
            val file = controlFile(name)
            if (file.isFile) {
                val candidate = runCatching { JSONObject(file.readText()) }.getOrNull()
                if (candidate?.optString("scenario") == scenario) result = candidate
            }
            result != null
        }
        return requireNotNull(result)
    }

    private fun udpPorts(): List<Int> {
        // Public socket metadata only. Android hides getsockopt(SO_TYPE), so
        // enumerate unconnected wildcard IP sockets as UDP candidates. The host
        // authenticates each candidate against this app's public endpoint ID.
        // Duplicate descriptors so cleanup cannot close Rust's live endpoint.
        return File("/proc/self/fd").listFiles().orEmpty().mapNotNull { entry ->
            runCatching {
                if (!Os.readlink(entry.absolutePath).startsWith("socket:")) return@runCatching null
                ParcelFileDescriptor.fromFd(entry.name.toInt()).use { duplicate ->
                    val address = Os.getsockname(duplicate.fileDescriptor) as? InetSocketAddress
                    if (address == null || !address.address.isAnyLocalAddress) return@use null
                    try {
                        Os.getpeername(duplicate.fileDescriptor)
                        return@use null
                    } catch (error: ErrnoException) {
                        if (error.errno != OsConstants.ENOTCONN) throw error
                    }
                    address.port.takeIf { it > 1024 && it != 5353 }
                }
            }.getOrNull()
        }.distinct().sorted()
    }

    @Test
    fun incomingPairingUi() {
        assertEquals("Disposable emulator must be selected explicitly", "true", arguments.getString("disposable_emulator"))
        assertTrue("Physical devices are forbidden", android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.MODEL.contains("sdk_gphone"))
        val scenario = requireNotNull(arguments.getString("scenario"))
        require(scenario in listOf("approve", "decline", "expire"))
        sqliteExecutable = shell("command -v sqlite3")
        assertTrue("Use emulator SQLite CLI", sqliteExecutable.matches(Regex("/system/(bin|xbin)/sqlite3")))
        context.startActivity(Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        })
        await("real app WebView") {
            var found: WebView? = null
            instrumentation.runOnMainSync {
                val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .firstOrNull { it is MainActivity }
                if (activity != null) found = findWebView(activity.window.decorView)
            }
            found?.let { webView = it }
            found != null
        }
        await("loaded app UI and command API") {
            evaluate("Boolean(window.__TAURI_INTERNALS__ && document.querySelector('.app'))") == "true"
        }
        var identity = JSONObject()
        await("public pairing identity", 60) {
            val response = invoke("device_identity")
            assertTrue("device_identity succeeds", response.getBoolean("ok"))
            identity = response.getJSONObject("value")
            !identity.isNull("iroh_node_id") && identity.optString("iroh_node_id").isNotBlank()
        }
        // Allow the mounted modal's async event registration to complete before
        // the host may submit an offer; no fabricated event is emitted.
        SystemClock.sleep(500)
        val ports = udpPorts()
        assertTrue("App has a live UDP endpoint", ports.isNotEmpty())
        val ready = JSONObject().put("scenario", scenario)
            .put("node_id", identity.getString("iroh_node_id"))
            .put("udp_ports", JSONArray(ports))
        val temporary = File(context.filesDir, "ci-pair-ready.pending")
        temporary.writeText(ready.toString())
        assertTrue("Publish public endpoint metadata atomically", temporary.renameTo(controlFile("ready")))

        val offer = readControl("offer", scenario, 60)
        val peerId = offer.getString("peer_id")
        val peerPredicate = "id=${sqlQuote(peerId)}"
        assertEquals("Incoming offer does not create a peer without consent", 0, sql("SELECT id FROM peers WHERE $peerPredicate").length())
        await("incoming pairing modal", 45) { evaluate("Boolean($modal)") == "true" }
        assertEquals(offer.getString("peer_name"), evaluate("$modal.querySelector('.from-name').textContent.trim()"))
        assertEquals("Both endpoints display the same confirmation code", offer.getString("confirmation_code"), evaluate("$modal.querySelector('.code-value').textContent.trim()"))
        val opened = SystemClock.elapsedRealtime()

        if (scenario == "approve") {
            val now = System.currentTimeMillis()
            sql("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent) VALUES ('android-paired','Android fixture paired',2000000000000,2,'pending',$now,$now,1)")
        }

        // Removing a Svelte onclick handler, swapping Approve/Decline, or
        // failing to deliver the production expiration event must fail here.
        if (scenario != "expire") {
            assertEquals("true", evaluate("(() => { const button = $modal.querySelector('button.$scenario'); if (!button || button.disabled) return false; button.click(); return true; })()"))
        }
        val result = readControl("result", scenario, if (scenario == "expire") 155 else 60)
        assertFalse("Host fixture failed: ${result.optString("error")}", result.has("error"))
        assertEquals(if (scenario == "approve") "approved" else "declined", result.getString("outcome"))
        if (scenario == "expire") {
            assertTrue("Timeout must allow the real approval window", result.getLong("decision_elapsed_ms") >= 119_000)
            assertTrue("Expiration was observed in this live UI session", SystemClock.elapsedRealtime() - opened >= 110_000)
        }
        await("resolved pairing modal disappears", 10) { evaluate("Boolean($modal)") == "false" }
        if (scenario == "approve") {
            val peer = sql("SELECT iroh_node_id,shared_secret FROM peers WHERE $peerPredicate")
            assertEquals("Approval persists exactly one peer", 1, peer.length())
            assertEquals(offer.getString("node_id"), peer.getJSONObject(0).getString("iroh_node_id"))
            val secret = peer.getJSONObject(0).getString("shared_secret")
            val digest = MessageDigest.getInstance("SHA-256").digest(secret.toByteArray())
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            assertTrue("Persisted secret matches the actual PairAck", digest == result.getString("shared_secret_sha256"))
            assertTrue("Authenticated production sync succeeded", result.getBoolean("sync_verified"))
            assertEquals("Host fixture paired", sql("SELECT title FROM reminders WHERE id='host-paired'").getJSONObject(0).getString("title"))
        } else {
            assertEquals("Declined or expired offers persist no peer", 0, sql("SELECT id FROM peers WHERE $peerPredicate").length())
        }
        val stale = invoke("approve_pair_request", JSONObject().put("requestId", offer.getString("request_id")))
        assertFalse("Resolved requests are removed from backend pending state", stale.getBoolean("ok"))
        assertTrue("Stale request is rejected as expired", stale.getString("error").contains("expired or unknown"))
        if (scenario == "approve") {
            // The one-shot host has exited. Remove only this test's verified
            // pairing so later lifecycle phases do not dial an offline fixture.
            val removed = invoke("remove_peer", JSONObject().put("id", peerId))
            assertTrue("Remove the completed synthetic pairing", removed.getBoolean("ok"))
            assertEquals("Synthetic pairing cleanup completed", 0, sql("SELECT id FROM peers WHERE $peerPredicate").length())
        }
    }
}
