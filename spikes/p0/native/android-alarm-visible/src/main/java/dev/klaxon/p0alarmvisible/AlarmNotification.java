package dev.klaxon.p0alarmvisible;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;

final class AlarmNotification {
    private static final String CHANNEL_ID = "p0-native-reminder";
    private static final int NOTIFICATION_ID = 1;

    private final Context context;
    private final NotificationManager manager;

    AlarmNotification(Context context) {
        this.context = context;
        manager = context.getSystemService(NotificationManager.class);
    }

    boolean runtimePermissionMissing() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
    }

    boolean allowed() {
        return !runtimePermissionMissing() && manager.areNotificationsEnabled();
    }

    void ensureChannel() {
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "P0 native reminder",
                    NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    String channelStatus() {
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel == null) {
            return "not created";
        }
        return channel.getImportance() == NotificationManager.IMPORTANCE_NONE ? "blocked" : "available";
    }

    AlarmRun.DisplayResult request(AlarmRun run) {
        try {
            if (!allowed()) {
                return AlarmRun.DisplayResult.PERMISSION_DENIED;
            }
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
            if (channel == null) {
                return AlarmRun.DisplayResult.FAILED;
            }
            if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                return AlarmRun.DisplayResult.CHANNEL_BLOCKED;
            }
            Notification notification = new Notification.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Klaxon P0 native test · " + run.suffix())
                    .setContentText("Pre-armed reminder")
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .build();
            if (run.isExpired(SystemClock.elapsedRealtime())) {
                return AlarmRun.DisplayResult.EXPIRED;
            }
            manager.notify(NOTIFICATION_ID, notification);
            return AlarmRun.DisplayResult.REQUESTED;
        } catch (RuntimeException failure) {
            return AlarmRun.DisplayResult.FAILED;
        }
    }
}
