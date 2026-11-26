package dev.klaxon.p0alarm;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.os.Process;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class AlarmReceiver extends BroadcastReceiver {
    private static final long MAX_RECEIPT_BYTES = 64 * 1024;

    @Override
    public void onReceive(Context context, Intent intent) {
        long receivedAtMs = System.currentTimeMillis();
        if (!ArmActivity.ALARM_ACTION.equals(intent.getAction())) {
            return;
        }
        String runId = intent.getStringExtra(ArmActivity.RUN_ID);
        String slot = intent.getStringExtra("slot");
        int revision = intent.getIntExtra("revision", 0);
        long dueMs = intent.getLongExtra("dueMs", 0);
        boolean validSlotRevision = (ArmActivity.RETAINED.equals(slot) && (revision == 1 || revision == 2))
                || (ArmActivity.CANCELED.equals(slot) && revision == 1);
        if (!ArmActivity.validRunId(runId) || !validSlotRevision || dueMs <= 0) {
            return;
        }

        PowerManager power = context.getSystemService(PowerManager.class);
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        try {
            // Preserve stale, canceled, and duplicate callbacks for the host to evaluate.
            JSONObject receipt = new JSONObject()
                    .put("runId", runId)
                    .put("slot", slot)
                    .put("revision", revision)
                    .put("dueMs", dueMs)
                    .put("receivedAtMs", receivedAtMs)
                    .put("pid", Process.myPid())
                    .put("processStartElapsedMs", Process.getStartElapsedRealtime())
                    .put("interactive", power.isInteractive())
                    .put("keyguardLocked", keyguard.isKeyguardLocked())
                    .put("idle", power.isDeviceIdleMode());
            byte[] row = (receipt + "\n").getBytes(StandardCharsets.UTF_8);
            File receipts = new File(context.getNoBackupFilesDir(), ArmActivity.RECEIPTS);
            if (receipts.length() + row.length > MAX_RECEIPT_BYTES) {
                Log.e(ArmActivity.TAG, "Alarm receipt log reached its size limit");
                return;
            }
            try (FileOutputStream output = new FileOutputStream(receipts, true)) {
                output.write(row);
                output.getFD().sync();
            }
        } catch (IOException | JSONException failure) {
            Log.e(ArmActivity.TAG, "Could not write alarm fixture receipt", failure);
        }
    }
}
