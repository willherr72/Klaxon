import { writable } from "svelte/store";
import type { FilterKey, Reminder } from "./types";

export const reminders = writable<Reminder[]>([]);
export const filter = writable<FilterKey>("all");
export const editingId = writable<string | null>(null);
export const editorOpen = writable<boolean>(false);
export const nowTick = writable<number>(Date.now());

if (typeof window !== "undefined") {
  setInterval(() => nowTick.set(Date.now()), 1000);
}
