package com.klaxon.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager

/**
 * Receives an Android share and writes it straight to the database.
 *
 * Deliberately NOT an intent-filter on MainActivity: that activity is
 * launchMode="singleTask", so routing shares through it would bring Klaxon
 * to the foreground. The point of this path is that you stay in whatever
 * app you shared from.
 *
 * The insert runs on the main thread. It is a single INSERT into a local
 * SQLite file — sub-millisecond in practice — and the activity has nothing
 * to render while waiting.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""

    if (text.isNullOrBlank()) {
      toast("Nothing to save")
      finish()
      return
    }

    val code = try {
      System.loadLibrary("klaxon_lib")
      // Context.dataDir, not filesDir — this must match what Tauri's
      // app_data_dir() resolves to, or the thought lands in a second
      // database the app never reads.
      nativeSaveThought(applicationContext.dataDir.absolutePath, subject, text)
    } catch (e: Throwable) {
      -99
    }

    if (code == 0) {
      // The thought is in SQLite, but this process has no sync engine and
      // the app may be cold. An expedited one-shot of the sync worker
      // pushes it out within seconds-to-minutes instead of waiting for
      // the app to next open. (v0.5.1 — the worker is cold-capable.)
      try {
        val req = OneTimeWorkRequestBuilder<BackgroundSyncWorker>()
          .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
          )
          .build()
        WorkManager.getInstance(applicationContext)
          .enqueueUniqueWork("klaxon-share-sync", ExistingWorkPolicy.REPLACE, req)
      } catch (t: Throwable) {
        // Sync happens on next app open instead — never block the share.
      }
    }

    toast(if (code == 0) "Saved to Klaxon" else "Klaxon couldn't save that")
    finish()
  }

  private fun toast(msg: String) {
    Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
  }

  private external fun nativeSaveThought(
    dataDir: String,
    subject: String,
    text: String,
  ): Int
}
