import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

async function inventory(dist) {
  const files = [];
  async function visit(prefix) {
    const entries = await readdir(join(dist, prefix), { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(dist, path));
        files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else {
        throw new Error("Unexpected non-file asset: " + path);
      }
    }
  }
  await visit("");
  if (!files.some(file => file.path === "index.html")) throw new Error("Missing index.html");
  // Use the same ordering on Linux and Windows regardless of the process locale.
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, files };
}

export async function recordAssets(dist, manifest) {
  const assets = await inventory(dist);
  await writeFile(manifest, JSON.stringify(assets, null, 2) + "\n");
}

export async function verifyAssets(dist, manifest) {
  const expected = JSON.parse(await readFile(manifest, "utf8"));
  if (!isDeepStrictEqual(expected, await inventory(dist))) {
    throw new Error("Web asset manifest mismatch. Use the frontend from the verified browser build.");
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  const command = process.argv[2];
  if (!["record", "verify"].includes(command)) throw new Error("Expected record or verify");
  const action = command === "record" ? recordAssets : verifyAssets;
  await action(join(web, "dist"), join(web, "asset-manifest.json"));
}
