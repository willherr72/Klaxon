// @vitest-environment node
import { expect, test, vi } from "vitest";
import { sendWebPush } from "../convex/model/deliveryTransport";
import type { PushPayload } from "../convex/model/deliveryStore";

const now = Date.parse("2027-01-01T12:00Z");
const endpoint = "https://fixture.notify.windows.com/test";
const publicKey = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const subscription = { endpoint, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } };
const vapid = { subject: "mailto:push@example.invalid", publicKey, privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE" };
const payload: PushPayload = { version: 1, kind: "klaxon.reminder", workspacePublicId: "workspace-fixture",
  reminderPublicId: "reminder-fixture", occurrencePublicId: "occurrence-fixture", reminderRevision: 3,
  subscriptionPublicId: "subscription-fixture", attemptPublicId: "attempt-fixture", dueAt: now, title: "Klaxon reminder" };

test("the pinned library builds an encrypted VAPID request with bounded TTL and redirects disabled", async () => {
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(endpoint);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("TTL")).toBe("17");
    expect(headers.get("Authorization")).toMatch(/^vapid /);
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(Buffer.from(init.body as Uint8Array).includes(Buffer.from("occurrence-fixture"))).toBe(false);
    return new Response(null, { status: 201 });
  });
  expect(await sendWebPush(subscription, vapid, payload, now + 17_999, now, transport)).toEqual({
    kind: "accepted", providerStatus: 201,
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  [429, { kind: "retry", providerStatus: 429, retryAfterMs: 7000 }],
  [410, { kind: "gone", providerStatus: 410 }],
  [401, { kind: "rejected", providerStatus: 401 }],
  [408, { kind: "uncertain", providerStatus: 408, code: "provider_uncertain" }],
  [503, { kind: "uncertain", providerStatus: 503, code: "provider_uncertain" }],
  [302, { kind: "uncertain", providerStatus: 302, code: "provider_uncertain" }],
] as const)("classifies HTTP %s without following or disclosing provider details", async (status, expected) => {
  const transport = vi.fn(async () => new Response("secret provider response", { status,
    headers: { location: "https://external.invalid/path", "retry-after": "7" } }));
  expect(await sendWebPush(subscription, vapid, payload, now + 60_000, now, transport)).toEqual(expected);
  expect(transport).toHaveBeenCalledTimes(1);
});

test("transport exceptions become uncertain and endpoint rejection cannot call transport", async () => {
  const transport = vi.fn(async () => { throw new Error("secret endpoint and provider headers"); });
  expect(await sendWebPush(subscription, vapid, payload, now + 60_000, now, transport)).toEqual({
    kind: "uncertain", code: "transport_uncertain",
  });
  expect(await sendWebPush({ ...subscription, endpoint: "https://external.invalid/path" }, vapid,
    payload, now + 60_000, now, transport)).toEqual({ kind: "failed", code: "request_preparation" });
  expect(transport).toHaveBeenCalledTimes(1);
});
