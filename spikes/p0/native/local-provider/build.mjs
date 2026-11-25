import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const native = dirname(here);
const assets = join(native, ".run", "local-provider-frontend");
export const controlScript = join(native, ".run", "local-provider-control.js");
const target = join(native, "src-tauri", "target", "sign-out-http");
export const executable = join(target, "debug", "windows_local_provider.exe");

export async function buildLocalProvider() {
  if (process.platform !== "win32") throw Error("The packaged provider exercise requires Windows.");
  await mkdir(assets, { recursive: true });
  await build({
    entryPoints: [join(here, "control.js")], bundle: true, platform: "browser",
    outfile: controlScript, minify: true, logLevel: "warning",
  });
  await build({
    entryPoints: [join(here, "client.js")], bundle: true, platform: "browser",
    outfile: join(assets, "client.js"), minify: true, logLevel: "warning",
  });
  await writeFile(join(assets, "index.html"),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Klaxon local provider test</title>' +
    '<body><main id="app"></main><script src="./client.js"></script></body></html>');
  const overlay = {
    identifier: "dev.klaxon.p0localprovider", build: { frontendDist: "../.run/local-provider-frontend" },
    app: { withGlobalTauri: true, security: { csp: [
      "default-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
      "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:3210 ws://127.0.0.1:3210",
    ].join("; ") } },
  };
  execFileSync("cargo", [
    "build", "--locked", "--offline", "--manifest-path", join(native, "src-tauri", "Cargo.toml"),
    "--target-dir", target, "--bin", "windows_local_provider", "--features", "custom-protocol,p0-local-provider",
  ], { env: { ...process.env, TAURI_CONFIG: JSON.stringify(overlay) }, stdio: "inherit" });
}
