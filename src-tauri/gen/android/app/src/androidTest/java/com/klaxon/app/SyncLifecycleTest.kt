package com.klaxon.app

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Real MainActivity, lifecycle callbacks and Rust sync. Only disposable emulator fixtures. */
@RunWith(AndroidJUnit4::class)
class SyncLifecycleTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val arguments = InstrumentationRegistry.getArguments()
    private val fixture by lazy {
        JSONObject(String(Base64.decode(arguments.getString("fixture"), Base64.DEFAULT)))
    }
    private val dbFile get() = File(context.applicationInfo.dataDir, "klaxon.db")
    private val identitySentinel get() = File(context.filesDir, "ci-identity.json")
    private lateinit var sqliteExecutable: String

    @get:Rule
    val failureDiagnostics = object : TestWatcher() {
        override fun failed(error: Throwable, description: Description) {
            println("CI database diagnostics: ${runCatching { databaseDiagnostics() }.getOrElse { it.toString() }}")
        }
    }

    private fun currentIdentity(): JSONObject {
        val secretFile = File(context.applicationInfo.dataDir, "klaxon-iroh-secret.bin")
        val secret = secretFile.readBytes()
        assertEquals("Persisted Iroh key must contain 32 bytes", 32, secret.size)
        val digest = MessageDigest.getInstance("SHA-256").digest(secret)
        val deviceId = requireNotNull(scalar("SELECT value FROM settings WHERE key='device_id'"))
        assertTrue("Device ID must be initialized", deviceId.isNotBlank())
        return JSONObject().apply {
            put("device_id", deviceId)
            put("iroh_secret_sha256", Base64.encodeToString(digest, Base64.NO_WRAP))
        }
    }

    private fun assertIdentity() {
        assertTrue("Identity baseline must survive process restart and upgrade", identitySentinel.isFile)
        val expected = JSONObject(identitySentinel.readText())
        val actual = currentIdentity()
        assertEquals("App device ID changed", expected.getString("device_id"), actual.getString("device_id"))
        assertEquals("App Iroh identity changed", expected.getString("iroh_secret_sha256"), actual.getString("iroh_secret_sha256"))
    }

    private fun shellQuote(value: String) = "'" + value.replace("'", "'\"'\"'") + "'"
    private fun sqlQuote(value: String) = "'" + value.replace("'", "''") + "'"

    private fun shell(command: String): String {
        // CI uses API 35. Feed a real shell over stdin: UiAutomation's command
        // string is Runtime.exec-tokenized and does not itself interpret quotes.
        val pipes = instrumentation.uiAutomation.executeShellCommandRw("/system/bin/sh")
        val reader = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "ci-shell-output").apply { isDaemon = true }
        }
        try {
            val result = reader.submit<String> {
                ParcelFileDescriptor.AutoCloseInputStream(pipes[0]).bufferedReader().use { it.readText() }
            }
            ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]).bufferedWriter().use {
                it.write("exec 2>&1\n$command\nci_status=\$?\nprintf '\\n__KLAXON_EXIT__%d\\n' \"\$ci_status\"\nexit\n")
            }
            val output = result.get(20, TimeUnit.SECONDS)
            val marker = Regex("\n__KLAXON_EXIT__(\\d+)\\s*$").find(output)
                ?: throw AssertionError("Shell command did not return an exit marker")
            val body = output.substring(0, marker.range.first).trim()
            if (marker.groupValues[1] != "0") {
                val safeBody = body.replace(fixture.getString("secret"), "<redacted>").take(4000)
                throw IllegalStateException("Shell command failed (${marker.groupValues[1]}): $safeBody")
            }
            return body
        } finally {
            pipes.forEach { runCatching { it.close() } }
            reader.shutdownNow()
        }
    }

    private fun sql(statement: String): String {
        check(dbFile.isFile) { "Production database does not exist: ${dbFile.absolutePath}" }
        // Framework SQLite and Rust's bundled SQLite must never access the same
        // DB in one process: their independent POSIX lock bookkeeping is unsafe.
        // https://sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application
        return shell("run-as ${context.packageName} ${shellQuote(sqliteExecutable)} -batch -bail -json -cmd ${shellQuote(".timeout 5000")} ${shellQuote(dbFile.absolutePath)} ${shellQuote(statement)}")
    }

    private fun rows(statement: String) = JSONArray(sql(statement).ifBlank { "[]" })

    private fun databaseDiagnostics(): JSONObject = JSONObject().apply {
        put("path", dbFile.absolutePath)
        put("database_bytes", dbFile.length())
        put("wal_bytes", File(dbFile.absolutePath + "-wal").length())
        put("shm_bytes", File(dbFile.absolutePath + "-shm").length())
        for ((name, query) in listOf(
            "schema" to "SELECT type,name,tbl_name FROM sqlite_schema ORDER BY name LIMIT 100",
            "schema_version" to "SELECT * FROM schema_version",
            "settings" to "SELECT key,CASE WHEN key IN ('device_id','sync_enabled') THEN value ELSE '<redacted>' END AS value FROM settings ORDER BY key LIMIT 100",
            "peers" to "SELECT id,last_sync_ok_at,last_sync_error,last_sync_error_at FROM peers LIMIT 10"
        )) {
            put(name, runCatching { rows(query) }.getOrElse { it.toString() })
        }
    }

    private fun launch() {
        context.startActivity(Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        })
        instrumentation.waitForIdleSync()
    }

    private fun await(description: String, seconds: Long = 100, condition: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + seconds * 1000
        var failure: Throwable? = null
        while (SystemClock.elapsedRealtime() < end) {
            try {
                if (condition()) return
            } catch (error: Exception) {
                failure = error
            }
            SystemClock.sleep(250)
        }
        throw AssertionError("Timed out: $description; last exception=$failure")
    }

    private fun scalar(statement: String): String? {
        val result = rows(statement)
        if (result.length() == 0) return null
        val row = result.getJSONObject(0)
        val column = row.keys().next()
        return if (row.isNull(column)) null else row.get(column).toString()
    }

    private fun lastSuccess(): Long = scalar("SELECT last_sync_ok_at FROM peers WHERE id='ci-host'")?.toLong() ?: 0

    private fun insertOutgoing(phase: String) {
        val now = System.currentTimeMillis()
        sql("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent,tags,repeat_rule) VALUES (${sqlQuote("android-$phase")},${sqlQuote("Android fixture $phase")},2000000000000,2,'pending',$now,$now,1,'[\"ci\"]','{\"kind\":\"weekly\",\"weekdays\":[1,3,5]}')")
    }

    private fun assertPairing() {
        assertEquals(fixture.getString("node_id"), scalar("SELECT iroh_node_id FROM peers WHERE id='ci-host'"))
        assertTrue("Pairing secret changed", fixture.getString("secret") == scalar("SELECT shared_secret FROM peers WHERE id='ci-host'"))
        assertEquals("true", scalar("SELECT value FROM settings WHERE key='sync_enabled'"))
        assertEquals("Synthetic upgrade sentinel", scalar("SELECT title FROM reminders WHERE id='ci-preserved'"))
    }

    private fun assertSynced(phase: String, previous: Long) {
        await("fresh successful sync and incoming $phase") {
            lastSuccess() > previous && scalar("SELECT title FROM reminders WHERE id='host-$phase'") == "Host fixture $phase"
        }
        assertPairing()
        assertIdentity()
        assertEquals("Android fixture $phase", scalar("SELECT title FROM reminders WHERE id='android-$phase'"))
        val repeat = JSONObject(requireNotNull(scalar("SELECT repeat_rule FROM reminders WHERE id='host-$phase'")))
        assertEquals("weekly", repeat.getString("kind"))
        assertEquals("[1,3,5]", repeat.getJSONArray("weekdays").toString())
        assertNull(scalar("SELECT last_sync_error FROM peers WHERE id='ci-host'"))
    }

    @Test
    fun realSyncAndLifecycle() {
        assertEquals("Emulator guard must be set by the host harness", "true", arguments.getString("disposable_emulator"))
        assertTrue("Physical devices are forbidden", android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.MODEL.contains("sdk_gphone"))
        sqliteExecutable = shell("command -v sqlite3")
        assertTrue("Emulator sqlite3 CLI must be in /system/bin or /system/xbin", sqliteExecutable.matches(Regex("/system/(bin|xbin)/sqlite3")))
        shell("run-as ${context.packageName} ${shellQuote(sqliteExecutable)} --version")
        val phase = requireNotNull(arguments.getString("phase"))
        require(phase in listOf("seed", "identity", "initial", "resume", "restart", "outage", "upgrade"))
        if (phase == "seed") {
            launch()
            await("application creates and migrates its database") {
                dbFile.isFile && !scalar("SELECT value FROM settings WHERE key='device_id'").isNullOrBlank()
            }
            sql("BEGIN IMMEDIATE; " +
                "INSERT INTO peers(id,name,shared_secret,created_at,iroh_node_id,endpoint_addrs) VALUES ('ci-host','Disposable CI host',${sqlQuote(fixture.getString("secret"))},1,${sqlQuote(fixture.getString("node_id"))},${sqlQuote(fixture.getJSONArray("endpoint_addrs").toString())}); " +
                "INSERT OR REPLACE INTO settings(key,value) VALUES ('sync_enabled','true'); " +
                "INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent) VALUES ('ci-preserved','Synthetic upgrade sentinel',2000000000000,2,'pending',1,1,1); COMMIT;")
            assertPairing()
            return
        }
        if (phase == "identity") {
            assertPairing()
            assertFalse("Never overwrite an existing identity baseline", identitySentinel.exists())
            launch()
            // The older baseline may report a protocol mismatch with the current
            // host. Creating its persisted identity must not depend on sync success.
            await("app persists its Iroh identity") {
                val secretFile = File(context.applicationInfo.dataDir, "klaxon-iroh-secret.bin")
                secretFile.isFile && secretFile.length() == 32L
            }
            identitySentinel.writeText(currentIdentity().toString())
            assertIdentity()
            return
        }
        // Read before launch: restart/upgrade must preserve the on-disk pairing.
        assertPairing()
        assertIdentity()
        val previous = lastSuccess()
        if (phase == "resume" || phase == "outage") {
            launch()
            await("initial sync before lifecycle transition") { lastSuccess() > previous }
        }
        if (phase == "resume") {
            shell("input keyevent KEYCODE_HOME")
            SystemClock.sleep(1500)
            val beforeResume = lastSuccess()
            insertOutgoing(phase)
            launch()
            assertSynced(phase, beforeResume)
        } else if (phase == "outage") {
            try {
                shell("svc wifi disable")
                shell("svc data disable")
                val beforeOutage = System.currentTimeMillis()
                insertOutgoing(phase)
                await("failed sync during disconnected network", 100) {
                    (scalar("SELECT last_sync_error_at FROM peers WHERE id='ci-host'")?.toLong() ?: 0) >= beforeOutage
                }
                val disconnectedSuccess = lastSuccess()
                SystemClock.sleep(3000)
                assertEquals("Offline attempts must not claim success", disconnectedSuccess, lastSuccess())
                shell("svc wifi enable")
                shell("svc data enable")
                assertSynced(phase, disconnectedSuccess)
            } finally {
                shell("svc wifi enable")
                shell("svc data enable")
            }
        } else {
            insertOutgoing(phase)
            launch()
            assertSynced(phase, previous)
        }
        // The host separately verifies that this outgoing row really arrived.
    }
}
