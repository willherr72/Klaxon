// Optional P0-05 rehearsal on Windows with the installed desktop app.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withDisposableObsidian } from "./obsidian-desktop-host.mjs";

await withDisposableObsidian(process.argv[2], async ({ root, withVault }) => {
  const id = randomBytes(8).toString("hex");
  const vault = path.join(root, "P0 " + id);
  const original = "Planning/First café note.md";
  const renamed = "Planning/Renamed café note.md";
  const content = "Synthetic Klaxon P0 note " + id;
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await mkdir(path.join(vault, "Planning"));
  await writeFile(path.join(vault, original), content);
  await writeFile(path.join(vault, "Other.md"), "Synthetic control note");

  await withVault({ id, path: vault }, async (page, openNote) => {
    await openNote("Other.md");
    await openNote(original);
    await page.evaluate(async ({ original, renamed }) => {
      await window.app.fileManager.renameFile(window.app.workspace.getActiveFile(), renamed);
      if (window.app.vault.getAbstractFileByPath(original)) throw Error("Old path still resolves");
    }, { original, renamed });
    await openNote("Other.md");
    await openNote(renamed);
    assert.equal(await readFile(path.join(vault, renamed), "utf8"), content);
  });
});
console.log("PASS: desktop URI opened the selected note before and after manual rename reconciliation. Fixture removed.");
