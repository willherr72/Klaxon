import type { ConvexClient } from 'convex/browser';
import { errorCode } from '../contracts';
import { readPushReceipts, resetPushDevice, type PushDevice } from '../pwa/push-client';
import { deliveryApi, type WireSubscription } from './delivery-contract';

const deviceKey = 'klaxon:web-push-device:v1';
const bindingKey = 'klaxon:web-push-binding:v1:';
const devicePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const cleanupTimeoutMs = 8_000;
let epoch = 0;
let bindingQueue = Promise.resolve();
const knownBindings = new WeakMap<ConvexClient, Map<string, string>>();

export type ReminderPushScope = { userId: string; workspaceId: string; workspacePublicId: string };

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

function scopedBindingKey({ userId, workspaceId, workspacePublicId }: ReminderPushScope, deviceId: string) {
  return bindingKey + JSON.stringify([deviceId, userId, workspaceId, workspacePublicId]);
}

function savedPushBinding(key: string) {
  try {
    const value = localStorage.getItem(key);
    if (value && devicePattern.test(value)) return value;
  } catch { /* A session can still use its live status. */ }
}

export function savePushBinding(scope: ReminderPushScope, deviceId: string, subscriptionPublicId: string) {
  const key = scopedBindingKey(scope, deviceId);
  if (localStorage.getItem(key) !== subscriptionPublicId) localStorage.setItem(key, subscriptionPublicId);
}

export function rememberPushBinding(client: ConvexClient, scope: ReminderPushScope, deviceId: string, subscriptionPublicId: string) {
  const bindings = knownBindings.get(client) ?? new Map<string, string>();
  bindings.set(scopedBindingKey(scope, deviceId), subscriptionPublicId);
  knownBindings.set(client, bindings);
}

export async function reconcileReminderPushBinding(client: ConvexClient, scope: ReminderPushScope) {
  const deviceId = installDeviceId();
  if (!deviceId) return;
  const started = epoch;
  const { workspaceId, workspacePublicId } = scope;
  try {
    const { device } = await client.query(deliveryApi.status, { workspaceId, deviceId });
    if (started !== epoch || !device) return;
    const subscriptionPublicId = device.publicId;
    rememberPushBinding(client, scope, deviceId, subscriptionPublicId);
    if (savedPushBinding(scopedBindingKey(scope, deviceId)) === subscriptionPublicId) return;
    // Upgrade an enrollment created before the page stored an ownership proof.
    const live = await readPushReceipts();
    if (started === epoch && live && matchesPushBinding({ workspacePublicId, subscriptionPublicId }, live)) {
      savePushBinding(scope, deviceId, subscriptionPublicId);
    }
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
  if (!registration) return false;
  const batch = await beforeAbort(signal, readPushReceipts);
  if (!batch || !matchesPushBinding(binding, batch)) return false;
  const subscription = await beforeAbort(signal, () => registration.pushManager.getSubscription());
  signal?.throwIfAborted();
  // Keep the binding lock until an already posted reset settles. The caller can
  // finish signing out at its deadline while a new enrollment waits for the lock.
  const [reset] = await Promise.allSettled([resetPushDevice()]);
  signal?.throwIfAborted();
  if (subscription && !await subscription.unsubscribe()) throw new Error('Browser did not remove the push subscription');
  if (reset.status === 'rejected') throw reset.reason;
  return true;
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
export async function clearReminderPushDevice(client: ConvexClient, scope: ReminderPushScope, authenticated = true) {
  epoch++;
  const deviceId = installDeviceId();
  if (!deviceId) return true;
  const { workspaceId, workspacePublicId } = scope;
  const key = scopedBindingKey(scope, deviceId);
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
        try {
          if (!await disconnectLocalPush({ workspacePublicId, subscriptionPublicId }, signal)) return;
          const known = knownBindings.get(client);
          if (known?.get(key) === subscriptionPublicId) known.delete(key);
          try { if (savedPushBinding(key) === subscriptionPublicId) localStorage.removeItem(key); }
          catch { /* A stale proof still requires a matching live worker. */ }
        } catch { localClean = false; }
      }

      const durable = savedPushBinding(key);
      if (durable) await cleanLocal(durable);
      const known = knownBindings.get(client)?.get(key);
      if (known) await cleanLocal(known);
      if (authenticated) await revokeInstall(client, workspaceId, deviceId, signal, cleanLocal);
      return localClean;
    }, signal);
    return await Promise.race([cleanup, deadline]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
