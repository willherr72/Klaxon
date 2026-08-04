package com.klaxon.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.util.Log
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
    registerNetworkCallback()
  }

  private external fun nativeInitAndroidContext(context: Context)
  private external fun nativeNetworkChanged()

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

  /**
   * v0.7.2 (issue #3): Android never surfaces network changes to native
   * code — iroh's own docs call this out — so an endpoint that outlives
   * a Wi-Fi migration stays bound to the dead network until process
   * death. Forward connectivity events to Rust, which notifies iroh and
   * nudges a sync pass. Registration failure degrades to the old
   * behavior (restart to recover); never fatal.
   */
  private fun registerNetworkCallback() {
    try {
      val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          Log.i("Klaxon", "network available — notifying Rust")
          runCatching { nativeNetworkChanged() }
        }

        override fun onLost(network: Network) {
          Log.i("Klaxon", "network lost — notifying Rust")
          runCatching { nativeNetworkChanged() }
        }
      })
    } catch (t: Throwable) {
      Log.w("Klaxon", "network callback registration failed", t)
    }
  }
}
