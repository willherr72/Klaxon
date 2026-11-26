import assert from "node:assert/strict";

// Windows adb shell translates LF to CRLF even with -T. Keep the transport textual.
export function readFixtureFile(adbBytes, app, path) {
  const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
  let encoded;
  try {
    encoded = adbBytes(["shell", "-T", "run-as", app, "base64", quoted]).toString("latin1").replace(/[\r\n]/g, "");
  } catch {
    throw new Error("Could not read an Android fixture file");
  }
  const bytes = Buffer.from(encoded, "base64");
  assert.ok(bytes.toString("base64") === encoded, "invalid Android fixture file encoding");
  return bytes;
}
