"use node";

import { generateRequestDetails, type RequestOptions } from "web-push";
import { providerEndpoint, type WebSubscription } from "./deliverySecrets";
import { deliveryWindowMs, type PushPayload, type TransportOutcome } from "./deliveryStore";

type Transport = (url: string, options: RequestInit) => Promise<Response>;
type VapidDetails = NonNullable<RequestOptions["vapidDetails"]>;

function retryDelay(value: string | null, now: number) {
  if (value && /^\d+$/.test(value)) return Math.min(deliveryWindowMs, Number(value) * 1_000);
  const date = value === null ? NaN : Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(deliveryWindowMs, date - now)) : 5_000;
}

export async function sendWebPush(subscription: WebSubscription, vapidDetails: VapidDetails, payload: PushPayload,
  expiresAt: number, now: number, transport: Transport): Promise<TransportOutcome> {
  const endpoint = providerEndpoint(subscription.endpoint);
  if (!endpoint || expiresAt <= now) return { kind: "failed", code: "request_preparation" };
  let headers: Headers;
  let body: Uint8Array<ArrayBuffer>;
  try {
    const details = generateRequestDetails({ ...subscription, endpoint }, JSON.stringify(payload), {
      TTL: Math.floor(Math.min(expiresAt - now, deliveryWindowMs) / 1_000),
      vapidDetails,
      contentEncoding: "aes128gcm",
    });
    headers = new Headers(Object.fromEntries(Object.entries(details.headers).map(([name, value]) => [name, String(value)])));
    body = new Uint8Array(details.body);
  } catch {
    // The library may include subscription values in its errors.
    return { kind: "failed", code: "request_preparation" };
  }

  try {
    const response = await transport(endpoint, { method: "POST", headers, body, redirect: "manual",
      signal: AbortSignal.timeout(15_000) });
    const providerStatus = response.status;
    void response.body?.cancel().catch(() => undefined);
    if (providerStatus >= 200 && providerStatus < 300) return { kind: "accepted", providerStatus };
    if (providerStatus === 404 || providerStatus === 410) return { kind: "gone", providerStatus };
    if (providerStatus === 429) {
      return { kind: "retry", providerStatus, retryAfterMs: retryDelay(response.headers.get("retry-after"), now) };
    }
    if (providerStatus >= 400 && providerStatus < 500 && providerStatus !== 408) return { kind: "rejected", providerStatus };
    return { kind: "uncertain", providerStatus, code: "provider_uncertain" };
  } catch {
    return { kind: "uncertain", code: "transport_uncertain" };
  }
}
