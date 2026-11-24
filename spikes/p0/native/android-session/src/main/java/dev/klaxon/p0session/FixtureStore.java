package dev.klaxon.p0session;

import android.content.Context;
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
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class FixtureStore {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final int IV_BYTES = 12;
    private final Context context;
    private final KeyStore store;

    public FixtureStore(Context context) throws Exception {
        this.context = context;
        store = KeyStore.getInstance(PROVIDER);
        store.load(null);
    }

    private String alias(String owner) { return context.getPackageName() + ".v1." + owner; }
    private File slot(String owner) { return new File(context.getNoBackupFilesDir(), owner + ".bin"); }
    public boolean hasRecord(String owner) { return slot(owner).exists(); }
    public byte[] marker(String owner, int generation) {
        return ("KLAXON-P0-INERT/" + owner + "/" + generation).getBytes(StandardCharsets.UTF_8);
    }

    public String inventory(String owner) throws GeneralSecurityException {
        return (store.containsAlias(alias(owner)) ? "key" : "no-key") + "/"
            + (slot(owner).exists() ? "file" : "no-file");
    }

    public void forget(String owner) throws GeneralSecurityException, IOException {
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

    public void seed(String owner) throws Exception {
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
    }

    public void rotate(String owner, int generation) throws Exception {
        save(owner, (SecretKey) store.getKey(alias(owner), null), generation);
    }

    /** Null means the protected marker could not be read. Callers decide session status. */
    public byte[] read(String owner) throws Exception {
        SecretKey key = (SecretKey) store.getKey(alias(owner), null);
        if (key == null) return null;
        byte[] record = Files.readAllBytes(slot(owner).toPath());
        if (record.length < IV_BYTES + 16) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, record, 0, IV_BYTES));
            return cipher.doFinal(record, IV_BYTES, record.length - IV_BYTES);
        } catch (GeneralSecurityException e) {
            return null;
        }
    }
}
