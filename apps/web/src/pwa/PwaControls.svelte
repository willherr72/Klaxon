<script lang="ts">
  import { onMount } from 'svelte';

  type InstallEvent = Event & {
    prompt: () => Promise<unknown>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };

  let { blocked = false }: { blocked?: boolean } = $props();
  let waiting = $state.raw<ServiceWorker>();
  let stalePage = $state(false);
  let applying = $state(false);
  let online = $state(navigator.onLine);
  let installEvent = $state.raw<InstallEvent>();
  let notice = $state('');
  let requestedWorker: ServiceWorker | undefined;

  onMount(() => {
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"][data-klaxon-pwa]');
    if (!manifest || !('serviceWorker' in navigator)) return;
    const url = new URL('pwa-sw.js', manifest.href);
    if (url.origin !== location.origin) return;
    const stop = new AbortController();
    const { signal } = stop;
    const workers = navigator.serviceWorker;
    let controller = workers.controller;
    let registration: ServiceWorkerRegistration | undefined;
    let checkedAt = Date.now();

    function syncWaiting() {
      if (signal.aborted) return;
      waiting = registration?.waiting?.state === 'installed' ? registration.waiting : undefined;
    }

    function watchInstalling() {
      registration?.installing?.addEventListener('statechange', syncWaiting, { signal });
      syncWaiting();
    }

    function checkForUpdate() {
      const now = Date.now();
      if (!registration || !navigator.onLine || now - checkedAt < 60_000) return;
      checkedAt = now;
      void registration.update().catch(() => {});
    }

    workers.addEventListener('controllerchange', () => {
      const previous = controller;
      controller = workers.controller;
      if (!controller || controller === previous) return;
      const requested = requestedWorker === controller;
      requestedWorker = undefined;
      applying = false;
      stalePage = Boolean(previous || requested);
      syncWaiting();
      if (requested && !blocked && navigator.onLine) location.reload();
    }, { signal });

    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      installEvent = event as InstallEvent;
    }, { signal });
    window.addEventListener('appinstalled', () => { installEvent = undefined; }, { signal });
    window.addEventListener('focus', checkForUpdate, { signal });
    window.addEventListener('online', () => { online = true; checkForUpdate(); }, { signal });
    window.addEventListener('offline', () => { online = false; }, { signal });

    void workers.register(url, { updateViaCache: 'none' }).then(result => {
      if (signal.aborted) return;
      registration = result;
      registration.addEventListener('updatefound', watchInstalling, { signal });
      watchInstalling();
    }).catch(() => {
      // The online planner can still run if service workers are disabled.
    });

    return () => stop.abort();
  });

  async function install() {
    const prompt = installEvent;
    if (!prompt) return;
    installEvent = undefined;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      notice = 'Install prompt unavailable.';
    }
  }

  function reloadToUpdate() {
    if (blocked || applying || !navigator.onLine) return;
    notice = '';
    if (waiting) {
      try {
        requestedWorker = waiting;
        applying = true;
        waiting.postMessage({ type: 'KLAXON_ACTIVATE_UPDATE' });
      } catch {
        requestedWorker = undefined;
        applying = false;
        notice = 'Could not activate the update. Try again.';
      }
    } else if (stalePage) {
      location.reload();
    }
  }
</script>

{#if installEvent || waiting || stalePage || applying || notice}
  <div class="pwa-controls">
    {#if installEvent}<button onclick={install}>Install Klaxon</button>{/if}
    {#if waiting || stalePage || applying}
      <button onclick={reloadToUpdate} disabled={blocked || applying || !online} aria-describedby={blocked ? 'pwa-update-blocked' : undefined}>
        {applying ? 'Updating…' : 'Reload to update'}
      </button>
      {#if blocked}<span id="pwa-update-blocked" role="status">Save or discard your draft to update.</span>{/if}
    {/if}
    {#if notice}<span role="status">{notice}</span>{/if}
  </div>
{/if}

<style>
  .pwa-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  button {
    min-block-size: var(--planner-target, 2.75rem);
    padding: 0.45rem 0.65rem;
    color: var(--planner-text, inherit);
    background: var(--planner-surface, transparent);
    border: 1px solid var(--planner-control-border, currentColor);
    border-radius: var(--planner-radius, 0.4rem);
    font: inherit;
  }
  button:not(:disabled) { cursor: pointer; }
  button:disabled { opacity: 0.6; }
</style>
