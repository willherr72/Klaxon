package com.klaxon.app

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a downloaded APK to Android's package installer. The release
 * signing key matches the installed app, so this is an in-place upgrade
 * with data intact. First use, Android asks the user once to allow
 * installs from Klaxon — that prompt is the OS's, not ours.
 *
 * The APK lives under the app cache dir, which the existing
 * `${applicationId}.fileprovider` already exposes (res/xml/file_paths.xml
 * has a cache-path entry) — no provider changes needed.
 */
object UpdateInstaller {
  private const val TAG = "Klaxon"

  @JvmStatic
  fun install(context: Context, apkPath: String): Boolean {
    return try {
      val uri = FileProvider.getUriForFile(
        context, "${context.packageName}.fileprovider", File(apkPath)
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      context.startActivity(intent)
      Log.i(TAG, "update install intent fired for ${File(apkPath).name}")
      true
    } catch (t: Throwable) {
      Log.w(TAG, "update install failed", t)
      false
    }
  }
}
