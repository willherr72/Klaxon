package dev.klaxon.p0alarm;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.regex.Pattern;

public final class ArmActivity extends Activity {
    static final String TAG = "KlaxonP0Alarm";
    static final String RECEIPTS = "receipts.jsonl";
    static final String RUN_ID = "run-id";
    static final String ALARM_ACTION = "dev.klaxon.p0alarm.FIXTURE_ALARM";
    static final String RETAINED = "retained";
    static final String CANCELED = "canceled";
    private static final Pattern RUN_ID_PATTERN = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");

    static boolean validRunId(String runId) {
        return runId != null && runId.length() == 36 && RUN_ID_PATTERN.matcher(runId).matches();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            String runId = getIntent().getStringExtra(RUN_ID);
            if (validRunId(runId)) {
                arm(runId);
            }
        } catch (IOException | JSONException | RuntimeException failure) {
            Log.e(TAG, "Could not arm alarm fixture", failure);
        } finally {
            finish();
        }
    }

    private void arm(String runId) throws IOException, JSONException {
        File directory = getNoBackupFilesDir();
        // The empty log claims this installation for one synthetic run.
        if (!new File(directory, RECEIPTS).createNewFile()) {
            return;
        }

        AlarmManager alarms = getSystemService(AlarmManager.class);
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        long armedAtMs = System.currentTimeMillis();
        long replacedDueMs = armedAtMs + 20_000;
        long canceledDueMs = armedAtMs + 24_000;
        long dueMs = armedAtMs + 30_000;

        PendingIntent retained = null;
        PendingIntent canceled = null;
        try {
            retained = operation(runId, RETAINED, 1, replacedDueMs, 0);
            schedule(alarms, exact, replacedDueMs, retained);
            canceled = operation(runId, CANCELED, 1, canceledDueMs, 0);
            schedule(alarms, exact, canceledDueMs, canceled);

            // The run and slot keep the same identity. Canceling the old token keeps its extras intact.
            retained = operation(runId, RETAINED, 2, dueMs, PendingIntent.FLAG_CANCEL_CURRENT);
            schedule(alarms, exact, dueMs, retained);
            cancel(alarms, canceled);

            JSONObject plan = new JSONObject()
                    .put("runId", runId)
                    .put("armedPid", Process.myPid())
                    .put("armedProcessStartElapsedMs", Process.getStartElapsedRealtime())
                    .put("armedAtMs", armedAtMs)
                    .put("replacedDueMs", replacedDueMs)
                    .put("canceledDueMs", canceledDueMs)
                    .put("dueMs", dueMs)
                    .put("mode", exact ? "exact" : "inexact");
            writePlan(directory, plan);
        } catch (IOException | JSONException | RuntimeException failure) {
            if (retained != null) {
                cancel(alarms, retained);
            }
            if (canceled != null) {
                cancel(alarms, canceled);
            }
            throw failure;
        }
    }

    private PendingIntent operation(String runId, String slot, int revision, long dueMs, int flags) {
        Uri identity = new Uri.Builder().scheme("klaxon-p0-alarm").authority("run")
                .appendPath(runId).appendPath(slot).build();
        Intent intent = new Intent(this, AlarmReceiver.class)
                .setAction(ALARM_ACTION)
                .setData(identity)
                .putExtra(RUN_ID, runId)
                .putExtra("slot", slot)
                .putExtra("revision", revision)
                .putExtra("dueMs", dueMs);
        return PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | flags);
    }

    private static void schedule(AlarmManager alarms, boolean exact, long dueMs, PendingIntent operation) {
        if (exact) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueMs, operation);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueMs, operation);
        }
    }

    private static void cancel(AlarmManager alarms, PendingIntent operation) {
        alarms.cancel(operation);
        operation.cancel();
    }

    private static void writePlan(File directory, JSONObject plan) throws IOException {
        File pending = new File(directory, "plan.json.tmp");
        try (FileOutputStream output = new FileOutputStream(pending)) {
            output.write(plan.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        Files.move(pending.toPath(), new File(directory, "plan.json").toPath(), StandardCopyOption.ATOMIC_MOVE);
    }
}
