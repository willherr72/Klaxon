import type { Doc, Id } from "../_generated/dataModel";
import { env } from "../_generated/server";

export type WebSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Route = Pick<Doc<"pushSubscriptions">, "_id" | "workspaceId" | "userId">;

export function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBytes(value: string | undefined) {
  if (!value || !/^[a-zA-Z0-9_-]+={0,2}$/.test(value)) return null;
  const raw = value.replace(/=+$/, "");
  try {
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    return encodeBytes(bytes) === raw ? bytes : null;
  } catch {
    return null;
  }
}

export function deliveryConfiguration() {
  const variables: Partial<Record<string, string>> = env;
  if (variables.KLAXON_WEB_PUSH_ENABLED !== "true") return null;
  const storage = decodeBytes(variables.KLAXON_WEB_PUSH_STORAGE_KEY);
  const publicKey = decodeBytes(variables.KLAXON_WEB_PUSH_VAPID_PUBLIC_KEY);
  const privateKey = decodeBytes(variables.KLAXON_WEB_PUSH_VAPID_PRIVATE_KEY);
  const subject = variables.KLAXON_WEB_PUSH_VAPID_SUBJECT;
  if (storage?.length !== 32 || publicKey?.length !== 65 || publicKey[0] !== 4 ||
      privateKey?.length !== 32 || !subject || !/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) return null;
  return { storage, vapid: { subject, publicKey: encodeBytes(publicKey), privateKey: encodeBytes(privateKey) } };
}

export function providerEndpoint(endpoint: string) {
  if (endpoint.length > 2_048 || /[\s\\#\x00-\x1f\x7f]/.test(endpoint) ||
      !/^https:\/\/[A-Za-z0-9.-]+\//.test(endpoint) || !URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  const { hostname, pathname } = url;
  const wns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+notify\.windows\.com$/.test(hostname);
  if ((hostname !== "fcm.googleapis.com" && !wns) || pathname === "/") return null;
  return url.href;
}

export async function verifiedSubscription(subscription: WebSubscription): Promise<WebSubscription | null> {
  const endpoint = providerEndpoint(subscription.endpoint);
  const { p256dh, auth } = subscription.keys;
  if (p256dh.length > 90 || auth.length > 24) return null;
  const point = decodeBytes(p256dh);
  const secret = decodeBytes(auth);
  if (!endpoint || point?.length !== 65 || point[0] !== 4 || secret?.length !== 16) return null;
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return { endpoint, keys: { p256dh: encodeBytes(point), auth: encodeBytes(secret) } };
  } catch {
    return null;
  }
}

export async function deliveryDigest(input: string) {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))));
}

function additionalData(route: Route) {
  return new TextEncoder().encode(JSON.stringify(["klaxon-web-push-v1", route._id, route.workspaceId, route.userId]));
}

export async function sealSubscription(storage: Uint8Array<ArrayBuffer>, route: Route, subscription: WebSubscription) {
  const key = await crypto.subtle.importKey("raw", storage, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(subscription));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(route) }, key, clear);
  return { sealed: encodeBytes(new Uint8Array(sealed)), iv: encodeBytes(iv) };
}

export async function openSubscription(storage: Uint8Array<ArrayBuffer>, route: Route,
  envelope: { subscriptionId: Id<"pushSubscriptions">; sealed: string; iv: string }) {
  const { subscriptionId } = envelope;
  const iv = decodeBytes(envelope.iv);
  const sealed = decodeBytes(envelope.sealed);
  if (subscriptionId !== route._id || iv?.length !== 12 || !sealed) return null;
  try {
    const key = await crypto.subtle.importKey("raw", storage, "AES-GCM", false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(route) }, key, sealed);
    return await verifiedSubscription(JSON.parse(new TextDecoder().decode(clear)) as WebSubscription);
  } catch {
    return null;
  }
}
