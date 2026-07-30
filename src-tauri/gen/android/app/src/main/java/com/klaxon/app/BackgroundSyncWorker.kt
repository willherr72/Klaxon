package com.klaxon.app

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Background sync. WorkManager wakes us roughly every 25 min (periodic), or
 * immediately after an Android share (expedited one-shot from ShareActivity);
 * we call into Rust to run one iroh pull/push pass.
 *
 * v0.5.1: cold-capable. A warm process uses the app's own endpoint; a cold
 * one opens the database and binds a short-lived headless endpoint from the
 * persisted identity. Outcome codes:
 *   0 = NotReady, 1 = Disabled (sync off), 2 = Ran (warm),
 *   3 = RanCold (headless), -1 = error.
 */
class BackgroundSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    private external fun nativeInitAndroidContext(context: Context)
    private external fun nativeSyncOnce(dataDir: String): Int

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val outcome = try {
            // A cold process never ran MainActivity.onCreate, so the
            // ndk-context (needed by iroh's DNS resolver) must be
            // initialized here. Guarded native-side: re-init is a no-op.
            nativeInitAndroidContext(applicationContext)
            nativeSyncOnce(applicationContext.dataDir.absolutePath)
        } catch (t: Throwable) {
            Log.w(TAG, "background sync threw", t)
            -1
        }
        Log.i(TAG, "background sync outcome=$outcome")
        // Always success: periodic jobs rely on the next period, and the
        // expedited one-shot gets its retry from the next write or
        // foreground rather than WorkManager backoff.
        Result.success()
    }

    companion object {
        private const val TAG = "Klaxon"

        init {
            // Resolve the JNI symbol. No-op if the Activity already loaded it
            // (warm process); needed if the worker class loads first.
            try {
                System.loadLibrary("klaxon_lib")
            } catch (t: Throwable) {
                Log.w(TAG, "loadLibrary(klaxon_lib) failed", t)
            }
        }
    }
}
