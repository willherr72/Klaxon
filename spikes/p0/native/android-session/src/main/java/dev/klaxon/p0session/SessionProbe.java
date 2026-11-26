package dev.klaxon.p0session;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.Process;
import java.util.Arrays;

/** Self-instrumenting offline fixture. No caller-supplied token or key material. */
public final class SessionProbe extends Instrumentation {
    private Bundle args;
    private FixtureStore store;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        args = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            store = new FixtureStore(getTargetContext());
            String owner = args.getString("owner");
            if (!"alpha".equals(owner) && !"beta".equals(owner)) throw new IllegalArgumentException();
            result.putString("outcome", exercise(owner));
            result.putString("alpha", store.inventory("alpha"));
            result.putString("beta", store.inventory("beta"));
            result.putString("workerPid", Integer.toString(Process.myPid()));
            finish(Activity.RESULT_OK, result);
        } catch (Exception e) {
            result.putString("failure", e.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private String exercise(String owner) throws Exception {
        String operation = args.getString("operation");
        switch (operation) {
            case "inspect": return "inspected";
            case "sign-out":
                store.forget(owner);
                return "signed-out";
            case "sign-in":
                store.seed(owner);
                return "stored";
            case "resume": break;
            default: throw new IllegalArgumentException();
        }
        if (!store.hasRecord(owner)) return "sign-in-required";
        byte[] plaintext = store.read(owner);
        if (plaintext == null) return "storage-unavailable";

        // Only this decision simulates the provider. Storage and cryptography run on Android.
        int expected = Integer.parseInt(args.getString("generation"));
        if (expected < 1 || expected > 3) throw new IllegalArgumentException();
        switch (args.getString("response")) {
            case "unavailable": return "retry-required";
            case "expired": break;
            case "grant":
                if (Arrays.equals(plaintext, store.marker(owner, expected))) {
                    store.rotate(owner, expected + 1);
                    return "authenticated";
                }
                break;
            default: throw new IllegalArgumentException();
        }
        store.forget(owner);
        return "sign-in-required";
    }
}
