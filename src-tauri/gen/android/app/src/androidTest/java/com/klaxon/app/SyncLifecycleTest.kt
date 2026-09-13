package com.klaxon.app

import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.SystemClock
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

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

    private fun database(): SQLiteDatabase = SQLiteDatabase.openDatabase(
        dbFile.absolutePath, null,
        SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
    )

    private fun shell(command: String): String = instrumentation.uiAutomation
        .executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).bufferedReader().readText()
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
        val evidence = runCatching {
            database().use { db ->
                db.rawQuery("SELECT last_sync_ok_at,last_sync_error,last_sync_error_at FROM peers WHERE id='ci-host'", null).use {
                    if (it.moveToFirst()) "ok=${it.getString(0)} error=${it.getString(1)} errorAt=${it.getString(2)}" else "no peer"
                }
            }
        }.getOrElse { it.toString() }
        throw AssertionError("Timed out: $description; $evidence; last exception=$failure")
    }

    private fun scalar(sql: String): String? = database().use { db ->
        db.rawQuery(sql, null).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }
    }

    private fun lastSuccess(): Long = scalar("SELECT last_sync_ok_at FROM peers WHERE id='ci-host'")?.toLong() ?: 0

    private fun insertOutgoing(phase: String) {
        database().use { db ->
            db.execSQL(
                "INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent,tags) VALUES (?,?,2000000000000,2,'pending',?,?,1,'[\"ci\"]')",
                arrayOf("android-$phase", "Android fixture $phase", System.currentTimeMillis(), System.currentTimeMillis())
            )
        }
    }

    private fun assertPairing() {
        assertEquals(fixture.getString("node_id"), scalar("SELECT iroh_node_id FROM peers WHERE id='ci-host'"))
        assertEquals(fixture.getString("secret"), scalar("SELECT shared_secret FROM peers WHERE id='ci-host'"))
        assertEquals("true", scalar("SELECT value FROM settings WHERE key='sync_enabled'"))
        assertEquals("Synthetic upgrade sentinel", scalar("SELECT title FROM reminders WHERE id='ci-preserved'"))
    }

    private fun assertSynced(phase: String, previous: Long) {
        await("fresh successful sync and incoming $phase") {
            lastSuccess() > previous && scalar("SELECT title FROM reminders WHERE id='host-$phase'") == "Host fixture $phase"
        }
        assertPairing()
        assertEquals("Android fixture $phase", scalar("SELECT title FROM reminders WHERE id='android-$phase'"))
        assertNull(scalar("SELECT last_sync_error FROM peers WHERE id='ci-host'"))
    }

    @Test
    fun realSyncAndLifecycle() {
        assertEquals("Emulator guard must be set by the host harness", "true", arguments.getString("disposable_emulator"))
        assertTrue("Physical devices are forbidden", android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.MODEL.contains("sdk_gphone"))
        val phase = requireNotNull(arguments.getString("phase"))
        require(phase in listOf("seed", "initial", "resume", "restart", "outage", "upgrade"))
        if (phase == "seed") {
            launch()
            await("application creates and migrates its database") {
                dbFile.isFile && scalar("SELECT COUNT(*) FROM settings") != null
            }
            database().use { db ->
                db.beginTransaction()
                try {
                    db.execSQL("INSERT INTO peers(id,name,shared_secret,created_at,iroh_node_id,endpoint_addrs) VALUES ('ci-host','Disposable CI host',?,1,?,?)", arrayOf(fixture.getString("secret"), fixture.getString("node_id"), fixture.getJSONArray("endpoint_addrs").toString()))
                    db.execSQL("INSERT OR REPLACE INTO settings(key,value) VALUES ('sync_enabled','true')")
                    db.execSQL("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent) VALUES ('ci-preserved','Synthetic upgrade sentinel',2000000000000,2,'pending',1,1,1)")
                    db.setTransactionSuccessful()
                } finally { db.endTransaction() }
            }
            assertPairing()
            return
        }
        // Read before launch: restart/upgrade must preserve the on-disk pairing.
        assertPairing()
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
