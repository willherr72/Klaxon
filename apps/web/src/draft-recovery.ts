import { getContext, onDestroy, setContext, untrack } from 'svelte';

type Drafts = Map<string, unknown>;
const context = Symbol('planner recovery');

export function createDraftRecovery(route: () => string) {
  const readers = new Map<string, () => unknown>();
  let restored: { route: string; drafts: Drafts } | undefined;
  setContext(context, {
    register(key: string, read: () => unknown) {
      readers.set(key, read);
      onDestroy(() => { if (readers.get(key) === read) readers.delete(key); });
      if (restored?.route !== untrack(route)) return;
      const value = restored.drafts.get(key);
      restored.drafts.delete(key);
      return value;
    },
  });
  return {
    capture() {
      const drafts: Drafts = new Map();
      for (const [key, read] of readers) {
        const value = read();
        if (value !== undefined) drafts.set(key, value);
      }
      return drafts;
    },
    restore(drafts?: Drafts) {
      restored = drafts && { route: route(), drafts };
    },
  };
}

export function recoverDraft<T>(key: string, read: () => T | undefined): T | undefined {
  return getContext<{ register: (key: string, read: () => unknown) => unknown } | undefined>(context)
    ?.register(key, read) as T | undefined;
}
