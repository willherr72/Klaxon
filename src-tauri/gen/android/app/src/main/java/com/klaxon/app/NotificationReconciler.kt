package com.klaxon.app

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import app.tauri.notification.Notification
import app.tauri.notification.NotificationStorage
import app.tauri.notification.TauriNotificationManager
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Executes an alarm plan produced by the Rust planner. Thin on purpose:
 * no decisions here — cancel what isn't in the plan, (re)schedule what
 * is, through the vendored notification plugin's own manager/storage so
 * ids, receiver behavior, and action buttons stay identical to
 * plugin-scheduled notifications.
 *
 * Construction detail that matters: the plugin's fire-time receiver
 * rebuilds notifications by jackson-parsing `sourceJson` (the raw JS
 * invoke args). So each entry here is built as that exact wire JSON,
 * parsed through the same plain ObjectMapper the receiver uses — if the
 * parse works at arm time, it works at fire time — and stored as its
 * own sourceJson.
 *
 * Past-due entries are scheduled at now+2s (allowWhileIdle) so immediate
 * rings flow through the exact same receiver path as future ones.
 */
object NotificationReconciler {
  private const val TAG = "Klaxon"
  private const val ACTION_TYPE_ID = "klaxon-reminder"
  private const val JS_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"

  @JvmStatic
  fun reconcile(context: Context, planJson: String): Boolean {
    return try {
      val mapper = ObjectMapper()
      val storage = NotificationStorage(context, mapper)
      val manager = TauriNotificationManager(storage, null, context, null)
      val plan = JSONArray(planJson)
      val now = System.currentTimeMillis()

      val sdf = SimpleDateFormat(JS_DATE_FORMAT, Locale.US)
      sdf.timeZone = TimeZone.getTimeZone("UTC")

      val desiredIds = HashSet<Int>()
      val toSchedule = ArrayList<Notification>()

      for (i in 0 until plan.length()) {
        val p = plan.getJSONObject(i)
        val id = p.getInt("id_hash")
        desiredIds.add(id)
        val atMs = p.getLong("at_ms")
        val fireAt = if (atMs <= now) now + 2_000 else atMs

        // The plugin's wire schema — what JS sendNotification sends and
        // what the receiver's jackson parse expects back.
        val wire = JSONObject()
          .put("id", id)
          .put("title", p.getString("title"))
          .put("body", p.getString("body"))
          .put("channelId", p.getString("channel_id"))
          .put("actionTypeId", ACTION_TYPE_ID)
          .put("extra", JSONObject().put("reminderId", p.getString("reminder_id")))
          .put(
            "schedule",
            JSONObject().put(
              "at",
              JSONObject()
                .put("date", sdf.format(Date(fireAt)))
                .put("repeating", false)
                .put("allowWhileIdle", true)
            )
          )

        val json = wire.toString()
        val n = mapper.readValue(json, Notification::class.java)
        n.sourceJson = json
        toSchedule.add(n)
      }

      // Cancel anything armed or posted that the plan no longer wants.
      val stale = storage.getSavedNotificationIds()
        .mapNotNull { it.toIntOrNull() }
        .filter { it !in desiredIds }
      if (stale.isNotEmpty()) {
        manager.cancel(stale)
        val nm = NotificationManagerCompat.from(context)
        for (id in stale) nm.cancel(id)
      }

      if (toSchedule.isNotEmpty()) manager.schedule(toSchedule)
      Log.i(TAG, "alarm reconcile: ${toSchedule.size} armed, ${stale.size} cancelled")
      true
    } catch (t: Throwable) {
      Log.w(TAG, "alarm reconcile failed", t)
      false
    }
  }
}
