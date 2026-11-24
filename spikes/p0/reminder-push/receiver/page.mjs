import { publicKeyBytes, receiptCache, testSubscription } from "./fixture.mjs";
import { applicationServerKey } from "./public-key.mjs";

const scope = new URL("./", location.href).href;
const workerURL = new URL("sw.mjs", scope);
const target = document.querySelector("#target");
const status = document.querySelector("#status");
const receipts = document.querySelector("#receipts");
const controls = document.querySelectorAll("button, select");

function check(condition, message) {
  if (!condition) throw new FixtureError(message);
}
class FixtureError extends Error {}

async function ownRegistration() {
  const reg = await navigator.serviceWorker.getRegistration(scope);
  if (!reg) return;
  const workers = [reg.installing, reg.waiting, reg.active].filter(Boolean);
  check(reg.scope === scope && workers.length > 0 && workers.every(worker => {
    const url = new URL(worker.scriptURL);
    return url.origin === workerURL.origin && url.pathname === workerURL.pathname;
  }), "Another service worker owns this scope. Stop and contact the test operator.");
  return reg;
}

function selectedWorker() {
  check(["windows-edge", "android-chrome"].includes(target.value), "Choose this device first.");
  const url = new URL(workerURL);
  url.searchParams.set("target", target.value);
  return url.href;
}

async function enable() {
  check(location.protocol === "https:" && window.isSecureContext && "serviceWorker" in navigator &&
    "PushManager" in window && "Notification" in window, "Use the test HTTPS page in a supported browser.");
  const script = selectedWorker();
  let key;
  try { key = publicKeyBytes(applicationServerKey); } catch {
    throw new FixtureError("The operator must configure the disposable public key before enrollment.");
  }
  // The permission prompt must begin inside the click gesture.
  check(await Notification.requestPermission() === "granted", "Permission was not granted. Stop this test.");
  const existing = await ownRegistration();
  if (existing) {
    check(existing.active?.scriptURL === script, "A different test registration is present. Stop and check the profile.");
  } else {
    await navigator.serviceWorker.register(script, { scope, type: "module" });
  }
  let timer;
  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new FixtureError("Worker did not activate.")), 15000); }),
    ]);
    check(registration.scope === scope && registration.active?.scriptURL === script, "Unexpected active worker.");
    await testSubscription(registration, key);
  } finally {
    clearTimeout(timer);
  }
  return "Test reminders enabled. Save the private subscription for the operator.";
}

async function saveSubscription() {
  const script = selectedWorker();
  const registration = await ownRegistration();
  check(registration?.active?.scriptURL === script, "Enable test reminders for this device first.");
  const subscription = await registration.pushManager.getSubscription();
  check(subscription, "No test subscription found.");
  const url = URL.createObjectURL(new Blob([JSON.stringify(subscription.toJSON())], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = target.value + "-subscription.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "Private subscription download requested.";
}

async function readReceipts() {
  receipts.replaceChildren();
  const name = receiptCache(scope);
  if (await caches.has(name)) {
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      const data = await (await cache.match(key)).json();
      const row = document.createElement("li");
      row.textContent = [data.target, data.occurrenceId, "Worker received " + data.receivedAt,
        "Display request " + data.displayRequest].join(" · ");
      receipts.append(row);
    }
  }
  if (!receipts.childElementCount) {
    const empty = document.createElement("li");
    empty.textContent = "No worker receipts recorded.";
    receipts.append(empty);
  }
}

async function remove() {
  const registration = await ownRegistration();
  if (registration) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) check(await subscription.unsubscribe(), "Unsubscribe failed. Keep the fixture for cleanup.");
    check(await registration.unregister(), "Unregister failed. Verify cleanup before removing site data.");
  }
  await caches.delete(receiptCache(scope));
  await readReceipts();
  return "Subscription, fixture worker and local receipts cleared. Delete the downloaded subscription file.";
}

for (const [id, action] of Object.entries({ enable, save: saveSubscription, read: readReceipts, remove })) {
  document.getElementById(id).onclick = async () => {
    for (const control of controls) control.disabled = true;
    try { status.textContent = await action() ?? "Worker receipts refreshed."; }
    catch (error) {
      // Browser errors can contain a subscription URL. Never echo them.
      status.textContent = error instanceof FixtureError ? error.message : "Operation failed. Stop and contact the test operator.";
    } finally {
      for (const control of controls) control.disabled = false;
    }
  };
}
readReceipts().catch(() => { status.textContent = "Unable to read the fixture receipt store."; });
