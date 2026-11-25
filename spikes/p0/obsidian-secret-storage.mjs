// P0-05 desktop API rehearsal. All three values are inert markers.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withDisposableObsidian } from "./obsidian-desktop-host.mjs";

const name = "klaxon-p0-marker";
const markers = ["first", "replacement", "peer"].map(role =>
  "inert-p0-" + role + "-" + randomBytes(16).toString("hex"));
const [first, replacement, peer] = markers;

async function removeMarker(page) {
  await page.keyboard.press("Control+,");
  await page.getByText("Keychain", { exact: true }).click();
  const row = page.locator(".setting-item").filter({ has: page.getByText(name, { exact: true }) });
  await row.getByLabel("Delete", { exact: true }).click();
  const confirm = page.getByRole("button", { name: "Delete", exact: true });
  await Promise.race([row.waitFor({ state: "detached" }), confirm.waitFor({ state: "visible" })]);
  if (await confirm.isVisible()) await confirm.click();
  await page.waitForFunction(name => window.app.secretStorage.getSecret(name) === null &&
    !window.app.secretStorage.listSecrets().includes(name), name, { timeout: 10000 });
}

async function inspectVault(dir) {
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files += await inspectVault(target);
      continue;
    }
    assert.ok(entry.isFile(), "Unexpected non-regular entry in the disposable vault");
    const data = await readFile(target);
    for (const marker of markers) {
      for (const encoding of ["utf8", "utf16le"]) {
        assert.ok(!data.includes(Buffer.from(marker, encoding)), "Plaintext marker found in vault");
      }
    }
    files++;
  }
  return files;
}

await withDisposableObsidian(process.argv[2], async ({ root, withVault }) => {
  const vaults = ["A", "B"].map(label => ({
    id: randomBytes(8).toString("hex"), path: path.join(root, "Vault " + label),
  }));
  for (const vault of vaults) {
    await mkdir(path.join(vault.path, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault.path, "Control.md"), "Synthetic note in " + path.basename(vault.path));
  }

  async function check(vault, expected, next, afterRead) {
    await withVault(vault, async page => {
      await page.waitForFunction(() => window.app?.workspace?.layoutReady &&
        typeof window.app?.secretStorage?.listSecrets === "function", null, { timeout: 20000 });
      const ok = await page.evaluate(({ name, expected, next }) => {
        const store = window.app.secretStorage;
        if (store.getSecret(name) !== expected || store.listSecrets().includes(name) !== (expected !== null)) {
          return false;
        }
        if (next === undefined) return true;
        store.setSecret(name, next);
        return store.getSecret(name) === next && store.listSecrets().includes(name);
      }, { name, expected, next });
      assert.ok(ok, "SecretStorage returned an unexpected result in " + path.basename(vault.path));
      if (afterRead) await afterRead(page);
    });
    for (const candidate of vaults) assert.ok(await inspectVault(candidate.path) > 0);
  }

  const [a, b] = vaults;
  await check(a, null, first);
  await check(b, null, peer);
  await check(a, first, replacement);
  await check(a, replacement, undefined, removeMarker);
  await check(b, peer);
  await check(a, null);
});
console.log("PASS: two desktop vaults reused one secret name across six launches. Replacement and Keychain deletion persisted. The peer marker survived. Vault file scans and cleanup passed.");
