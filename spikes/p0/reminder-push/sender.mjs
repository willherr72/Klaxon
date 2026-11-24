import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

const targets = ["windows-edge", "android-chrome"];
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function mockInput() {
  const subscriptions = {};
  for (const target of targets) {
    subscriptions[target] = { endpoint: "https://" + target + ".invalid/test",
      keys: { p256dh: "fixture-key-public", auth: "fixture-key-auth" } };
  }
  return { occurrenceId: randomUUID(), subscriptions, vapidDetails: {
    subject: "mailto:operator@example.invalid", publicKey: "fixture-key-public", privateKey: "fixture-key-private",
  } };
}

function preflight(input, rehearsal) {
  if (typeof input?.occurrenceId !== "string" || !uuidV4.test(input.occurrenceId)) {
    throw Error("Expected a new lowercase UUID v4 occurrence");
  }
  const { subscriptions, vapidDetails } = input;
  if (Object.keys(subscriptions ?? {}).length !== targets.length || !targets.every(target => Object.hasOwn(subscriptions, target))) {
    throw Error("Expected exactly the two target subscriptions");
  }
  const endpoints = new Set();
  for (const target of targets) {
    const sub = subscriptions[target];
    if (typeof sub?.endpoint !== "string" || !URL.canParse(sub.endpoint)) throw Error("Invalid subscription endpoint");
    const url = new URL(sub.endpoint);
    const allowed = rehearsal ? url.hostname === target + ".invalid" :
      url.hostname === "fcm.googleapis.com" || (target === "windows-edge" && url.hostname.endsWith(".notify.windows.com"));
    if (!allowed || url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
        url.pathname === "/" || endpoints.has(url.href)) throw Error("Unsupported or duplicate subscription endpoint");
    endpoints.add(url.href);
    if (typeof sub.keys?.p256dh !== "string" || !sub.keys.p256dh ||
        typeof sub.keys.auth !== "string" || !sub.keys.auth) throw Error("Missing subscription keys");
  }
  if (typeof vapidDetails?.publicKey !== "string" || !vapidDetails.publicKey ||
      typeof vapidDetails.privateKey !== "string" || !vapidDetails.privateKey ||
      typeof vapidDetails.subject !== "string" || !/^mailto:[^\s@]+@[^\s@]+$/.test(vapidDetails.subject)) {
    throw Error("Expected VAPID details and a mailto contact");
  }
}

export async function dispatchOnce({ input, runDirectory, sendNotification, prepareNotification, rehearsal = false }) {
  preflight(input, rehearsal);
  const { occurrenceId, subscriptions, vapidDetails } = input;
  const options = { TTL: 300, timeout: 15000, vapidDetails };
  const requests = targets.map(target => ({
    target,
    subscription: subscriptions[target],
    payload: JSON.stringify({ occurrenceId, revision: 1, target, title: "Klaxon P0 test", body: target + " " + occurrenceId }),
  }));
  if (prepareNotification || !rehearsal) {
    try {
      // web-push builds encrypted HTTP request details locally. Discard the resulting private headers/body.
      for (const { subscription, payload } of requests) await prepareNotification(subscription, payload, options);
    } catch {
      throw Error("Cannot prepare both selected subscription requests");
    }
  }
  // Claim both attempts before any transport call. A crash must leave the run spent.
  let ledger;
  try {
    ledger = await open(join(runDirectory, "attempted.json"), "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw Error("This run directory is already claimed");
    throw Error("Cannot claim the run directory");
  }
  try {
    await ledger.writeFile(JSON.stringify({ occurrenceId, targets, claimedAt: new Date().toISOString() }));
    await ledger.sync();
  } finally {
    await ledger.close();
  }
  const results = [];
  for (const { target, subscription, payload } of requests) {
    const attemptedAt = new Date().toISOString();
    let code;
    let transportStatus = "unknown";
    try {
      const response = await sendNotification(subscription, payload, options);
      code = response?.statusCode;
      if (Number.isInteger(code) && code >= 200 && code < 300) transportStatus = "accepted";
    } catch (error) {
      // The library's error can include the entire endpoint, private headers, and response body.
      code = error?.statusCode;
    }
    const providerStatus = Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
    if (providerStatus >= 400 && providerStatus < 500) transportStatus = "rejected";
    results.push({ target, attemptedAt, completedAt: new Date().toISOString(), transportStatus, providerStatus,
      workerReceipt: "unobserved", visibleReceipt: "unobserved" });
  }
  return { occurrenceId, mode: rehearsal ? "rehearsal" : "live", targets: results };
}
