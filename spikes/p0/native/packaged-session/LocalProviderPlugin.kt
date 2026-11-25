package dev.klaxon.p0native

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import dev.klaxon.p0session.FixtureStore
import dev.klaxon.p0session.FixtureStore.SignOutState
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Debug-only session adapter for the isolated provider fixture. */
@TauriPlugin
class LocalProviderPlugin(private val host: Activity) : Plugin(host) {
    private companion object {
        const val LOOPBACK_ORIGIN = "http://127.0.0.1:3210"
        const val LOOPBACK_SLOT = "localprovider"
        const val MAX_INPUT_BYTES = 4096
        const val MAX_RECORD_BYTES = 16 * 1024
        const val RETRY = "retry-required"
        const val SIGNED_OUT = "signed-out"
        const val UNAVAILABLE = "unavailable"

        // Tauri dispatches on the UI thread. One bounded, process-wide queue owns all slot work.
        val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(4)) { run ->
            Thread(run, "p0-local-provider")
        }
        var revokeRequested = false
    }

    private class Failure(val status: String) : Exception()

    private data class StoredGrant(val owner: String, val subject: String, val refresh: String) {
        fun encode(): ByteArray = JSONObject().put("owner", owner).put("subject", subject)
            .put("refresh", refresh).toString().toByteArray(Charsets.UTF_8)
    }

    private data class Grant(val stored: StoredGrant, val access: String, val expiresAt: Long)
    private data class Active(val recordDigest: ByteArray, val access: String, val expiresAt: Long)

    // Access is process-local. The sealed slot holds only the owner, subject, and refresh token.
    private var active: Active? = null
    private val origin by lazy { providerOrigin() ?: fail(UNAVAILABLE) }
    private val slot by lazy {
        if (origin == LOOPBACK_ORIGIN) {
            LOOPBACK_SLOT
        } else {
            // Keep sealed refresh grants separate across provider builds of this Android app.
            val hash = digest(origin.toByteArray(Charsets.UTF_8)).joinToString("") {
                (it.toInt() and 0xff).toString(16).padStart(2, '0')
            }
            "localprovider-hosted-$hash"
        }
    }

    private external fun providerOrigin(): String?
    private external fun providerSignIn(input: ByteArray): Array<String>?
    private external fun providerRefresh(refresh: String): Array<String>?
    private external fun providerSignOut(refresh: String): Boolean

    private fun fail(status: String): Nothing = throw Failure(status)

    private fun consumeSignInInput(): ByteArray? {
        val path = File(host.cacheDir, "p0-local-input.json").toPath()
        if (Files.notExists(path, NOFOLLOW_LINKS)) return null
        val buffer = ByteArray(MAX_INPUT_BYTES + 1)
        try {
            require(Files.isRegularFile(path, NOFOLLOW_LINKS))
            return Files.newInputStream(path, NOFOLLOW_LINKS).use { file ->
                var size = 0
                while (size < buffer.size) {
                    val count = file.read(buffer, size, buffer.size - size)
                    if (count < 0) break
                    size += count
                }
                require(size in 1..MAX_INPUT_BYTES)
                buffer.copyOf(size)
            }
        } finally {
            buffer.fill(0)
            Files.deleteIfExists(path)
        }
    }

    private fun JSONObject.requiredText(key: String): String =
        (get(key) as? String)?.takeIf { it.isNotBlank() } ?: fail(UNAVAILABLE)

    private fun JSONObject.requiredSeconds(key: String): Long = when (val value = get(key)) {
        is Int -> value.toLong()
        is Long -> value
        else -> fail(UNAVAILABLE)
    }

    private fun storedGrant(bytes: ByteArray): StoredGrant {
        require(bytes.size in 1..MAX_RECORD_BYTES)
        val record = JSONObject(bytes.toString(Charsets.UTF_8))
        require(record.length() == 3)
        return StoredGrant(record.requiredText("owner"), record.requiredText("subject"), record.requiredText("refresh"))
    }

    private fun grant(reply: Array<String>?): Grant? {
        if (reply?.size == 1) {
            when (reply[0]) {
                "no-session" -> return null
                RETRY -> fail(RETRY)
            }
        }
        if (reply?.size != 4 || reply[0] != "grant") fail(UNAVAILABLE)
        val (_, access, refresh, owner) = reply
        require(access != refresh)
        val parts = access.split('.')
        require(parts.size == 3 && parts.all { part ->
            part.isNotEmpty() && part.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
        })
        // Convex verifies the signature. Bind this provider grant to its JWT session claims.
        val decoder = Base64.getUrlDecoder()
        val header = JSONObject(decoder.decode(parts[0]).toString(Charsets.UTF_8))
        require(header.requiredText("alg") != "none" && decoder.decode(parts[2]).isNotEmpty())
        val claims = JSONObject(decoder.decode(parts[1]).toString(Charsets.UTF_8))
        require(claims.requiredText("aud") == "convex-auth" && claims.requiredText("iss") == "$origin/components/auth")
        val issued = claims.requiredSeconds("iat")
        val expires = claims.requiredSeconds("exp")
        require(issued > 0 && expires > issued && expires > now())
        return Grant(StoredGrant(owner, claims.requiredText("sub"), refresh), access, expires)
    }

    private fun now(): Long = System.currentTimeMillis() / 1000

    private fun digest(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun publish(store: FixtureStore, grant: Grant, initial: Boolean): Active {
        val bytes = grant.stored.encode()
        try {
            require(bytes.size in 1..MAX_RECORD_BYTES)
            val next = Active(digest(bytes), grant.access, grant.expiresAt)
            if (initial) store.seed(slot, bytes) else store.rotate(slot, bytes)
            return next
        } finally {
            bytes.fill(0)
        }
    }

    private fun ensureOpen(store: FixtureStore) {
        if (revokeRequested) fail(RETRY)
        val state = try {
            store.signOutState(slot)
        } catch (_: Exception) {
            fail(RETRY)
        }
        if (state != null) fail(RETRY)
    }

    @Command
    fun signIn(invoke: Invoke) = dispatch(invoke) {
        val input = consumeSignInInput()
        try {
            val store = FixtureStore(host)
            ensureOpen(store)
            require(store.recoverUnpublishedSeed(slot))
            active = null
            val granted = grant(providerSignIn(input ?: fail(UNAVAILABLE))) ?: fail(UNAVAILABLE)
            active = publish(store, granted, initial = true)
            arrayOf("fixture-ready")
        } finally {
            input?.fill(0)
        }
    }

    @Command
    fun resume(invoke: Invoke) = dispatch(invoke) {
        active = null
        val store = FixtureStore(host)
        if (store.signOutState(slot) == SignOutState.ACKNOWLEDGED) {
            store.finishSignOut(slot)
            revokeRequested = false
            fail(SIGNED_OUT)
        }
        ensureOpen(store)
        if (store.recoverUnpublishedSeed(slot)) fail(SIGNED_OUT)
        active = refresh(store, readStored(store.read(slot)))
        arrayOf("authenticated")
    }

    private fun refresh(store: FixtureStore, current: StoredGrant): Active {
        val next = grant(providerRefresh(current.refresh))
        if (next == null) {
            store.persistSignOutState(slot, SignOutState.ACKNOWLEDGED)
            store.finishSignOut(slot)
            require(store.inventory(slot) == "no-key/no-file")
            fail(SIGNED_OUT)
        }
        require(next.stored.owner == current.owner && next.stored.subject == current.subject &&
            next.stored.refresh != current.refresh && next.access != current.refresh)
        return publish(store, next, initial = false)
    }

    @Command
    fun access(invoke: Invoke) = accessGrant(invoke, forceRefresh = false)

    @Command
    fun refreshAccess(invoke: Invoke) = accessGrant(invoke, forceRefresh = true)

    private fun accessGrant(invoke: Invoke, forceRefresh: Boolean) = dispatch(invoke) {
        val store = FixtureStore(host)
        ensureOpen(store)
        val current = active ?: fail(SIGNED_OUT)
        active = null
        if (!forceRefresh && current.expiresAt <= now()) fail(SIGNED_OUT)
        val bytes = store.read(slot) ?: fail(UNAVAILABLE)
        val stored = try {
            require(digest(bytes).contentEquals(current.recordDigest))
            if (forceRefresh) storedGrant(bytes) else null
        } finally {
            bytes.fill(0)
        }
        val next = if (stored != null) refresh(store, stored) else current
        active = next
        arrayOf("access", next.access)
    }

    @Command
    fun revoke(invoke: Invoke) = dispatch(invoke, RETRY) {
        active = null
        revokeRequested = true
        val store = FixtureStore(host)
        val state = store.signOutState(slot)
        if (state == null && store.recoverUnpublishedSeed(slot)) {
            revokeRequested = false
            fail(SIGNED_OUT)
        }
        if (state != SignOutState.ACKNOWLEDGED) {
            store.persistSignOutState(slot, SignOutState.PENDING)
            val current = readStored(store.readForSignOut(slot))
            if (!providerSignOut(current.refresh)) fail(RETRY)
            // The same persisted token must receive a definitive noSession before key deletion.
            if (!(providerRefresh(current.refresh)?.contentEquals(arrayOf("no-session")) ?: false)) fail(RETRY)
            store.persistSignOutState(slot, SignOutState.ACKNOWLEDGED)
        }
        store.finishSignOut(slot)
        require(store.inventory(slot) == "no-key/no-file")
        revokeRequested = false
        arrayOf("revoked")
    }

    private fun readStored(bytes: ByteArray?): StoredGrant {
        requireNotNull(bytes)
        return try {
            storedGrant(bytes)
        } finally {
            bytes.fill(0)
        }
    }

    private fun dispatch(invoke: Invoke, onFailure: String = UNAVAILABLE, operation: () -> Array<String>) {
        try {
            worker.execute {
                val reply = try {
                    operation()
                } catch (failure: Failure) {
                    arrayOf(failure.status)
                } catch (_: Exception) {
                    arrayOf(onFailure)
                }
                invoke.resolveObject(reply)
            }
        } catch (_: RejectedExecutionException) {
            invoke.resolveObject(arrayOf(RETRY))
        }
    }
}
