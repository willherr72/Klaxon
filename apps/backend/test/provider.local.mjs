import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const apiPort = 3230;
const sitePort = 3231;
const url = `http://${host}:${apiPort}`;
const siteUrl = `http://${host}:${sitePort}`;
const offlineOrigin = `http://${host}:0`;
const prefix = "klaxon-p1-provider-";
const source = fileURLToPath(new URL("../", import.meta.url));

function run(label, executable, args, options) {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    timeout: 20_000,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    // CLI diagnostics can include deployment credentials.
    throw new Error(`${label} failed (${result.error?.code ?? result.status ?? result.signal})`);
  }
  return result.stdout;
}

function listeners(env) {
  const netstat = join(env.SystemRoot, "System32", "netstat.exe");
  const rows = run("Loopback listener check", netstat, ["-ano"], { env, timeout: 35_000 });
  return rows.split(/\r?\n/).flatMap(row => {
    const match = /^\s*TCP\s+(\S+):(323[01])\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/.exec(row);
    return match ? [{ address: match[1], port: Number(match[2]), pid: Number(match[3]) }] : [];
  });
}

async function waitForBackend(env, child, name) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Convex fixture exited during startup");
    }
    const rows = listeners(env);
    if (rows.some(row => row.address !== host || row.pid !== child.pid)) {
      throw new Error("Convex fixture ports must belong exclusively to its loopback process");
    }
    if ([apiPort, sitePort].every(port => rows.some(row => row.port === port))) {
      const response = await fetch(`${url}/instance_name`, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      if (response?.ok) {
        if (await response.text() !== name) throw new Error("Unexpected Convex instance on fixture port");
        return;
      }
    }
    await delay(150);
  }
  throw new Error("Convex fixture did not become ready");
}

async function removeFixture(fixture, tempRoot) {
  if (dirname(fixture) !== tempRoot || !basename(fixture).startsWith(prefix) ||
    await realpath(fixture) !== fixture) {
    throw new Error("Could not verify the Convex fixture directory for removal");
  }
  await rm(fixture, { recursive: true, maxRetries: 10, retryDelay: 100 });
}

export async function withLocalProvider(action) {
  if (process.platform !== "win32" || !isAbsolute(process.env.SystemRoot ?? "") ||
    !isAbsolute(process.env.LOCALAPPDATA ?? "")) {
    throw new Error("The provider test requires Windows and the pinned local Convex binary");
  }
  const systemEnv = { SystemRoot: process.env.SystemRoot };
  if (listeners(systemEnv).length) throw new Error("Provider fixture ports 3230 or 3231 are in use");
  const binary = join(process.env.LOCALAPPDATA, "convex", "binaries", "precompiled-2026-11-21-cf39368", "convex-local-backend.exe");
  const nodeModules = join(source, "node_modules");
  const cli = join(nodeModules, "convex", "bin", "main.js");
  if (!(await stat(binary).catch(() => undefined))?.isFile() || !(await stat(cli).catch(() => undefined))?.isFile()) {
    throw new Error("Install the pinned local Convex binary and run npm ci in apps/backend");
  }

  const tempRoot = await realpath(tmpdir());
  const fixture = await mkdtemp(join(tempRoot, prefix));
  let backend;
  let closed;
  const failures = [];
  try {
    const project = join(fixture, "project");
    const profile = join(fixture, "profile");
    const temp = join(fixture, "temp");
    const env = {
      ...systemEnv,
      CI: "1",
      HOME: profile,
      USERPROFILE: profile,
      LOCALAPPDATA: join(profile, "AppData", "Local"),
      APPDATA: join(profile, "AppData", "Roaming"),
      TEMP: temp,
      TMP: temp,
      CONVEX_PROVISION_HOST: offlineOrigin,
      CONVEX_VERSION_API_ORIGIN: offlineOrigin,
    };
    await Promise.all([project, env.LOCALAPPDATA, env.APPDATA, temp].map(dir => mkdir(dir, { recursive: true })));
    await Promise.all([
      cp(join(source, "convex"), join(project, "convex"), {
        recursive: true,
        filter: path => !basename(path).startsWith(".") && basename(path) !== "_generated",
      }),
      cp(join(source, "package.json"), join(project, "package.json")),
      symlink(nodeModules, join(project, "node_modules"), "junction"),
    ]);

    const name = `anonymous-klaxon-p1-${randomUUID()}`;
    const identity = ["--instance-name", name, "--instance-secret", randomBytes(32).toString("hex")];
    const options = { cwd: project, env, windowsHide: true };
    const adminKey = run("Convex fixture admin key generation", binary, ["keygen", "admin-key", ...identity], options).trim();
    if (!adminKey.startsWith(`${name}|`)) throw new Error("Invalid Convex fixture admin key");
    backend = spawn(binary, [
      "--interface", host, "--port", String(apiPort), "--site-proxy-port", String(sitePort),
      "--convex-origin", url, "--convex-site", siteUrl, "--disable-beacon", "--control-plane-url", offlineOrigin,
      ...identity, "--local-storage", join(fixture, "storage"), join(fixture, "backend.sqlite3"),
    ], { ...options, stdio: "ignore" });
    closed = new Promise(resolve => backend.once("close", () => resolve(true)));
    backend.on("error", () => {});
    await waitForBackend(systemEnv, backend, name);

    run("Local Convex deploy", process.execPath, [cli, "deploy", "--yes", "--typecheck", "disable"], {
      ...options,
      env: { ...env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
      stdio: "ignore",
      timeout: 120_000,
    });
    await action({ url, siteUrl, adminKey, generated: join(project, "convex", "_generated") });
  } catch (error) {
    failures.push(error);
  } finally {
    if (backend) {
      if (backend.pid && backend.exitCode === null && backend.signalCode === null) {
        // The local backend launches a Node action executor that inherits its fixture directory.
        const stopped = spawnSync(join(systemEnv.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(backend.pid), "/T", "/F"], { env: systemEnv, windowsHide: true, timeout: 10_000, stdio: "ignore" });
        if (stopped.status !== 0) {
          failures.push(new Error("Could not confirm shutdown of the Convex fixture process tree"));
          backend.kill();
        }
      }
      try {
        if (!await Promise.race([closed, delay(10_000, false, { ref: false })])) {
          throw new Error("Convex fixture process did not stop");
        }
        if (listeners(systemEnv).some(row => row.pid === backend.pid)) {
          throw new Error("Convex fixture retained a listener after cleanup");
        }
      } catch (error) {
        failures.push(error);
      }
    }
    await removeFixture(fixture, tempRoot).catch(error => failures.push(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Convex provider test and cleanup failed");
}
