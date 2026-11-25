import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

// Offline comparison only. Native issues access tokens and owns refresh and sign-out.
export function createSdkTaskSession({
  origin, native, fetch, webSocketConstructor, render, accessDenied = () => {},
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

  function show(session, kind, rows, updateVersion) {
    deliver(kind, () => {
      if (current === session && session.updateVersion === updateVersion) render(rows);
    });
  }

  async function resume() {
    const session = { updateVersion: 0 };
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
        let fresh, denial;
        try {
          fresh = await native.access({ forceRefreshToken: true });
        } catch (error) {
          // The SDK token fetcher must settle even if the native provider is unavailable.
          denial = error;
        }
        if (current !== session) return null;
        if (!fresh) {
          accessDenied(denial);
          await replace(undefined);
          return null;
        }
        session.accessToken = fresh;
        session.http.setAuth(fresh);
        return fresh;
      }, authenticated => {
        if (!authenticated && current === session) void replace(undefined);
      });
      session.live.onUpdate(api.tasks.list, {}, rows => show(session, "update", rows, ++session.updateVersion),
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
    // A subscription update received during this read takes precedence over its snapshot.
    const updateVersion = session.updateVersion;
    const rows = await session.http.query(api.tasks.list, {});
    show(session, "read", rows, updateVersion);
  }

  async function signOut() {
    const closed = replace(undefined);
    // A resume overlapping revocation must wait for the native acknowledgment.
    if (!signingOut) {
      signingOut = Promise.resolve().then(async () => {
        const status = await native.signOut();
        if (status !== "signed-out") throw status;
      }).catch(error => {
        throw error === "retry-required" ? error : "unavailable";
      }).finally(() => { signingOut = undefined; });
    }
    await Promise.all([signingOut, closed]);
  }

  return { resume, read, signOut, clear: () => replace(undefined) };
}
