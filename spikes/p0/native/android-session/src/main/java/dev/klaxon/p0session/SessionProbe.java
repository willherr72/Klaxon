package dev.klaxon.p0session;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.Process;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Self-instrumenting offline fixture. No caller-supplied token or key material. */
public final class SessionProbe extends Instrumentation {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final int IV_BYTES = 12;
    private Bundle args;
    private KeyStore store;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        args = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            store = KeyStore.getInstance(PROVIDER);
            store.load(null);
            String owner = args.getString("owner");
            if (!"alpha".equals(owner) && !"beta".equals(owner)) throw new IllegalArgumentException();
            result.putString("outcome", exercise(owner));
            result.putString("alpha", inventory("alpha"));
            result.putString("beta", inventory("beta"));
            result.putString("workerPid", Integer.toString(Process.myPid()));
            finish(Activity.RESULT_OK, result);
        } catch (Exception e) {
            result.putString("failure", e.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private String alias(String owner) { return "dev.klaxon.p0session.v1." + owner; }
    private File slot(String owner) { return new File(getTargetContext().getNoBackupFilesDir(), owner + ".bin"); }
    private byte[] marker(String owner, int generation) {
        return ("KLAXON-P0-INERT/" + owner + "/" + generation).getBytes(StandardCharsets.UTF_8);
    }

    private String inventory(String owner) throws GeneralSecurityException {
        return (store.containsAlias(alias(owner)) ? "key" : "no-key") + "/"
            + (slot(owner).exists() ? "file" : "no-file");
    }

    private void forget(String owner) throws GeneralSecurityException, IOException {
        store.deleteEntry(alias(owner));
        Files.deleteIfExists(slot(owner).toPath());
    }

    private void save(String owner, SecretKey key, int generation) throws Exception {
        if (key.getEncoded() != null) throw new IllegalStateException("Expected a non-exportable key");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv.length != IV_BYTES) throw new GeneralSecurityException("Unexpected IV length");
        byte[] sealed = cipher.doFinal(marker(owner, generation));
        AtomicFile file = new AtomicFile(slot(owner));
        FileOutputStream out = file.startWrite();
        try {
            out.write(iv);
            out.write(sealed);
            file.finishWrite(out);
        } catch (IOException e) {
            file.failWrite(out);
            throw e;
        }
    }

    private String exercise(String owner) throws Exception {
        String operation = args.getString("operation");
        switch (operation) {
            case "inspect": return "inspected";
            case "sign-out":
                forget(owner);
                return "signed-out";
            case "sign-in":
                if (store.containsAlias(alias(owner)) || slot(owner).exists()) {
                    throw new IllegalStateException("Clear the previous fixture before signing in");
                }
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
                generator.init(new KeyGenParameterSpec.Builder(alias(owner),
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
                save(owner, generator.generateKey(), 1);
                return "stored";
            case "resume": break;
            default: throw new IllegalArgumentException();
        }
        if (!slot(owner).exists()) return "sign-in-required";
        SecretKey key = (SecretKey) store.getKey(alias(owner), null);
        if (key == null) return "storage-unavailable";
        byte[] record = Files.readAllBytes(slot(owner).toPath());
        if (record.length < IV_BYTES + 16) return "storage-unavailable";
        byte[] plaintext;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, record, 0, IV_BYTES));
            plaintext = cipher.doFinal(record, IV_BYTES, record.length - IV_BYTES);
        } catch (GeneralSecurityException e) {
            return "storage-unavailable";
        }

        // Only this decision simulates the provider. Storage and cryptography run on Android.
        int expected = Integer.parseInt(args.getString("generation"));
        if (expected < 1 || expected > 3) throw new IllegalArgumentException();
        switch (args.getString("response")) {
            case "unavailable": return "retry-required";
            case "expired": break;
            case "grant":
                if (Arrays.equals(plaintext, marker(owner, expected))) {
                    save(owner, key, expected + 1);
                    return "authenticated";
                }
                break;
            default: throw new IllegalArgumentException();
        }
        forget(owner);
        return "sign-in-required";
    }
}
