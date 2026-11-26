import type { ConvexClient } from 'convex/browser';
import { errorCode } from '../contracts';
import { readPushReceipts, resetPushDevice, type PushDevice } from '../pwa/push-client';
import { deliveryApi, type WireSubscription } from './delivery-contract';

const deviceKey = 'klaxon:web-push-device:v1';
const devicePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const cleanupTimeoutMs = 8_000;
let epoch = 0;
let bindingQueue = Promise.resolve();
const knownBindings = new WeakMap<ConvexClient, Map<string, string>>();

export function pushDeviceEpoch() { return epoch; }

export function withPushBinding<T>(work: () => Promise<T>, signal?: AbortSignal) {
  const run = () => { signal?.throwIfAborted(); return work(); };
  if (navigator.locks) return navigator.locks.request('klaxon:web-push-binding', { signal }, run);
  const next = bindingQueue.then(run);
  bindingQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function beforeAbort<T>(signal: AbortSignal | undefined, start: () => Promise<T>) {
  if (!signal) return start();
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([start(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function rememberPushBinding(client: ConvexClient, workspaceId: string, subscriptionPublicId: string) {
  const bindings = knownBindings.get(client) ?? new Map<string, string>();
  bindings.set(workspaceId, subscriptionPublicId);
  knownBindings.set(client, bindings);
}

export async function reconcileReminderPushBinding(client: ConvexClient, workspaceId: string) {
  const deviceId = installDeviceId();
  if (!deviceId) return;
  const started = epoch;
  try {
    const { device } = await client.query(deliveryApi.status, { workspaceId, deviceId });
    if (started === epoch && device) rememberPushBinding(client, workspaceId, device.publicId);
  } catch { /* Workspace startup can proceed without delivery. */ }
}

export function installDeviceId(create = false) {
  try {
    const stored = localStorage.getItem(deviceKey);
    if (stored && devicePattern.test(stored)) return stored;
    if (create) {
      const generated = crypto.randomUUID();
      localStorage.setItem(deviceKey, generated);
      return generated;
    }
  } catch { /* Device enrollment needs durable browser storage. */ }
}

export async function scopedPushRegistration() {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"][data-klaxon-pwa]');
  if (!globalThis.isSecureContext || !manifest || !('serviceWorker' in navigator)) return undefined;
  const scope = new URL('.', manifest.href);
  if (scope.origin !== location.origin) return undefined;
  const registration = await navigator.serviceWorker.getRegistration(scope.href);
  if (registration?.scope !== scope.href || registration.active?.scriptURL !== new URL('pwa-sw.js', scope).href || !registration.pushManager) {
    return undefined;
  }
  return registration;
}

export function applicationServerKey(encoded: string) {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized), value => value.charCodeAt(0));
}

export function wireSubscription(subscription: PushSubscription): WireSubscription {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('Incomplete browser push subscription');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function matchesPushBinding(expected: PushDevice, actual: PushDevice) {
  return actual.workspacePublicId === expected.workspacePublicId && actual.subscriptionPublicId === expected.subscriptionPublicId;
}

export async function disconnectLocalPush(binding: PushDevice, signal?: AbortSignal) {
  const registration = await beforeAbort(signal, scopedPushRegistration);
  if (!registration) return;
  const batch = await beforeAbort(signal, readPushReceipts);
  if (!batch || !matchesPushBinding(binding, batch)) return;
  const subscription = await beforeAbort(signal, () => registration.pushManager.getSubscription());
  signal?.throwIfAborted();
  // Keep the binding lock until an already posted reset settles. The caller can
  // finish signing out at its deadline while a new enrollment waits for the lock.
  const [reset] = await Promise.allSettled([resetPushDevice()]);
  signal?.throwIfAborted();
  if (subscription && !await subscription.unsubscribe()) throw new Error('Browser did not remove the push subscription');
  if (reset.status === 'rejected') throw reset.reason;
}

async function revokeInstall(client: ConvexClient, workspaceId: string, deviceId: string, signal: AbortSignal,
  cleanLocal: (subscriptionPublicId: string) => Promise<void>) {
  const args = { workspaceId, deviceId };
  for (let retry = 0; retry < 2; retry++) {
    const fresh = await beforeAbort(signal, () => client.query(deliveryApi.status, args));
    if (fresh.device) await cleanLocal(fresh.device.publicId);
    const device = fresh.device;
    if (device?.permission !== 'granted') return;
    try {
      await beforeAbort(signal, () => client.mutation(deliveryApi.revoke, {
        ...args, expectedRevision: device.revision, operationId: crypto.randomUUID(),
      }));
      return;
    } catch (reason) {
      if (errorCode(reason) !== 'REVISION_CONFLICT') throw reason;
    }
  }
  throw new Error('Delivery settings changed during sign-out');
}

// Use the same client and workspace on sign-out and expiry. Only the signed-in
// path can revoke the server route. Both paths preserve other worker bindings.
export async function clearReminderPushDevice(client: ConvexClient, workspaceId: string, workspacePublicId: string, authenticated = true) {
  epoch++;
  const deviceId = installDeviceId();
  if (!deviceId) return true;
  const cancellation = new AbortController();
  const { signal } = cancellation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => { cancellation.abort(); resolve(false); }, cleanupTimeoutMs);
  });
  try {
    const cleanup = withPushBinding(async () => {
      const bindings = new Set<string>();
      let localClean = true;
      async function cleanLocal(subscriptionPublicId: string) {
        if (bindings.has(subscriptionPublicId)) return;
        bindings.add(subscriptionPublicId);
        try { await disconnectLocalPush({ workspacePublicId, subscriptionPublicId }, signal); }
        catch { localClean = false; }
      }

      const known = knownBindings.get(client)?.get(workspaceId);
      if (known) await cleanLocal(known);
      if (authenticated) await revokeInstall(client, workspaceId, deviceId, signal, cleanLocal);
      return localClean;
    }, signal);
    return await Promise.race([cleanup, deadline]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
