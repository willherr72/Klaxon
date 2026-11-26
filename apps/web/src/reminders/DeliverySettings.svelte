<script lang="ts">
  import { recoverDraft } from '../draft-recovery';
  import type { ConvexClient } from 'convex/browser';
  import { onMount, untrack } from 'svelte';
  import { errorCode, pageSize } from '../contracts';
  import { minuteMs } from '../calendar/calendar-clock';
  import { clearPushReceipts, configurePushDevice, readPushReceipts, type PushDevice } from '../pwa/push-client';
  import { deliveryApi, deliveryLabels, type DeliveryAttempt, type DeliveryStatus, type DeliveryWrite } from './delivery-contract';
  import { applicationServerKey, disconnectLocalPush, installDeviceId, matchesPushBinding, pushDeviceEpoch, rememberPushBinding,
    savePushBinding, scopedPushRegistration, wireSubscription, withPushBinding } from './push-device';
  import { dateLabel, type Page } from './reminder-contract';

  let { client, userId, workspaceId, workspacePublicId, disabled = false, onUnauthenticated, onDirtyChange }: {
    client: ConvexClient; userId: string; workspaceId: string; workspacePublicId: string; disabled?: boolean;
    onUnauthenticated: () => void; onDirtyChange: (dirty: boolean) => void;
  } = $props();
  type Stage = { kind: 'write'; write: DeliveryWrite } |
    { kind: 'configure'; binding: PushDevice; message: string } | { kind: 'disconnect'; binding: PushDevice; message: string };
  type Review = 'enable' | 'disable' | 'revoke';
  const reviews = {
    enable: { label: 'Confirm workspace opt-in', detail: 'Allow Web Push for this workspace account. Each browser needs its own enrollment.' },
    disable: { label: 'Confirm workspace opt-out', detail: 'Turn off Web Push for this workspace account across its enrolled browsers.' },
    revoke: { label: 'Confirm browser removal', detail: 'Remove Web Push enrollment for this browser.' },
  };
  const viewEpoch = pushDeviceEpoch();
  const deviceId = installDeviceId(true);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let alive = true;
  let expanded = $state(false);
  let showHistory = $state(false);
  let registration = $state.raw<ServiceWorkerRegistration>();
  let permission = $state<typeof Notification.permission>();
  let enrolled = $state(false);
  let boundElsewhere = $state(false);
  let status = $state.raw<DeliveryStatus>();
  let statusError = $state(false);
  let statusRetry = $state(0);
  let deliveryHistory = $state.raw<Page<DeliveryAttempt>>();
  let historyError = $state(false);
  let historyRetry = $state(0);
  let cursors = $state<(string | null)[]>([null]);
  let review = $state.raw<{ kind: Review; status: DeliveryStatus }>();
  let stage = $state.raw<Stage>();
  let pending = $state(false);
  let checking = false;
  let receiptError = $state(false);
  let notice = $state('');
  let writeError = $state('');
  const dirty = $derived(Boolean(review || stage || pending));

  const current = () => alive && viewEpoch === pushDeviceEpoch();
  const identity = $derived(deviceId ? { workspaceId, deviceId } : undefined);
  const pushScope = $derived({ userId, workspaceId, workspacePublicId });

  function binding(subscriptionPublicId: string): PushDevice { return { workspacePublicId, subscriptionPublicId }; }

  const restored = recoverDraft('reminder-delivery', () => {
    const needsFreshEnrollment = stage?.kind === 'configure' || (stage?.kind === 'write' && stage.write.kind === 'register');
    return dirty ? { expanded, review, stage: needsFreshEnrollment ? undefined : stage } : undefined;
  });
  if (restored) {
    expanded = restored.expanded;
    review = restored.review;
    stage = restored.stage;
  }

  $effect(() => {
    const value = dirty;
    untrack(() => onDirtyChange(value));
  });

  onMount(() => {
    const stop = new AbortController();
    const focus = () => { void checkBrowser(); };
    window.addEventListener('focus', focus, { signal: stop.signal });
    window.addEventListener('online', focus, { signal: stop.signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') focus(); }, { signal: stop.signal });
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', focus, { signal: stop.signal });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') focus(); }, minuteMs);
    focus();
    return () => { alive = false; stop.abort(); window.clearInterval(timer); onDirtyChange(false); };
  });

  $effect(() => {
    void statusRetry;
    statusError = false;
    if (!identity || !deviceId) return;
    let active = true;
    const stop = client.onUpdate(deliveryApi.status, identity, result => {
      if (!active || !current()) return;
      status = result;
      statusError = false;
      if (result.device) rememberPushBinding(client, pushScope, deviceId, result.device.publicId);
      void checkBrowser();
    }, reason => {
      if (!active || !current()) return;
      if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
      else statusError = true;
    });
    return () => { active = false; stop(); };
  });

  $effect(() => {
    deliveryHistory = undefined;
    historyError = false;
    void historyRetry;
    if (!expanded || !showHistory) return;
    let active = true;
    const stop = client.onUpdate(deliveryApi.history,
      { workspaceId, paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: pageSize } }, result => {
        if (active && current()) deliveryHistory = result;
      }, reason => {
        if (!active || !current()) return;
        if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
        else historyError = true;
      });
    return () => { active = false; stop(); };
  });

  async function checkBrowser() {
    if (checking || pending || !current()) return;
    checking = true;
    try {
      const worker = await scopedPushRegistration();
      if (!current() || pending) return;
      registration = worker;
      permission = 'Notification' in window ? Notification.permission : undefined;
      if (!worker || !identity) return;
      const device = status?.device;
      if (!disabled && !stage && !review && device?.permission === 'granted' && permission && permission !== 'granted') {
        const write: DeliveryWrite = { kind: 'setPermission', args: { ...identity, permission,
          expectedRevision: device.revision, operationId: crypto.randomUUID() } };
        void run({ kind: 'write', write });
        return;
      }
      if (!device || permission !== 'granted') return;
      const batch = await readPushReceipts();
      if (!current() || pending || status?.device?.publicId !== device.publicId) return;
      enrolled = Boolean(batch && matchesPushBinding(binding(device.publicId), batch));
      boundElsewhere = Boolean(batch && !enrolled);
      if (enrolled && deviceId) {
        try { savePushBinding(pushScope, deviceId, device.publicId); }
        catch { /* Existing enrollment can still use this session's status. */ }
      }
      if (enrolled && batch && !disabled) {
        const confirmed: string[] = [];
        for (const { attemptPublicId } of batch.receipts) {
          if (!current() || disabled) break;
          try {
            await client.mutation(deliveryApi.acknowledge, { ...identity, attemptPublicId });
            confirmed.push(attemptPublicId);
          } catch (reason) {
            if (!current()) return;
            if (errorCode(reason) === 'UNAUTHENTICATED') { onUnauthenticated(); return; }
          }
        }
        if (!current()) return;
        receiptError = confirmed.length < batch.receipts.length;
        if (confirmed.length) await clearPushReceipts(confirmed);
      }
    } catch {
      if (current() && status?.device?.active) receiptError = true;
    } finally { checking = false; }
  }

  function startReview(kind: Review) {
    if (disabled || pending || stage || !status) return;
    review = { kind, status };
    writeError = '';
    notice = '';
  }

  function confirmReview() {
    if (!review || disabled || pending || !identity) return;
    const { kind, status: viewed } = review;
    review = undefined;
    const operationId = crypto.randomUUID();
    if (kind === 'revoke' && viewed.device) {
      void run({ kind: 'write', write: { kind: 'revoke', args: { ...identity, expectedRevision: viewed.device.revision, operationId } } });
    } else if (kind !== 'revoke') {
      void run({ kind: 'write', write: { kind: 'setEnabled', args: { workspaceId, enabled: kind === 'enable',
        expectedRevision: viewed.grantRevision, operationId } } });
    }
  }

  async function enroll() {
    const worker = registration;
    const currentStatus = status;
    const target = identity;
    if (disabled || !worker || !currentStatus?.available || !currentStatus.enabled || !target || pending || stage || review) return;
    pending = true;
    writeError = '';
    notice = '';
    try {
      // Calling the permission API before any await preserves the click activation.
      const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (!current()) return;
      permission = result;
      await withPushBinding(async () => {
        if (!current()) return;
        const change = { ...target, expectedRevision: currentStatus.device?.revision ?? 0, operationId: crypto.randomUUID() };
        if (result !== 'granted') {
          await perform({ kind: 'write', write: { kind: 'setPermission', args: { ...change, permission: result } } });
          return;
        }
        const existing = await readPushReceipts();
        if (existing && (!currentStatus.device || !matchesPushBinding(binding(currentStatus.device.publicId), existing))) {
          if (current()) writeError = 'This browser is enrolled for another account or workspace.';
          return;
        }
        const key = currentStatus.publicKey;
        if (!key || !current()) return;
        const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: applicationServerKey(key),
        });
        if (!current()) {
          if (!existing) await subscription.unsubscribe();
          return;
        }
        await perform({ kind: 'write', write: { kind: 'register', args: { ...change, permission: 'granted', subscription: wireSubscription(subscription) } } });
      });
    } catch (reason) { handleError(reason); }
    finally { finish(); }
  }

  async function run(next: Stage) {
    if (disabled || pending || !current()) return;
    pending = true;
    writeError = '';
    notice = '';
    try { await withPushBinding(() => perform(next)); }
    catch (reason) { handleError(reason); }
    finally { finish(); }
  }

  async function perform(next: Stage) {
    if (!current()) return;
    stage = next;
    if (next.kind === 'configure') {
      const existing = await readPushReceipts();
      if (!current()) return;
      if (existing && !matchesPushBinding(next.binding, existing)) {
        stage = undefined;
        writeError = 'This browser is enrolled for another account or workspace.';
        return;
      }
      if (!deviceId) throw new Error('Browser device ID unavailable');
      // Save the signed-in registration proof before the worker can display a push.
      savePushBinding(pushScope, deviceId, next.binding.subscriptionPublicId);
      await configurePushDevice(next.binding);
      if (!current()) return;
      enrolled = true;
      boundElsewhere = false;
      notice = next.message;
    } else if (next.kind === 'disconnect') {
      await disconnectLocalPush(next.binding);
      if (!current()) return;
      enrolled = false;
      notice = next.message;
    } else {
      const { write } = next;
      const receipt = await client.mutation(deliveryApi[write.kind], write.args);
      if (!current()) return;
      if (write.kind === 'register') rememberPushBinding(client, pushScope, write.args.deviceId, receipt.targetPublicId);
      switch (write.kind) {
        case 'register':
          await perform({ kind: 'configure', binding: binding(receipt.targetPublicId), message: 'This browser is enrolled.' });
          return;
        case 'revoke':
          await perform({ kind: 'disconnect', binding: binding(receipt.targetPublicId), message: 'Browser enrollment removed.' });
          return;
        case 'setPermission':
          await perform({ kind: 'disconnect', binding: binding(receipt.targetPublicId), message: 'Browser permission was not granted.' });
          return;
        case 'setEnabled':
          if (!write.args.enabled && status?.device) {
            await perform({ kind: 'disconnect', binding: binding(status.device.publicId), message: 'Workspace Web Push is off.' });
            return;
          }
          notice = write.args.enabled ? 'Workspace Web Push is on.' : 'Workspace Web Push is off.';
      }
    }
    stage = undefined;
  }

  function handleError(reason: unknown) {
    if (!current()) return;
    const code = errorCode(reason);
    if (code === 'UNAUTHENTICATED') { onUnauthenticated(); return; }
    if (code) {
      stage = undefined;
      if (code === 'REVISION_CONFLICT') statusRetry++;
      writeError = code === 'REVISION_CONFLICT' ? 'Delivery settings changed elsewhere. Review the updated settings.' :
        code === 'SUBSCRIPTION_IN_USE' ? 'This browser subscription is already in use.' :
        code === 'DELIVERY_UNAVAILABLE' ? 'Web Push is currently unavailable.' : 'The workspace rejected the delivery change.';
    } else {
      writeError = stage ? 'Could not confirm the delivery change. Retry to continue the same operation.' : 'Could not enroll this browser.';
    }
  }

  function finish() {
    if (!current()) return;
    pending = false;
    if (!stage) void checkBrowser();
  }

  function historyPage(direction: -1 | 1) {
    if (!deliveryHistory) return;
    if (direction < 0 && cursors.length > 1) cursors = cursors.slice(0, -1);
    if (direction > 0 && !deliveryHistory.isDone) cursors = [...cursors, deliveryHistory.continueCursor];
  }
