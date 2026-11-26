(() => {
  const worker = globalThis;
  const { version, files } = worker.KLAXON_PWA_BUILD;
  const scope = new worker.URL(worker.registration.scope);
  const prefix = `klaxon-shell:${scope.href}:`;
  const cacheName = `${prefix}${version}`;
  const indexUrl = new worker.URL('index.html', scope);
  const index = indexUrl.href;
  const assets = new Set(files.map(file => new worker.URL(file, scope).href));

  worker.addEventListener('install', event => {
    event.waitUntil(worker.caches.open(cacheName).then(cache => cache.addAll([...assets].map(url => new worker.Request(url, {
      cache: 'reload', credentials: 'omit', redirect: 'error',
    })))));
  });

  worker.addEventListener('activate', event => {
    event.waitUntil((async () => {
      const names = (await worker.caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName);
      // Keep previous hashed assets available to tabs that are still running the previous build.
      await Promise.all(names.slice(0, -1).map(name => worker.caches.delete(name)));
      await worker.clients.claim();
    })());
  });

  worker.addEventListener('message', event => {
    if (event.data?.type !== 'KLAXON_ACTIVATE_UPDATE' || event.source?.type !== 'window') return;
    const source = new worker.URL(event.source.url);
    if (source.origin === scope.origin && (source.pathname === scope.pathname || source.pathname === indexUrl.pathname)) {
      event.waitUntil(worker.skipWaiting());
    }
  });

  worker.addEventListener('fetch', event => {
    const { request } = event;
    const url = new worker.URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.origin || url.search
      || request.headers.has('authorization') || request.headers.has('range')) return;

    if (request.mode === 'navigate') {
      if (url.pathname !== scope.pathname && url.href !== index) return;
      // A fresh navigation can load the current deployment. An offline navigation can use only our prebuilt HTML.
      event.respondWith(worker.fetch(request).catch(async () => await worker.caches.match(index, { cacheName }) ?? worker.Response.error()));
    } else if (url.href !== index && assets.has(url.href)) {
      event.respondWith(worker.caches.match(request, { cacheName }).then(response => response ?? worker.fetch(request)));
    } else if (url.pathname.startsWith(`${scope.pathname}assets/`)) {
      event.respondWith((async () => {
        const previous = (await worker.caches.keys()).find(name => name.startsWith(prefix) && name !== cacheName);
        const response = previous && await worker.caches.match(request, { cacheName: previous });
        return response || worker.fetch(request);
      })());
    }
  });
})();
