package com.klaxon.app

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Periodic background sync. WorkManager wakes us roughly every 25 min while the
 * app process is resident; we call into Rust to run one iroh pull/push pass.
 *
 * Warm-only: if the process is cold the native side returns 0 (NotReady) and we
 * simply succeed and wait for the next period. Outcome codes:
 *   0 = NotReady (cold process), 1 = Disabled (sync off), 2 = Ran, -1 = error.
 */
class BackgroundSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    private external fun nativeSyncOnce(): Int

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val outcome = try {
            nativeSyncOnce()
        } catch (t: Throwable) {
            Log.w(TAG, "background sync threw", t)
            -1
        }
        Log.i(TAG, "background sync outcome=$outcome")
        // Always success: this is a periodic job, so we rely on the next period
        // rather than WorkManager retry/backoff.
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
