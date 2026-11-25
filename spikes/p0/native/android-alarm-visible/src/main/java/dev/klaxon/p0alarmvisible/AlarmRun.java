package dev.klaxon.p0alarmvisible;

import java.io.IOException;
import java.util.Locale;
import java.util.UUID;
import java.util.function.Supplier;

record AlarmRun(UUID runId, long armedAtMs, long armedElapsedMs, int armedPid,
                long armedProcessStartElapsedMs, ArmStatus armStatus, Receipt receipt) {
    static final int REVISION = 1;
    private static final long DELAY_MS = 120_000;
    private static final long DISPLAY_WINDOW_MS = 300_000;

    enum ArmStatus { ARMING, ARMED, FAILED }

    enum DisplayResult { UNCERTAIN, REQUESTED, PERMISSION_DENIED, CHANNEL_BLOCKED, FAILED, EXPIRED }

    record Callback(long atMs, long elapsedMs, int pid, long processStartElapsedMs,
                    boolean keyguardLocked, boolean interactive, boolean idle) {}

    record Receipt(Callback callback, DisplayResult result) {}

    @FunctionalInterface
    interface Save {
        void write(AlarmRun run) throws IOException;
    }

    static AlarmRun start(UUID runId, long armedAtMs, long armedElapsedMs, int armedPid,
                          long armedProcessStartElapsedMs) {
        return new AlarmRun(runId, armedAtMs, armedElapsedMs, armedPid, armedProcessStartElapsedMs,
                ArmStatus.ARMING, null);
    }

    String identity() {
        return "klaxon-p0-alarm-visible://run/" + runId + "/" + REVISION;
    }

    String suffix() {
        return runId.toString().substring(28);
    }

    long dueMs() {
        return armedAtMs + DELAY_MS;
    }

    long dueElapsedMs() {
        return armedElapsedMs + DELAY_MS;
    }

    long cutoffMs() {
        return dueMs() + DISPLAY_WINDOW_MS;
    }

    long cutoffElapsedMs() {
        return dueElapsedMs() + DISPLAY_WINDOW_MS;
    }

    boolean isExpired(long elapsedMs) {
        return elapsedMs > cutoffElapsedMs();
    }

    AlarmRun withArmStatus(ArmStatus status) {
        return new AlarmRun(runId, armedAtMs, armedElapsedMs, armedPid, armedProcessStartElapsedMs, status, receipt);
    }

    private AlarmRun withReceipt(Callback callback, DisplayResult result) {
        return new AlarmRun(runId, armedAtMs, armedElapsedMs, armedPid, armedProcessStartElapsedMs, armStatus,
                new Receipt(callback, result));
    }

    // The activity and receiver run serially on the application's main thread.
    void receive(String identity, Callback callback, Save save, Supplier<DisplayResult> request) throws IOException {
        if (armStatus != ArmStatus.ARMED || receipt != null || !identity().equals(identity)
                || callback.elapsedMs() < dueElapsedMs()) {
            return;
        }
        if (isExpired(callback.elapsedMs())) {
            save.write(withReceipt(callback, DisplayResult.EXPIRED));
            return;
        }
        // Claim this run on disk first. A crash here leaves an uncertain receipt and prevents a repeat.
        save.write(withReceipt(callback, DisplayResult.UNCERTAIN));
        save.write(withReceipt(callback, request.get()));
    }

    static String label(Enum<?> value) {
        return value.name().toLowerCase(Locale.ROOT).replace('_', '-');
    }
}
