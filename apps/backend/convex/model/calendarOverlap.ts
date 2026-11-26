import type { Interval } from "./calendarTime";

const signBit = 1n << 63n;
const floatBits = new DataView(new ArrayBuffer(8));

// Map IEEE-754 numbers to unsigned integers in numeric order, including
// fractional timestamps in old rows. Normalize both representations of zero.
function orderedBits(value: number) {
  floatBits.setFloat64(0, value === 0 ? 0 : value);
  const bits = floatBits.getBigUint64(0);
  return bits & signBit ? BigInt.asUintN(64, ~bits) : bits ^ signBit;
}

function indexKey(bits: bigint) {
  return bits.toString(16).padStart(16, "0");
}

export function overlapFields({ startAt, endAt }: Interval) {
  if (!(startAt < endAt)) return { overlapPivot: "" };
  const start = orderedBits(startAt);
  const end = orderedBits(endAt);
  // Store the split in the smallest binary subtree containing both endpoints.
  // Its pivot is strictly above start and at or below end.
  const split = 1n << BigInt((start ^ end).toString(2).length - 1);
  return { overlapPivot: indexKey(end & -split) };
}

export function exteriorPivots(value: number, side: "left" | "right") {
  const bits = orderedBits(value);
  const pivots: string[] = [];
  for (let split = 1n; split <= signBit; split <<= 1n) {
    const pivot = (bits & -(split << 1n)) | split;
    if (side === "left" ? pivot <= bits : pivot > bits) pivots.push(indexKey(pivot));
  }
  return pivots;
}

export function pivotKey(value: number) {
  return indexKey(orderedBits(value));
}
