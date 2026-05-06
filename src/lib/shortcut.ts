/**
 * Capture a key combo from a KeyboardEvent. Returns a Tauri-formatted combo
 * (e.g. "Ctrl+Alt+KeyN") or null if the event is unsuitable (lone modifier,
 * no modifier at all, no key code).
 */
export function keyEventToCombo(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
    return null;
  }
  if (!e.code) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  if (parts.length === 0) return null; // require at least one modifier
  parts.push(e.code);
  return parts.join("+");
}

/** Render a combo string for display: "Ctrl+Alt+KeyN" → "CTRL + ALT + N". */
export function prettyShortcut(combo: string): string {
  if (!combo || !combo.trim()) return "—";
  return combo
    .split("+")
    .map((p) => {
      if (p.startsWith("Key")) return p.slice(3);
      if (p.startsWith("Digit")) return p.slice(5);
      if (p === "Control") return "Ctrl";
      return p;
    })
    .map((p) => p.toUpperCase())
    .join(" + ");
}

/** Match a combo string against a KeyboardEvent. */
export function comboMatches(combo: string, e: KeyboardEvent): boolean {
  if (!combo || !combo.trim()) return false;
  const parts = combo.split("+");
  const wantCtrl = parts.includes("Ctrl") || parts.includes("Control");
  const wantAlt = parts.includes("Alt");
  const wantShift = parts.includes("Shift");
  const wantMeta =
    parts.includes("Meta") || parts.includes("Cmd") ||
    parts.includes("Super") || parts.includes("CommandOrControl");
  const code = parts[parts.length - 1];
  return (
    e.ctrlKey === wantCtrl &&
    e.altKey === wantAlt &&
    e.shiftKey === wantShift &&
    e.metaKey === wantMeta &&
    e.code === code
  );
}
