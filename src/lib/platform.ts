/// Lightweight runtime platform check. Used to skip Tauri commands /
/// plugin invocations that don't exist on mobile (global hotkey, auto-
/// start, etc.) — calling them on Android raises a "command not found"
/// error that bubbles into the UI.

export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("android") || /iphone|ipad|ipod/.test(ua);
}
