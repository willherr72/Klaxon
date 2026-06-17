package com.klaxon.app

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Initialize the global ndk-context BEFORE super.onCreate() boots
    // Tauri → iroh. hickory-resolver (iroh's DNS) and cpal read it and abort
    // the process if it's unset. applicationContext is valid here —
    // attachBaseContext has already run.
    System.loadLibrary("klaxon_lib")
    nativeInitAndroidContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    scheduleBackgroundSync()
  }

  private external fun nativeInitAndroidContext(context: Context)

  /**
   * Register the ~25-minute background sync job. KEEP policy means relaunches
   * don't reset the schedule; WorkManager persists it across process death and
   * reboot on its own.
   */
  private fun scheduleBackgroundSync() {
    val request = PeriodicWorkRequestBuilder<BackgroundSyncWorker>(25, TimeUnit.MINUTES)
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build()
      )
      .build()
    WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
      "klaxon-bg-sync",
      ExistingPeriodicWorkPolicy.KEEP,
      request,
    )
  }
}
