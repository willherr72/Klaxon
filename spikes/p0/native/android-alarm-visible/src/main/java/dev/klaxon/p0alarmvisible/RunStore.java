package dev.klaxon.p0alarmvisible;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

final class RunStore {
    private final File directory;
    private final File state;

    RunStore(Context context) {
        directory = context.getNoBackupFilesDir();
        state = new File(directory, "run.json");
    }

    AlarmRun read() throws IOException {
        try {
            JSONObject json = new JSONObject(new String(Files.readAllBytes(state.toPath()), StandardCharsets.UTF_8));
            UUID runId = UUID.fromString(json.getString("runId"));
            if (runId.version() != 4 || runId.variant() != 2 || !runId.toString().equals(json.getString("runId"))
                    || json.getInt("revision") != AlarmRun.REVISION || !json.has("receipt")) {
                throw new IOException("Unrecognized alarm identity");
            }
            AlarmRun.Receipt receipt = null;
            if (!json.isNull("receipt")) {
                JSONObject row = json.getJSONObject("receipt");
                AlarmRun.Callback callback = new AlarmRun.Callback(row.getLong("callbackAtMs"),
                        row.getLong("callbackElapsedMs"), row.getInt("pid"), row.getLong("processStartElapsedMs"),
                        row.getBoolean("keyguardLocked"), row.getBoolean("interactive"), row.getBoolean("idle"));
                receipt = new AlarmRun.Receipt(callback, parse(AlarmRun.DisplayResult.class, row.getString("result")));
            }
            return new AlarmRun(runId, json.getLong("armedAtMs"), json.getLong("armedElapsedMs"),
                    json.getInt("armedPid"), json.getLong("armedProcessStartElapsedMs"),
                    parse(AlarmRun.ArmStatus.class, json.getString("armStatus")), receipt);
        } catch (NoSuchFileException unarmed) {
            return null;
        } catch (JSONException | IllegalArgumentException invalid) {
            throw new IOException("Invalid alarm evidence", invalid);
        }
    }

    void write(AlarmRun run) throws IOException {
        File pending = new File(directory, "run.json.tmp");
        try {
            byte[] bytes = (encode(run) + "\n").getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(pending)) {
                output.write(bytes);
                output.getFD().sync();
            }
            Os.rename(pending.getPath(), state.getPath());
            FileDescriptor directoryFd = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
            try {
                Os.fsync(directoryFd);
            } finally {
                Os.close(directoryFd);
            }
        } catch (ErrnoException | JSONException failure) {
            throw new IOException("Could not save alarm evidence", failure);
        }
    }

    static String utc(long timeMs) {
        return Instant.ofEpochMilli(timeMs).toString();
    }

    private static JSONObject encode(AlarmRun run) throws JSONException {
        AlarmRun.Receipt receipt = run.receipt();
        JSONObject json = new JSONObject()
                .put("runId", run.runId().toString())
                .put("revision", AlarmRun.REVISION)
                .put("mode", "inexact")
                .put("armStatus", AlarmRun.label(run.armStatus()))
                .put("armedAtMs", run.armedAtMs())
                .put("armedUtc", utc(run.armedAtMs()))
                .put("armedElapsedMs", run.armedElapsedMs())
                .put("dueMs", run.dueMs())
                .put("dueUtc", utc(run.dueMs()))
                .put("dueElapsedMs", run.dueElapsedMs())
                .put("cutoffMs", run.cutoffMs())
                .put("cutoffUtc", utc(run.cutoffMs()))
                .put("cutoffElapsedMs", run.cutoffElapsedMs())
                .put("armedPid", run.armedPid())
                .put("armedProcessStartElapsedMs", run.armedProcessStartElapsedMs());
        if (receipt == null) {
            return json.put("receipt", JSONObject.NULL);
        }
        AlarmRun.Callback callback = receipt.callback();
        return json.put("receipt", new JSONObject()
                .put("result", AlarmRun.label(receipt.result()))
                .put("callbackAtMs", callback.atMs())
                .put("callbackUtc", utc(callback.atMs()))
                .put("callbackElapsedMs", callback.elapsedMs())
                .put("pid", callback.pid())
                .put("processStartElapsedMs", callback.processStartElapsedMs())
                .put("keyguardLocked", callback.keyguardLocked())
                .put("interactive", callback.interactive())
                .put("idle", callback.idle()));
    }

    private static <T extends Enum<T>> T parse(Class<T> type, String value) {
        return Enum.valueOf(type, value.toUpperCase(Locale.ROOT).replace('-', '_'));
    }
}
