package dev.klaxon.p0alarmvisible;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.io.IOException;

public final class AlarmReceiver extends BroadcastReceiver {
    static final String ACTION = "dev.klaxon.p0alarmvisible.FIXTURE_ALARM";
    static final String TAG = "KlaxonP0NativeAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        long callbackAtMs = System.currentTimeMillis();
        long callbackElapsedMs = SystemClock.elapsedRealtime();
        if (!ACTION.equals(intent.getAction())) {
            return;
        }
        try {
            RunStore store = new RunStore(context);
            AlarmRun run = store.read();
            if (run == null) {
                return;
            }
            PowerManager power = context.getSystemService(PowerManager.class);
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            AlarmRun.Callback callback = new AlarmRun.Callback(callbackAtMs, callbackElapsedMs, Process.myPid(),
                    Process.getStartElapsedRealtime(), keyguard.isKeyguardLocked(), power.isInteractive(),
                    power.isDeviceIdleMode());
            run.receive(intent.getDataString(), callback, store::write,
                    () -> new AlarmNotification(context).request(run));
        } catch (IOException | RuntimeException failure) {
            Log.e(TAG, "Could not record the native alarm callback.");
        }
    }
}
