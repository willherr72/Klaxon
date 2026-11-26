export type PushDevice = { workspacePublicId: string; subscriptionPublicId: string };
export type PushReceipt = {
  reminderPublicId: string;
  occurrencePublicId: string;
  reminderRevision: number;
  attemptPublicId: string;
  receivedAt: number;
};
export type PushReceiptBatch = PushDevice & { receipts: PushReceipt[] };

type PushCommand =
  | ({ type: 'KLAXON_PUSH_CONFIGURE' } & PushDevice)
  | { type: 'KLAXON_PUSH_READ_RECEIPTS' | 'KLAXON_PUSH_RESET' }
  | { type: 'KLAXON_PUSH_CLEAR_RECEIPTS'; attemptPublicIds: string[] };

async function request<T>(command: PushCommand) {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"][data-klaxon-pwa]');
  if (!manifest || !('serviceWorker' in navigator)) throw new Error('Reminder worker unavailable');
  const scope = new URL('.', manifest.href);
  if (scope.origin !== location.origin) throw new Error('Reminder worker unavailable');
  const registration = await navigator.serviceWorker.getRegistration(scope.href);
  const active = registration?.active;
  if (!active || active.scriptURL !== new URL('pwa-sw.js', scope).href) throw new Error('Reminder worker unavailable');
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Reminder worker timed out'));
    }, 5_000);
    function finish() {
      clearTimeout(timeout);
      channel.port1.close();
    }
    channel.port1.onmessage = event => {
      finish();
      if (event.data?.ok === true) resolve(event.data as T);
      else reject(new Error('Reminder worker rejected the request'));
    };
    try {
      active.postMessage({ version: 1, ...command }, [channel.port2]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export async function configurePushDevice(device: PushDevice) {
  await request({ type: 'KLAXON_PUSH_CONFIGURE', ...device });
}

export async function readPushReceipts() {
  const response = await request<{ batch: PushReceiptBatch | null }>({ type: 'KLAXON_PUSH_READ_RECEIPTS' });
  return response.batch;
}

export async function clearPushReceipts(attemptPublicIds: string[]) {
  await request({ type: 'KLAXON_PUSH_CLEAR_RECEIPTS', attemptPublicIds });
}

export async function resetPushDevice() {
  await request({ type: 'KLAXON_PUSH_RESET' });
}
