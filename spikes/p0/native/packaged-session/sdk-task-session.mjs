import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

// Offline comparison only. Native issues access tokens and owns refresh and sign-out.
export function createSdkTaskSession({
  origin, native, fetch, webSocketConstructor, render,
  deliver = (_kind, callback) => callback(),
}) {
  if (origin !== "https://sdk-fixture.invalid" ||
      typeof fetch !== "function" || typeof webSocketConstructor !== "function") {
    throw new Error("Use the reserved SDK fixture origin and intercepted transports");
  }
  let current;
  let signingOut;
  render([]);

  function replace(next) {
    const previous = current;
    current = next;
    let closing;
    if (previous) {
      previous.accessToken = null;
      previous.http?.clearAuth();
      closing = previous.live?.close(); // Stops subscriptions and SDK token refresh.
      // A queued delivery only needs the old object's identity.
      previous.http = undefined;
      previous.live = undefined;
    }
    render([]);
    return closing;
  }

  function show(session, kind, rows) {
    deliver(kind, () => {
      if (current === session) render(rows);
    });
  }

  async function resume() {
    const session = {};
    const closed = replace(session);
    const pendingSignOut = signingOut;
    try {
      if (closed) await closed;
      if (pendingSignOut) await pendingSignOut;
      if (current !== session) return false;
      const token = await native.access({ forceRefreshToken: false });
      if (current !== session || !token) return false;

      session.http = new ConvexHttpClient(origin, { fetch, logger: false });
      session.live = new ConvexClient(origin, {
        webSocketConstructor, logger: false, expectAuth: true, unsavedChangesWarning: false,
      });
      session.accessToken = token;
      session.http.setAuth(token);
      session.live.setAuth(async ({ forceRefreshToken }) => {
        if (current !== session) return null;
        if (!forceRefreshToken) return session.accessToken;
        let fresh;
        try {
          fresh = await native.access({ forceRefreshToken: true });
        } catch {
          // The SDK token fetcher must settle even if the native provider is unavailable.
          fresh = null;
        }
        if (current !== session) return null;
        if (!fresh) {
          await replace(undefined);
          return null;
        }
        session.accessToken = fresh;
        session.http.setAuth(fresh);
        return fresh;
      }, authenticated => {
        if (!authenticated && current === session) void replace(undefined);
      });
      session.live.onUpdate(api.tasks.list, {}, rows => show(session, "update", rows),
        () => { if (current === session) void replace(undefined); });
      return true;
    } catch (error) {
      if (current !== session) return false;
      await replace(undefined);
      throw error;
    }
  }

  async function read() {
    const session = current;
    if (!session?.accessToken) throw new Error("Signed out");
    const rows = await session.http.query(api.tasks.list, {});
    show(session, "read", rows);
  }

  async function signOut() {
    const closed = replace(undefined);
    // A resume overlapping revocation must wait for the native operation.
    signingOut ??= Promise.resolve().then(() => native.signOut());
    const revocation = signingOut;
    try {
      await Promise.all([revocation, closed]);
    } finally {
      if (signingOut === revocation) signingOut = undefined;
    }
  }

  return { resume, read, signOut };
}
