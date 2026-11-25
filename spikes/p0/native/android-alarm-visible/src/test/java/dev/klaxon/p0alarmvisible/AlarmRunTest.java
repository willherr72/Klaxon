package dev.klaxon.p0alarmvisible;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public final class AlarmRunTest {
    private static final UUID RUN_ID = UUID.fromString("64449afa-bbe9-4b02-bccb-121291234abc");
    private static final String IDENTITY = "klaxon-p0-alarm-visible://run/64449afa-bbe9-4b02-bccb-121291234abc/1";
    private static final AlarmRun.Callback CALLBACK = new AlarmRun.Callback(
            1_800_000_120_700L, 121_000, 25, 200, true, false, true);

    public static void main(String[] args) throws IOException {
        AlarmRun arming = AlarmRun.start(RUN_ID, 1_800_000_000_000L, 300, 24, 100);
        require(arming.dueMs() == 1_800_000_120_000L, "due time must be 120 seconds after arming");
        require(arming.dueElapsedMs() == 120_300, "monotonic due time must be 120 seconds after arming");
        require(arming.cutoffMs() == 1_800_000_420_000L, "UTC cutoff must be five minutes after due time");
        require(!arming.isExpired(420_300), "the exact monotonic cutoff is still within the display window");
        require("91234abc".equals(arming.suffix()), "visible identification must use the final eight digits");
        ignore(arming, IDENTITY);

        AlarmRun armed = arming.withArmStatus(AlarmRun.ArmStatus.ARMED);
        ignore(armed, "klaxon-p0-alarm-visible://run/64449afa-bbe9-4b02-bccb-121291234abc/2");
        ignore(armed, "klaxon-p0-alarm-visible://run/84587582-2392-45d2-bbe2-833af870cafe/1");

        for (AlarmRun.DisplayResult result : List.of(AlarmRun.DisplayResult.REQUESTED,
                AlarmRun.DisplayResult.PERMISSION_DENIED, AlarmRun.DisplayResult.CHANNEL_BLOCKED,
                AlarmRun.DisplayResult.FAILED)) {
            List<AlarmRun> writes = new ArrayList<>();
            armed.receive(IDENTITY, CALLBACK, writes::add, () -> {
                require(writes.size() == 1, "claim must be saved before checking display");
                require(writes.get(0).receipt().result() == AlarmRun.DisplayResult.UNCERTAIN,
                        "a restart after claim must show an uncertain result");
                ignoreUnchecked(writes.get(0));
                return result;
            });
            require(writes.size() == 2, "claim and final receipt must each be saved once");
            require(result == writes.get(1).receipt().result(), "display result must survive reopen");
            require(CALLBACK.equals(writes.get(1).receipt().callback()), "callback evidence must survive reopen");
            ignore(writes.get(1), IDENTITY);
        }

        List<AlarmRun> expired = new ArrayList<>();
        AlarmRun.Callback late = new AlarmRun.Callback(1_800_000_120_000L, 420_301, 25, 200,
                true, false, true);
        armed.receive(IDENTITY, late, expired::add, () -> {
            throw new AssertionError("expiry must use elapsed time even when UTC is on time");
        });
        require(expired.size() == 1 && expired.get(0).receipt().result() == AlarmRun.DisplayResult.EXPIRED,
                "expired callback must leave a receipt");
        ignore(expired.get(0), IDENTITY);

        try {
            armed.receive(IDENTITY, CALLBACK, state -> { throw new IOException("claim failed"); }, () -> {
                throw new AssertionError("claim failure must block display");
            });
            throw new AssertionError("claim failure must be reported");
        } catch (IOException expected) {
            require("claim failed".equals(expected.getMessage()), "claim failure must propagate");
        }

        List<AlarmRun> saved = new ArrayList<>();
        try {
            armed.receive(IDENTITY, CALLBACK, state -> {
                if (!saved.isEmpty()) {
                    throw new IOException("final receipt failed");
                }
                saved.add(state);
            }, () -> AlarmRun.DisplayResult.REQUESTED);
            throw new AssertionError("receipt failure must be reported");
        } catch (IOException expected) {
            require("final receipt failed".equals(expected.getMessage()), "receipt failure must propagate");
        }
        require(saved.get(0).receipt().result() == AlarmRun.DisplayResult.UNCERTAIN,
                "display evidence must remain uncertain after receipt failure");
        ignore(saved.get(0), IDENTITY);
        System.out.println("Alarm run receipt tests passed.");
    }

    private static void ignore(AlarmRun run, String identity) throws IOException {
        run.receive(identity, CALLBACK, state -> { throw new AssertionError("unexpected state write"); }, () -> {
            throw new AssertionError("unexpected display request");
        });
    }

    private static void ignoreUnchecked(AlarmRun run) {
        try {
            ignore(run, IDENTITY);
        } catch (IOException failure) {
            throw new AssertionError(failure);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
