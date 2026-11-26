import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProfileBytes } from "./web-check.mjs";
import { readFixtureFile } from "./adb-file.mjs";

test("Android fixture reads preserve binary bytes and quote the remote filename", () => {
  const original = Buffer.from([0, 10, 13, 255]);
  const adb = args => {
    assert.deepEqual(args, ["shell", "-T", "run-as", "fixture", "base64", "'cache/a '\\''b'"]);
    return Buffer.from("AAoN\r\n/w==\r\n");
  };
  assert.deepEqual(readFixtureFile(adb, "fixture", "cache/a 'b"), original);
  assert.throws(() => readFixtureFile(() => Buffer.from("corrupt!"), "fixture", "cache/file"),
    /invalid Android fixture file encoding/);
});

test("retired profile scan accepts clean binary chunks and counts the bytes", async () => {
  assert.equal(await checkProfileBytes([Buffer.alloc(123), Buffer.from("fixture")]), 130);
});

test("retired profile scan rejects encoded canaries split across unaligned chunks", async () => {
  for (const value of ["KLAXON-P0-INERT/packaged/3", "p0-inert-access-a"]) {
    for (const form of [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")]) {
      for (const encoding of ["latin1", "utf16le"]) {
        const input = Buffer.concat([Buffer.alloc(1), Buffer.from(form, encoding)]);
        const chunks = Array.from(input, byte => Buffer.from([byte]));
        await assert.rejects(checkProfileBytes(chunks), /session material in retired WebView profile/);
      }
    }
  }
});
