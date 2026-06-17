package com.klaxon.app

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
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    scheduleBackgroundSync()
  }

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
