package com.klaxon.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import java.io.File

/**
 * Receives a `.klaxonbak` opened or shared "with Klaxon" and parks it in
 * the app's private dir as the restore inbox. The Settings restore flow
 * picks it up from there — no file picker involved.
 *
 * This exists because the dialog plugin's Android picker resolves null
 * without showing UI on this device (activity-result plumbing vs the
 * singleTask main activity, most likely). Routing through an intent
 * reuses the pattern ShareActivity has already proven on this hardware.
 */
class RestoreActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val uri: Uri? = when (intent?.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND ->
        @Suppress("DEPRECATION")
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    }

    if (uri == null) {
      toast("Nothing to restore")
      finish()
      return
    }

    val ok = try {
      val inbox = File(applicationContext.dataDir, "restore-inbox.klaxonbak")
      contentResolver.openInputStream(uri).use { input ->
        if (input == null) throw IllegalStateException("no stream")
        inbox.outputStream().use { out -> input.copyTo(out) }
      }
      true
    } catch (t: Throwable) {
      false
    }

    toast(
      if (ok) "Backup received — open Klaxon → Settings → Restore backup"
      else "Couldn't read that file"
    )
    finish()
  }

  private fun toast(msg: String) {
    Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
  }
}
