package dev.klaxon.p0alarmvisible;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.util.UUID;

public final class ArmActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION = 1;
    private RunStore store;
    private AlarmNotification notifications;
    private Button permissionButton;
    private Button armButton;
    private TextView settings;
    private TextView status;
    private TextView evidence;
    private String armError = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new RunStore(this);
        notifications = new AlarmNotification(this);

        ScrollView scroll = new ScrollView(this);
        scroll.setFitsSystemWindows(true);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        scroll.addView(layout);

        TextView title = addText(layout, "Klaxon P0 native alarm");
        title.setTextSize(24);
        addText(layout, "One inexact test reminder, due two minutes after arming.");
        settings = addText(layout, "");
        permissionButton = new Button(this);
        permissionButton.setText("Allow notifications");
        permissionButton.setAllCaps(false);
        permissionButton.setOnClickListener(view -> requestPermissions(
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION));
        layout.addView(permissionButton);
        armButton = new Button(this);
        armButton.setText("Arm test reminder");
        armButton.setAllCaps(false);
        armButton.setOnClickListener(view -> arm());
        layout.addView(armButton);
        status = addText(layout, "");
        evidence = addText(layout, "");
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION) {
            refresh();
        }
    }

    private TextView addText(LinearLayout layout, String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(16);
        layout.addView(view);
        return view;
    }

    private void arm() {
        armError = "";
        try {
            if (store.read() == null && notifications.allowed()) {
                notifications.ensureChannel();
                if ("available".equals(notifications.channelStatus())) {
                    schedule();
                }
            }
        } catch (IOException | RuntimeException failure) {
            armError = "Arming stopped. Check the saved evidence.";
            Log.e(AlarmReceiver.TAG, "Could not arm the native alarm.");
        }
        refresh();
    }

    private void schedule() throws IOException {
        AlarmManager alarms = getSystemService(AlarmManager.class);
        AlarmRun run = AlarmRun.start(UUID.randomUUID(), System.currentTimeMillis(), SystemClock.elapsedRealtime(),
                Process.myPid(), Process.getStartElapsedRealtime());
        store.write(run);
        Intent intent = new Intent(this, AlarmReceiver.class)
                .setAction(AlarmReceiver.ACTION)
                .setData(Uri.parse(run.identity()));
        PendingIntent operation = null;
        try {
            operation = PendingIntent.getBroadcast(this, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT);
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, run.dueElapsedMs(), operation);
            store.write(run.withArmStatus(AlarmRun.ArmStatus.ARMED));
        } catch (IOException | RuntimeException failure) {
            try {
                if (operation != null) {
                    operation.cancel();
                    alarms.cancel(operation);
                }
            } finally {
                store.write(run.withArmStatus(AlarmRun.ArmStatus.FAILED));
            }
            throw failure;
        }
    }

    private void refresh() {
        armButton.setEnabled(false);
        permissionButton.setVisibility(View.GONE);
        try {
            AlarmRun run = store.read();
            boolean allowed = notifications.allowed();
            String channel = notifications.channelStatus();
            settings.setText("Notification permission: " + (allowed ? "allowed" : "blocked")
                    + "\nNotification channel: " + channel);
            if (run == null) {
                status.setText("No test alarm armed.");
                evidence.setText(armError);
                if (notifications.runtimePermissionMissing()) {
                    permissionButton.setVisibility(View.VISIBLE);
                }
                armButton.setEnabled(armError.isEmpty() && allowed && !"blocked".equals(channel));
                return;
            }
            status.setText(switch (run.armStatus()) {
                case ARMING -> "Arming outcome uncertain.";
                case ARMED -> run.receipt() == null ? "Test alarm armed." : "Callback recorded.";
                case FAILED -> "Test alarm arming failed.";
            });
            evidence.setText(evidenceText(run));
        } catch (IOException | RuntimeException failure) {
            settings.setText("");
            status.setText("Could not read the saved alarm evidence.");
            evidence.setText("");
        }
    }

    private String evidenceText(AlarmRun run) {
        String text = "Run ID suffix: " + run.suffix() + "\nDue UTC: " + RunStore.utc(run.dueMs())
                + "\nCutoff UTC: " + RunStore.utc(run.cutoffMs());
        if (run.receipt() == null) {
            return text + "\nNo alarm callback recorded.";
        }
        AlarmRun.Callback callback = run.receipt().callback();
        return text + "\nCallback UTC: " + RunStore.utc(callback.atMs())
                + "\nResult: " + AlarmRun.label(run.receipt().result())
                + "\nKeyguard locked: " + callback.keyguardLocked()
                + "\nInteractive: " + callback.interactive()
                + "\nDevice idle: " + callback.idle()
                + "\nArming process: " + run.armedPid() + " (started at elapsed "
                + run.armedProcessStartElapsedMs() + " ms)"
                + "\nCallback process: " + callback.pid() + " (started at elapsed "
                + callback.processStartElapsedMs() + " ms)";
    }
}
