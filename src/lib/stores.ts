import { writable } from "svelte/store";
import type { Reminder } from "./types";

export const reminders = writable<Reminder[]>([]);
export const editingId = writable<string | null>(null);
export const editorOpen = writable<boolean>(false);
export const nowTick = writable<number>(Date.now());

// Tick rate management:
// - Paused entirely when the document is hidden (tray-resident or minimized)
// - Variable rate when visible: 1 s when a sub-day countdown needs HH:MM:SS
//   precision, slower (30 s) when only D HH:MM is displayed.
let tickRate = 1000;
let tickHandle: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (tickHandle !== null) return;
  if (typeof document !== "undefined" && document.hidden) return;
  nowTick.set(Date.now());
  tickHandle = setInterval(() => nowTick.set(Date.now()), tickRate);
}

function stop(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

export function setTickRate(ms: number): void {
  const clamped = Math.max(250, Math.floor(ms));
  if (clamped === tickRate) return;
  tickRate = clamped;
  if (tickHandle !== null) {
    stop();
    start();
  }
}

if (typeof window !== "undefined") {
  start();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
}
