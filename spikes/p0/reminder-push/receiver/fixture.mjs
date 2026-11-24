const targets = ["windows-edge", "android-chrome"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const title = "Klaxon P0 test";

export const receiptCache = scope => "klaxon-p0-reminder-receipts:" + scope;

export async function handlePush(payload, { target, scope, caches, showNotification }) {
  if (!targets.includes(target) || payload?.target !== target || payload.revision !== 1 ||
      typeof payload.occurrenceId !== "string" || !uuid.test(payload.occurrenceId) ||
      payload.title !== title || payload.body !== target + " " + payload.occurrenceId) return;

  // Separate rows preserve evidence if the worker receives the same occurrence twice.
  const key = new URL("receipt/" + crypto.randomUUID(), scope).href;
  const receipt = { target, occurrenceId: payload.occurrenceId, receivedAt: new Date().toISOString() };
  const cache = await caches.open(receiptCache(scope));
  const record = displayRequest => cache.put(key, Response.json({ ...receipt, displayRequest }));
  await record("pending");
  try {
    await showNotification(title, { body: target + " " + payload.occurrenceId });
  } catch {
    await record("rejected");
    return;
  }
  await record("resolved");
}

export function publicKeyBytes(value) {
  // Uncompressed P-256 public point in unpadded base64url.
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error("Missing disposable public key.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid disposable public key.");
  return bytes;
}

export async function testSubscription(registration, key) {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const prior = new Uint8Array(existing.options.applicationServerKey);
    if (prior.length !== key.length || !prior.every((byte, i) => byte === key[i])) {
      throw new Error("Test subscription belongs to a different key.");
    }
    return existing;
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}
