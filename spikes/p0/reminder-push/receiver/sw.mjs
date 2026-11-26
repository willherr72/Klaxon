import { handlePush } from "./fixture.mjs";

self.addEventListener("push", event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  event.waitUntil(handlePush(payload, {
    target: new URL(self.location.href).searchParams.get("target"),
    scope: self.registration.scope,
    caches: self.caches,
    showNotification: (title, options) => self.registration.showNotification(title, options),
  }));
});
