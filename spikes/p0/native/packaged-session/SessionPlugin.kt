package dev.klaxon.p0native

import android.app.Activity
import android.os.Process
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import dev.klaxon.p0session.FixtureStore
import dev.klaxon.p0session.FixtureStore.PublishBoundary
import dev.klaxon.p0session.FixtureStore.SignOutState
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption

// JWT-shaped fixture value for the SDK's refresh state machine, with a fake signature.
private const val ROTATED_OWNER_A_ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0." +
    "cDAtbm90LWEtc2lnbmF0dXJl"

/** Available only in the offline x86_64 session fixture. The WebView has no marker API. */
@TauriPlugin
class SessionPlugin(private val host: Activity) : Plugin(host) {
    private companion object {
        val sessionLock = Any()
        var signOutRequested = false
    }

    private enum class RefreshPause(val flag: String, val boundary: PublishBoundary) {
        BEFORE("refresh-pause-before-publish", PublishBoundary.BEFORE_PUBLISH),
        AFTER("refresh-pause-after-publish", PublishBoundary.AFTER_PUBLISH),
    }

    private enum class Owner(val id: String, val generation: Int, val access: String) {
        A("p0-fixture-owner-a", 1, "p0-inert-access-a"),
        B("p0-fixture-owner-b", 2, "p0-inert-access-b"),
    }

    private sealed interface Confirmation {
        data class Granted(val owner: Owner, val access: String) : Confirmation
        data class Denied(val status: String) : Confirmation
    }

    private data class SignOutReply(val status: Int, val body: String)

    private val slot = "packaged"
    private var activeOwner: Owner? = null

    private external fun decodeRefresh(body: String): Array<String>?
    private external fun decodeSignIn(body: String, expectedOwner: String): Array<String>?
    private external fun acknowledgedSignOut(httpStatus: Int, body: String): Boolean

    private fun providerFlag(name: String) = File(host.cacheDir, "p0-$name").isFile

    // In-process response for the pinned Convex auth:signInWithUsernamePassword mutation.
    private fun signInResponse(store: FixtureStore, requested: Owner): String {
        if (providerFlag("signin-denied")) {
            return """{"status":"success","value":{
                "status":"error","userError":{"error":"INVALID_CREDENTIALS"}
            }}"""
        }
        val issuedId = if (providerFlag("signin-owner-mismatch")) {
            Owner.entries.first { it != requested }.id
        } else requested.id
        val refresh = store.marker(slot, requested.generation).toString(Charsets.UTF_8)
        return """{"status":"success","value":{"status":"complete","tokens":{
            "accessToken":"${requested.access}",
            "refreshToken":"$refresh",
            "refreshTokenExpiresAt":4102444800000,
            "userId":"$issuedId"
        }}}"""
    }

    private fun seed(store: FixtureStore, requested: Owner): String {
        val (access, refresh) = decodeSignIn(signInResponse(store, requested), requested.id) ?: return "unavailable"
        val marker = refresh.toByteArray(Charsets.UTF_8)
        if (access != requested.access || !marker.contentEquals(store.marker(slot, requested.generation))) {
            return "unavailable"
        }
        store.recoverUnpublishedSeed(slot)
        store.seed(slot, marker)
        return "fixture-ready"
    }

    private fun clearSession(store: FixtureStore): String {
        store.forget(slot)
        return if (store.inventory(slot) == "no-key/no-file") "signed-out" else "unavailable"
    }

    private fun signOutBlocked(store: FixtureStore): Boolean {
        // Also fail closed in this process if storage failed before publishing the first intent.
        if (signOutRequested) return true
        return try {
            store.signOutState(slot) != null
        } catch (_: Exception) {
            true
        }
    }

    private fun signOutFlag(name: String): Boolean {
        val path = File(host.cacheDir, "p0-$name").toPath()
        if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return true
        if (Files.notExists(path, LinkOption.NOFOLLOW_LINKS)) return false
        throw IOException("Unexpected sign-out fixture flag")
    }