</script>

<section class="reminder-delivery" aria-label="Web Push delivery">
  <button aria-expanded={expanded} disabled={dirty || disabled} onclick={() => { expanded = !expanded; }}>Delivery settings</button>
  {#if expanded}
    <h3>Web Push</h3>
    {#if statusError}
      <p role="alert">Could not load delivery settings.</p><button onclick={() => { statusRetry++; }}>Retry loading delivery</button>
    {:else if !deviceId}<p>Browser storage is unavailable. Enrollment requires a persistent browser device ID.</p>
    {:else if !status}<p role="status">Loading delivery settings…</p>
    {:else}
      {#if !status.available}<p>Web Push is unavailable for this workspace.</p>{/if}
      <p>{status.enabled ? 'Workspace Web Push is on.' : 'Workspace Web Push is off.'}</p>
      <div class="reminder-actions">
        <button disabled={disabled || dirty || (!status.available && !status.enabled)} onclick={() => startReview(status?.enabled ? 'disable' : 'enable')}>
          {status.enabled ? 'Turn off workspace Web Push' : 'Turn on workspace Web Push'}
        </button>
        {#if status.device && (status.device.active || enrolled)}
          <button disabled={disabled || dirty} onclick={() => startReview('revoke')}>Remove this browser</button>
        {/if}
        {#if status.available && status.enabled && registration && permission && permission !== 'denied' && (!status.device?.active || !enrolled) && !boundElsewhere}
          <button disabled={disabled || dirty} onclick={() => void enroll()}>Enable on this browser</button>
        {/if}
      </div>
      {#if status.enabled}
        {#if permission === 'denied'}<p>Notifications are blocked in this browser. Allow them in browser settings to enroll.</p>
        {:else if !registration}<p>Web Push requires the Klaxon service worker and browser notification support.</p>
        {:else if boundElsewhere}<p>This browser is enrolled for another account or workspace.</p>
        {:else if enrolled && status.device?.active}<p>This browser is enrolled.</p>{/if}
      {/if}
    {/if}
    {#if review}
      <div class="reminder-confirmation" role="group" aria-label="Confirm delivery setting">
        <p>{reviews[review.kind].detail}</p>
        <div class="reminder-actions">
          <button disabled={disabled || pending} onclick={confirmReview}>{reviews[review.kind].label}</button>
          <button disabled={disabled || pending} onclick={() => { review = undefined; }}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if notice && notice !== 'This browser is enrolled.' && notice !== 'Workspace Web Push is on.' && notice !== 'Workspace Web Push is off.'}
      <p role="status">{notice}</p>
    {/if}
    {#if writeError}<p role="alert">{writeError}</p>{/if}
    {#if stage && !pending}<button disabled={disabled} onclick={() => { if (stage) void run(stage); }}>Retry delivery change</button>{/if}
    {#if receiptError}
      <p role="alert">Some browser receipts could not be synced.</p>
      <button disabled={disabled || pending} onclick={() => void checkBrowser()}>Retry syncing receipts</button>
    {/if}
    <button aria-expanded={showHistory} onclick={() => { showHistory = !showHistory; }}>Delivery history</button>
    {#if showHistory}
      {#if historyError}
        <p role="alert">Could not load delivery history.</p><button onclick={() => { historyRetry++; }}>Retry delivery history</button>
      {:else if deliveryHistory?.page.length}
        <ul class="reminder-list">
          {#each deliveryHistory.page as item (item.publicId)}
            <li class="reminder-row">
              <div>
                <strong>{deliveryLabels[item.status]}</strong>
                <div>{dateLabel(item.createdAt, timezone)} · {item.channel === 'web_push' ? 'Web Push' : 'Native'}</div>
                {#if item.status === 'acknowledged' && item.acceptedAt !== undefined}<div>Accepted by push provider</div>{/if}
                {#if item.acknowledgedAt !== undefined}<div>Receipt synced {dateLabel(item.acknowledgedAt, timezone)}</div>{/if}
              </div>
            </li>
          {/each}
        </ul>
        {#if cursors.length > 1 || !deliveryHistory.isDone}
          <div class="reminder-actions" role="group" aria-label="Delivery history pages">
            <button disabled={cursors.length === 1} onclick={() => historyPage(-1)}>Previous delivery page</button>
            <button disabled={deliveryHistory.isDone} onclick={() => historyPage(1)}>Next delivery page</button>
          </div>
        {/if}
      {:else if deliveryHistory}<p>No delivery history yet.</p>
      {:else}<p role="status">Loading delivery history…</p>{/if}
    {/if}
  {/if}
</section>
