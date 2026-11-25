package dev.klaxon.p0session;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class FixtureStore {
    public enum PublishBoundary { BEFORE_PUBLISH, AFTER_PUBLISH }
    public enum SignOutState {
        PENDING("pending"), ACKNOWLEDGED("acknowledged");

        private final byte[] bytes;

        SignOutState(String text) {
            bytes = text.getBytes(StandardCharsets.US_ASCII);
        }
    }

    @FunctionalInterface
    public interface PublishCheckpoint {
        void reached(PublishBoundary boundary) throws IOException;
    }

    private static final String PROVIDER = "AndroidKeyStore";
    private static final int IV_BYTES = 12;
    private final Context context;
    private final KeyStore store;
    private final PublishCheckpoint checkpoint;

    public FixtureStore(Context context) throws Exception {
        this(context, boundary -> {});
    }

    public FixtureStore(Context context, PublishCheckpoint checkpoint) throws Exception {
        this.context = context;
        this.checkpoint = checkpoint;
        store = KeyStore.getInstance(PROVIDER);
        store.load(null);
    }

    private String alias(String owner) { return context.getPackageName() + ".v1." + owner; }
    private File slot(String owner) { return new File(context.getNoBackupFilesDir(), owner + ".bin"); }
    public boolean hasRecord(String owner) { return slot(owner).exists(); }

    // A killed initial writer can leave a key and .new before AtomicFile publishes.
    // Keep any published or recoverable record, including a legacy AtomicFile backup.
    public boolean recoverUnpublishedSeed(String owner) throws Exception {
        Path record = slot(owner).toPath();
        Path backup = record.resolveSibling(record.getFileName() + ".bak");
        if (!Files.notExists(record, LinkOption.NOFOLLOW_LINKS)
            || !Files.notExists(backup, LinkOption.NOFOLLOW_LINKS)) return false;
        Path stage = record.resolveSibling(record.getFileName() + ".new");
        if (!Files.notExists(stage, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(stage, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("Unexpected staging file");
            }
            Files.delete(stage);
        }
        if (store.containsAlias(alias(owner))) store.deleteEntry(alias(owner));
        return true;
    }

    public byte[] marker(String owner, int generation) {
        return ("KLAXON-P0-INERT/" + owner + "/" + generation).getBytes(StandardCharsets.UTF_8);
    }

    public String inventory(String owner) throws GeneralSecurityException {
        return (store.containsAlias(alias(owner)) ? "key" : "no-key") + "/"
            + (slot(owner).exists() ? "file" : "no-file");
    }

    public void forget(String owner) throws GeneralSecurityException, IOException {
        store.deleteEntry(alias(owner));
        File file = slot(owner);
        Files.deleteIfExists(file.toPath());
        Files.deleteIfExists(file.toPath().resolveSibling(file.getName() + ".new"));
        Files.deleteIfExists(file.toPath().resolveSibling(file.getName() + ".bak"));
    }

    private Path signOutPath(String owner) {
        return new File(context.getNoBackupFilesDir(), owner + ".signout").toPath();
    }

    private Path signOutStage(Path path) {
        return path.resolveSibling(path.getFileName() + ".new");
    }

    private boolean regularFileOrAbsent(Path path) throws IOException {
        if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return true;
        if (Files.notExists(path, LinkOption.NOFOLLOW_LINKS)) return false;
        throw new IOException("Unexpected fixture file");
    }

    // The packaged plugin serializes operations on this slot. A writer killed before the first
    // rename may leave just the stage, which reserves the slot until sign-out is retried.
    public SignOutState signOutState(String owner) throws IOException {
        Path path = signOutPath(owner);
        boolean staged = regularFileOrAbsent(signOutStage(path));
        if (!regularFileOrAbsent(path)) return staged ? SignOutState.PENDING : null;
        if (Files.size(path) > SignOutState.ACKNOWLEDGED.bytes.length) {
            throw new IOException("Invalid sign-out state");
        }
        byte[] bytes = Files.readAllBytes(path);
        for (SignOutState state : SignOutState.values()) {
            if (Arrays.equals(bytes, state.bytes)) return state;
        }
        throw new IOException("Invalid sign-out state");
    }

    public void persistSignOutState(String owner, SignOutState state) throws Exception {
        Path path = signOutPath(owner);
        Path stage = signOutStage(path);
        // Keep an existing stage in place until rename so an orphaned initial intent always
        // blocks access, even if another process death interrupts the retry.
        try (FileChannel out = FileChannel.open(stage, StandardOpenOption.CREATE,
            StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer data = ByteBuffer.wrap(state.bytes);
            while (data.hasRemaining()) out.write(data);
            out.force(true);
        }
        Files.move(stage, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        syncNoBackupDirectory();
    }

    public void finishSignOut(String owner) throws Exception {
        if (signOutState(owner) != SignOutState.ACKNOWLEDGED) {
            throw new IOException("Missing sign-out acknowledgment");
        }
        // A previously visible rename may have failed its directory sync. Require durability
        // before touching the key or ciphertext, and make their removal durable before clearing intent.
        syncNoBackupDirectory();
        forget(owner);
        if (store.containsAlias(alias(owner))) throw new IOException("Fixture key was not removed");
        Files.deleteIfExists(signOutStage(signOutPath(owner)));
        syncNoBackupDirectory();
        Files.delete(signOutPath(owner));
        syncNoBackupDirectory();
    }

    private void syncNoBackupDirectory() throws Exception {
        FileDescriptor directory = Os.open(context.getNoBackupFilesDir().getAbsolutePath(),
            OsConstants.O_RDONLY | OsConstants.O_CLOEXEC, 0);
        try {
            Os.fsync(directory);
        } finally {
            Os.close(directory);
        }
    }

    private void save(String owner, SecretKey key, byte[] plaintext) throws Exception {
        if (key.getEncoded() != null) throw new IllegalStateException("Expected a non-exportable key");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv.length != IV_BYTES) throw new GeneralSecurityException("Unexpected IV length");
        byte[] sealed = cipher.doFinal(plaintext);
        byte[] record = Arrays.copyOf(iv, iv.length + sealed.length);
        System.arraycopy(sealed, 0, record, iv.length, sealed.length);
        AtomicFile file = new AtomicFile(slot(owner));
        FileOutputStream out = file.startWrite();
        try {
            out.write(record);
            out.getFD().sync();
            // Only the disposable fixture can set this flag. Exercise AtomicFile's logged-only rename failure.
            if (new File(context.getCacheDir(), "p0-discard-synced-stage").isFile()) {
                Files.delete(slot(owner).toPath().resolveSibling(slot(owner).getName() + ".new"));
            }
            checkpoint.reached(PublishBoundary.BEFORE_PUBLISH);
        } catch (IOException | RuntimeException e) {
            file.failWrite(out);
            throw e;
        }
        file.finishWrite(out);
        // AtomicFile logs publish failures. Require the new ciphertext to be visible before returning.
        if (!Arrays.equals(file.readFully(), record)) throw new IOException("Protected record was not published");
        checkpoint.reached(PublishBoundary.AFTER_PUBLISH);
    }

    public void seed(String owner) throws Exception {
        seed(owner, marker(owner, 1));
    }

    public void seed(String owner, byte[] marker) throws Exception {
        String keyAlias = alias(owner);
        Path record = slot(owner).toPath();
        Path stage = record.resolveSibling(record.getFileName() + ".new");
        Path backup = record.resolveSibling(record.getFileName() + ".bak");
        if (store.containsAlias(keyAlias)
            || !Files.notExists(record, LinkOption.NOFOLLOW_LINKS)
            || !Files.notExists(stage, LinkOption.NOFOLLOW_LINKS)
            || !Files.notExists(backup, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalStateException("Clear the previous fixture before signing in");
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        generator.init(new KeyGenParameterSpec.Builder(keyAlias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build());
        try {
            save(owner, generator.generateKey(), marker);
        } catch (Exception failure) {
            // The slot was empty before this write. Roll back only its new files and key.
            for (Path path : new Path[] {stage, record}) {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception cleanupFailure) {
                    failure.addSuppressed(cleanupFailure);
                }
            }
            try {
                store.deleteEntry(keyAlias);
            } catch (Exception cleanupFailure) {
                failure.addSuppressed(cleanupFailure);
            }
            throw failure;
        }
    }

    public void rotate(String owner, int generation) throws Exception {
        rotate(owner, marker(owner, generation));
    }

    public void rotate(String owner, byte[] successor) throws Exception {
        SecretKey key = (SecretKey) store.getKey(alias(owner), null);
        if (key == null) throw new GeneralSecurityException("Missing fixture key");
        save(owner, key, successor);
    }

    /** Null means the protected marker could not be read. Callers decide session status. */
    public byte[] read(String owner) throws Exception {
        SecretKey key = (SecretKey) store.getKey(alias(owner), null);
        if (key == null) return null;
        return decrypt(key, new AtomicFile(slot(owner)).readFully());
    }

    /** Read the published token without AtomicFile's recovery writes during pending sign-out. */
    public byte[] readForSignOut(String owner) throws Exception {
        SecretKey key = (SecretKey) store.getKey(alias(owner), null);
        if (key == null) return null;
        Path record = slot(owner).toPath();
        Path backup = record.resolveSibling(record.getFileName() + ".bak");
        Path published = regularFileOrAbsent(backup) ? backup : record;
        return regularFileOrAbsent(published) ? decrypt(key, Files.readAllBytes(published)) : null;
    }

    private byte[] decrypt(SecretKey key, byte[] record) {
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
