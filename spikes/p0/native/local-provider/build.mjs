import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { hostedProviderConnections } from "../../build-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const native = dirname(here);
export const controlScript = join(native, ".run", "local-provider-control.js");
const target = join(native, "src-tauri", "target", "sign-out-http");
export const executable = join(target, "debug", "windows_local_provider.exe");
const hostedTarget = join(native, "src-tauri", "target", "hosted-provider");
export const hostedExecutable = join(hostedTarget, "debug", "windows_local_provider.exe");

export async function buildControlScript() {
  await mkdir(dirname(controlScript), { recursive: true });
  await build({
    entryPoints: [join(here, "control.js")], bundle: true, platform: "browser",
    outfile: controlScript, minify: true, logLevel: "warning",
  });
}

export async function buildLocalProvider(reconnectPort) {
  if (process.platform !== "win32") throw Error("The packaged provider exercise requires Windows.");
  if (reconnectPort !== undefined && !(Number.isInteger(reconnectPort) && reconnectPort > 0 && reconnectPort <= 65535)) {
    throw Error("Invalid subscription relay port");
  }
  await buildControlScript();
  return buildProvider({ reconnectPort });
}

export async function buildHostedProvider(origin) {
  const connections = hostedProviderConnections(origin);
  return buildProvider({ origin, connections });
}

async function buildProvider({ reconnectPort, origin, connections }) {
  const subdir = origin ? "hosted-provider-frontend" : "local-provider-frontend";
  const assets = join(native, ".run", subdir);
  await mkdir(assets, { recursive: true });
  await build({
    entryPoints: [join(here, "client.js")], bundle: true, platform: "browser",
    outfile: join(assets, "client.js"), minify: true, logLevel: "warning",
    define: origin ? { P0_PROVIDER_ORIGIN: JSON.stringify(origin) } : {},
  });
  await writeFile(join(assets, "index.html"),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Klaxon local provider test</title>' +
    (origin ? `<meta name="p0-hosted-provider" content="${origin}">` : "") +
    '<body><main id="app"></main><script src="./client.js"></script></body></html>');
  const overlay = {
    identifier: origin ? "dev.klaxon.p0hostedprovider" : "dev.klaxon.p0localprovider",
    build: { frontendDist: "../.run/" + subdir },
    app: { withGlobalTauri: true, security: { csp: [
      "default-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
      "connect-src 'self' " + (connections ?? ("ipc: http://ipc.localhost http://127.0.0.1:3210 ws://127.0.0.1:" + (reconnectPort ?? 3210))),
    ].join("; ") } },
  };
  execFileSync("cargo", [
    "build", "--locked", "--offline", "--manifest-path", join(native, "src-tauri", "Cargo.toml"),
    "--target-dir", origin ? hostedTarget : target, "--bin", "windows_local_provider", "--features",
    "custom-protocol,p0-local-provider" + (origin ? ",p0-hosted-provider" : ""),
  ], { env: { ...process.env, TAURI_CONFIG: JSON.stringify(overlay), KLAXON_P0_HOSTED_ORIGIN: origin ?? "" }, stdio: "inherit" });
}