    private fun recordIssuerRevocation() {
        val receipt = File(host.cacheDir, "p0-issuer-revoked-successor").toPath()
        try {
            FileChannel.open(receipt, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use {
                it.force(true)
            }
        } catch (e: FileAlreadyExistsException) {
            if (!Files.isRegularFile(receipt, LinkOption.NOFOLLOW_LINKS) || Files.size(receipt) != 0L) {
                throw e
            }
        }
    }

    private fun signOutResponse(store: FixtureStore, request: JSONObject): SignOutReply? {
        if (signOutFlag("provider-offline")) return null
        val args = request.getJSONArray("args")
        val token = args.getJSONObject(0).getString("refreshToken")
        val successor = token == store.marker(slot, 3).toString(Charsets.UTF_8)
        val knownToken = successor || Owner.entries.any {
            token == store.marker(slot, it.generation).toString(Charsets.UTF_8)
        }
        val dropReply = signOutFlag("signout-drop-reply")
        val observeSuccessor = dropReply || signOutFlag("signout-expect-successor")
        if (request.getString("path") != "auth:signOut" ||
            request.getString("format") != "convex_encoded_json" ||
            args.length() != 1 || args.getJSONObject(0).length() != 1 ||
            !knownToken || (observeSuccessor && !successor)) {
            return SignOutReply(560, """{"status":"error","errorMessage":"Fixture rejected sign-out","logLines":[]}""")
        }
        if (observeSuccessor) recordIssuerRevocation()
        if (dropReply) return null
        if (signOutFlag("signout-invalid-reply")) {
            return SignOutReply(200, """{"status":"success","value":[]}""")
        }
        if (observeSuccessor) {
            try {
                File(host.cacheDir, "p0-issuer-acknowledged-successor").createNewFile()
            } catch (_: IOException) {
                // The optional observer does not change the issuer's acknowledgment.
            }
        }
        return SignOutReply(200, """{"status":"success","value":null,"logLines":[]}""")
    }

    private fun signOut(store: FixtureStore, pauseBeforeCleanup: Boolean): String {
        val state = store.signOutState(slot)
        if (state != SignOutState.ACKNOWLEDGED) {
            if (state == null && store.recoverUnpublishedSeed(slot)) return "signed-out"
            store.persistSignOutState(slot, SignOutState.PENDING)
            val marker = store.readForSignOut(slot) ?: return "retry-required"
            // Convex's pinned mutation request carries the currently persisted token.
            val request = JSONObject()
                .put("path", "auth:signOut")
                .put("format", "convex_encoded_json")
                .put("args", JSONArray().put(JSONObject().put("refreshToken", marker.toString(Charsets.UTF_8))))
            val reply = signOutResponse(store, request) ?: return "retry-required"
            if (!acknowledgedSignOut(reply.status, reply.body)) return "retry-required"
            store.persistSignOutState(slot, SignOutState.ACKNOWLEDGED)
            if (pauseBeforeCleanup) awaitCheckpoint("signout-pause-before-cleanup")
        }
        store.finishSignOut(slot)
        return "signed-out"
    }

    private fun acceptRefresh(store: FixtureStore, owner: Owner, successor: ByteArray, body: String): Confirmation {
        val fields = decodeRefresh(body) ?: return Confirmation.Denied("unavailable")
        if (fields.isEmpty()) return Confirmation.Denied(clearSession(store))
        val (access, refresh, userId) = fields
        val grantedOwner = Owner.entries.firstOrNull { it.id == userId }
        val marker = refresh.toByteArray(Charsets.UTF_8)
        if (grantedOwner == null || grantedOwner != owner || access != ROTATED_OWNER_A_ACCESS ||
            !marker.contentEquals(successor)) return Confirmation.Denied("unavailable")
        store.rotate(slot, marker)
        return Confirmation.Granted(grantedOwner, access)
    }

    private fun confirm(store: FixtureStore, expectedOwner: Owner?): Confirmation {
        if (signOutBlocked(store)) return Confirmation.Denied("retry-required")
        if (store.recoverUnpublishedSeed(slot)) return Confirmation.Denied("signed-out")
        if (!store.hasRecord(slot)) return Confirmation.Denied("unavailable")
        val marker = store.read(slot) ?: return Confirmation.Denied("unavailable")
        val successor = store.marker(slot, 3)
        val usesSuccessor = successor.contentEquals(marker)
        val owner = if (usesSuccessor) Owner.A else
            Owner.entries.firstOrNull { store.marker(slot, it.generation).contentEquals(marker) }
                ?: return Confirmation.Denied("unavailable")
        if (expectedOwner != null && owner != expectedOwner) return Confirmation.Denied("unavailable")
        if (providerFlag("provider-offline")) return Confirmation.Denied("retry-required")
        val canRotate = owner == Owner.A && !usesSuccessor
        if (providerFlag("provider-expired") || (canRotate && providerFlag("require-successor"))) {
            return acceptRefresh(store, owner, successor, """{"status":"success","value":{"kind":"noSession"}}""")
        }
        if (canRotate && providerFlag("provider-refresh")) {
            val response = if (providerFlag("provider-refresh-invalid")) {
                """{"status":"error","value":{"kind":"noSession"}}"""
            } else {
                // In-process response for the pinned Convex auth:refreshSession mutation.
                val id = if (providerFlag("provider-refresh-wrong-owner")) Owner.B.id else Owner.A.id
                """{"status":"success","value":{"kind":"rotated","tokens":{
                    "accessToken":"$ROTATED_OWNER_A_ACCESS",
                    "refreshToken":"KLAXON-P0-INERT/packaged/3",
                    "refreshTokenExpiresAt":4102444800000,
                    "userId":"$id"
                }}}"""
            }
            return acceptRefresh(store, owner, successor, response)
        }
        val access = if (usesSuccessor || (owner == Owner.A && expectedOwner != null && providerFlag("provider-rotated"))) {
            ROTATED_OWNER_A_ACCESS
        } else owner.access
        return Confirmation.Granted(owner, access)
    }

    private fun authorize(store: FixtureStore, expectedOwner: Owner? = null): String =
        when (val confirmation = confirm(store, expectedOwner)) {
            is Confirmation.Denied -> confirmation.status
            is Confirmation.Granted -> {
                activeOwner = confirmation.owner
                if (expectedOwner == null) "authenticated" else confirmation.access
            }
        }

    @Command
    fun change(invoke: Invoke) {
        synchronized(sessionLock) {
            activeOwner = null
            val operation = try {
                invoke.getArgs().getString("operation")
            } catch (_: Exception) {
                invoke.resolveObject("unavailable")
                return
            }
            if (operation == "sign-out") {
                signOutRequested = true
                if (providerFlag("signout-pause-before-cleanup")) {
                    // Keep the WebView observable while the tester force-stops the writer.
                    Thread({ replyChange(invoke, operation, true) }, "p0-signout-writer").start()
                    return
                }
            }
            replyChange(invoke, operation)
        }
    }

    private fun replyChange(invoke: Invoke, operation: String, pauseBeforeCleanup: Boolean = false) {
        synchronized(sessionLock) {
            val status = try {
                val store = if (operation == "seed" && providerFlag("seed-pause-before-publish")) {
                    checkpointStore("seed-pause-before-publish", PublishBoundary.BEFORE_PUBLISH)
                } else FixtureStore(host)
                when (operation) {
                    "seed", "seed-peer" -> if (signOutBlocked(store)) "retry-required" else
                        seed(store, if (operation == "seed") Owner.A else Owner.B)
                    "resume" -> authorize(store)
                    "sign-out" -> signOut(store, pauseBeforeCleanup).also {
                        if (it == "signed-out") signOutRequested = false
                    }
                    else -> "unavailable"
                }
            } catch (_: Exception) {
                if (operation == "sign-out") "retry-required" else "unavailable"
            }
            invoke.resolveObject(status)
        }
    }

    @Command
    fun sdkAccess(invoke: Invoke) {
        val pause = RefreshPause.entries.firstOrNull { providerFlag(it.flag) }
        if (pause == null) {
            replySdkAccess(invoke)
        } else {
            // Tauri dispatches plugin commands on the UI thread. Keep the WebView observable
            // while the isolated test writer is parked until its process is killed.
            Thread({ replySdkAccess(invoke, pause) }, "p0-refresh-writer").start()
        }
    }

    private fun replySdkAccess(invoke: Invoke, pause: RefreshPause? = null) {
        synchronized(sessionLock) {
            val owner = activeOwner
            activeOwner = null
            val reply = try {
                if (owner == null) "signed-out" else {
                    val store = if (pause == null) FixtureStore(host) else checkpointStore(pause.flag, pause.boundary)
                    authorize(store, owner)
                }
            } catch (_: Exception) {
                activeOwner = null
                "unavailable"
            }
            invoke.resolveObject(reply)
        }
    }

    private fun checkpointStore(flag: String, expected: PublishBoundary) = FixtureStore(host) { boundary ->
        if (boundary == expected) awaitCheckpoint(flag)
    }

    private fun awaitCheckpoint(flag: String) {
        File(host.cacheDir, "p0-$flag-reached").writeText(Process.myPid().toString())
        Thread.sleep(60_000)
        throw IOException("Fixture checkpoint timed out")
    }
}
