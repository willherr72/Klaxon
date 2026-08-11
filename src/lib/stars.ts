import type { Priority } from "./types";

/// Single source of the star mapping: low = ★, normal = ★★, high = ★★★.
/// Index order must match Priority's semantic order.
const LEVELS: Priority[] = ["low", "normal", "high"];

export function starCount(p: Priority): number {
  return LEVELS.indexOf(p) + 1;
}

export function priorityForStars(n: number): Priority {
  return LEVELS[Math.min(Math.max(n, 1), 3) - 1];
}
