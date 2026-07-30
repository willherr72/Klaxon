package com.klaxon.app

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Fires the system share sheet for a file in the app's cache dir. Called
 * from Rust over JNI (export backup). The cache dir is already covered by
 * the FileProvider's cache-path entry in res/xml/file_paths.xml.
 */
object ShareHelper {
  @JvmStatic
  fun shareFile(context: Context, path: String) {
    val uri = FileProvider.getUriForFile(
      context, "${context.packageName}.fileprovider", File(path)
    )
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, "Save Klaxon backup").apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(chooser)
  }
}
