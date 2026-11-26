(() => {
  const worker = globalThis;
  const scope = new worker.URL(worker.registration.scope);
  const indexPath = new worker.URL('index.html', scope).pathname;
  const dbName = `klaxon-reminders:${scope.href}`;
  const limit = 128;
  const route = '#/reminders';
  const title = 'Klaxon reminder';
  const kind = 'klaxon.reminder';
  const identityFields = ['workspacePublicId', 'subscriptionPublicId', 'reminderPublicId', 'occurrencePublicId', 'attemptPublicId'];
  const payloadFields = [...identityFields, 'version', 'kind', 'reminderRevision', 'dueAt', 'title'];
  let work = Promise.resolve();

  function enqueue(action) {
    const result = work.then(action);
    work = result.catch(() => {});
    return result;
  }

  function appEntry(url) {
    const entry = new worker.URL(url);
    return entry.origin === scope.origin && (entry.pathname === scope.pathname || entry.pathname === indexPath);
  }

  function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/u.test(value)
      && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  }

  function hasFields(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  }

  function parseReminder(data) {
    try {
      const text = data?.text();
      if (!text || text.length > 4096) return undefined;
      const message = JSON.parse(text);
      if (hasFields(message, payloadFields) && message.version === 1 && message.kind === kind && message.title === title
        && identityFields.every(key => validId(message[key])) && Number.isSafeInteger(message.reminderRevision)
        && message.reminderRevision > 0 && Number.isSafeInteger(message.dueAt) && Math.abs(message.dueAt) <= 8.64e15) return message;
    } catch {
      // Ignore malformed push envelopes.
    }
  }

  async function hash(text) {
    const digest = await worker.crypto.subtle.digest('SHA-256', new worker.TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function endpointHash() {
    const subscription = await worker.registration.pushManager.getSubscription();
    return subscription?.endpoint ? hash(subscription.endpoint) : undefined;
  }

  async function changeState(change) {
    const db = await new Promise((resolve, reject) => {
      const request = worker.indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('device');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('device', 'readwrite');
        const store = transaction.objectStore('device');
        const request = store.get('current');
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error);
        request.onsuccess = () => {
          try {
            result = change(request.result, state => state ? store.put(state, 'current') : store.delete('current'));
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        };
      });
    } finally {
      db.close();
    }
  }

  function sameDevice(state, endpoint, { workspacePublicId, subscriptionPublicId }) {
    return state && endpoint && state.endpoint === endpoint
      && state.workspacePublicId === workspacePublicId && state.subscriptionPublicId === subscriptionPublicId;
  }

  function storeReceipt(state, reminder) {
    const { reminderPublicId, occurrencePublicId, reminderRevision, attemptPublicId } = reminder;
    if (state.receipts.some(receipt => receipt.attemptPublicId === attemptPublicId)) return;
    state.receipts = [...state.receipts, { reminderPublicId, occurrencePublicId, reminderRevision, attemptPublicId, receivedAt: Date.now() }].slice(-limit);
  }

  async function deliver(reminder) {
    const endpoint = await endpointHash();
    const { occurrencePublicId } = reminder;
    const first = await changeState((state, save) => {
      if (!sameDevice(state, endpoint, reminder)) return false;
      const prior = state.occurrences.find(item => item.id === occurrencePublicId);
      if (prior) {
        if (prior.displayed) {
          storeReceipt(state, reminder);
          save(state);
        }
        return false;
      }
      state.occurrences = [...state.occurrences, { id: occurrencePublicId, displayed: false }].slice(-limit);
      save(state);
      return true;
    });
    if (!first) return;

    try {
      const tag = `klaxon-${await hash(JSON.stringify([endpoint, occurrencePublicId]))}`;
      await worker.registration.showNotification(title, { tag, icon: new worker.URL('pwa-icon-192.png', scope).href, data: { kind } });
    } catch (error) {
      await changeState((state, save) => {
        if (!sameDevice(state, endpoint, reminder)) return;
        state.occurrences = state.occurrences.filter(item => item.id !== occurrencePublicId);
        save(state);
      });
      throw error;
    }

    await changeState((state, save) => {
      if (!sameDevice(state, endpoint, reminder)) return;
      const occurrence = state.occurrences.find(item => item.id === occurrencePublicId);
      if (!occurrence) return;
      occurrence.displayed = true;
      storeReceipt(state, reminder);
      save(state);
    });
  }

  async function closeReminders() {
    for (const notification of await worker.registration.getNotifications()) {
      if (notification.data?.kind === kind) notification.close();
    }
  }

  async function deviceCommand(data) {
    const fields = ['type', 'version'];
    if (data.type === 'KLAXON_PUSH_RESET' && hasFields(data, fields)) {
      await changeState((_, save) => save());
      await closeReminders();
      return { ok: true };
    }
    if (data.type === 'KLAXON_PUSH_CONFIGURE' && hasFields(data, [...fields, 'workspacePublicId', 'subscriptionPublicId'])
      && validId(data.workspacePublicId) && validId(data.subscriptionPublicId)) {
      const endpoint = await endpointHash();
      if (!endpoint) return { ok: false };
      const { workspacePublicId, subscriptionPublicId } = data;
      const changed = await changeState((state, save) => {
        if (sameDevice(state, endpoint, data)) return false;
        save({ endpoint, workspacePublicId, subscriptionPublicId, occurrences: [], receipts: [] });
        return Boolean(state);
      });
      if (changed) await closeReminders();
      return { ok: true };
    }
    if (data.type === 'KLAXON_PUSH_READ_RECEIPTS' && hasFields(data, fields)) {
      const endpoint = await endpointHash();
      const batch = await changeState(state => state && endpoint && state.endpoint === endpoint ? {
        workspacePublicId: state.workspacePublicId, subscriptionPublicId: state.subscriptionPublicId,
        receipts: state.receipts.filter(receipt => Object.hasOwn(receipt, 'receivedAt')),
      } : null);
      return { ok: true, batch };
    }
    if (data.type === 'KLAXON_PUSH_CLEAR_RECEIPTS' && hasFields(data, [...fields, 'attemptPublicIds'])
      && Array.isArray(data.attemptPublicIds) && data.attemptPublicIds.length <= limit && data.attemptPublicIds.every(validId)) {
      const endpoint = await endpointHash();
      const confirmed = new Set(data.attemptPublicIds);
      await changeState((state, save) => {
        if (!state || !endpoint || state.endpoint !== endpoint) return;
        state.receipts = state.receipts.map(receipt => confirmed.has(receipt.attemptPublicId) ? { attemptPublicId: receipt.attemptPublicId } : receipt);
        save(state);
      });
      return { ok: true };
    }
    return { ok: false };
  }

  worker.addEventListener('message', event => {
    const { data, source, ports } = event;
    if (data?.version !== 1 || typeof data.type !== 'string' || !data.type.startsWith('KLAXON_PUSH_')
      || source?.type !== 'window' || !appEntry(source.url) || !ports[0]) return;
    event.waitUntil(enqueue(() => deviceCommand(data)).then(
      reply => ports[0].postMessage(reply),
      () => ports[0].postMessage({ ok: false }),
    ));
  });

  worker.addEventListener('push', event => {
    const reminder = parseReminder(event.data);
    if (reminder) event.waitUntil(enqueue(() => deliver(reminder)));
  });

  worker.addEventListener('notificationclick', event => {
    if (event.notification.data?.kind !== kind) return;
    event.notification.close();
    event.waitUntil((async () => {
      const windows = await worker.clients.matchAll({ type: 'window' });
      const existing = windows.find(client => appEntry(client.url));
      if (existing) {
        existing.postMessage({ type: 'KLAXON_OPEN_REMINDERS', route });
        await existing.focus();
      } else {
        await worker.clients.openWindow(new worker.URL(route, scope).href);
      }
    })());
  });
})();
