import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const apiPort = 3210;
const sitePort = 3211;
const url = `http://${host}:${apiPort}`;
const siteUrl = `http://${host}:${sitePort}`;
const offlineOrigin = `http://${host}:0`;
const tempPrefix = "klaxon-p0-provider-";
const spikeRoot = fileURLToPath(new URL("../../", import.meta.url));
const nodeModules = join(spikeRoot, "node_modules");

function run(label, executable, args, options) {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    timeout: 10000,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    // Spawn errors and CLI output can contain the key or process arguments.
    throw new Error(`${label} failed (${result.error?.code ?? result.status ?? result.signal ?? "unknown"})`);
  }
  return result.stdout;
}

function listeners(systemEnv) {
  const netstat = join(systemEnv.SystemRoot, "System32", "netstat.exe");
  const rows = run("Convex listener check", netstat, ["-ano"], { env: systemEnv });
  return rows.split(/\r?\n/).flatMap(row => {
    // The wildcard peer identifies listeners without depending on Windows' display language.
    const match = /^\s*TCP\s+(\S+):(321[01])\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/.exec(row);
    return match ? [{ address: match[1], port: Number(match[2]), pid: Number(match[3]) }] : [];
  });
}

function ownBothListeners(systemEnv, child) {
  const rows = listeners(systemEnv);
  if (rows.some(row => row.address !== host || row.pid !== child.pid)) {
    throw new Error("Convex ports are not exclusively bound to the fixture process on loopback");
  }
  return rows.some(row => row.port === apiPort) && rows.some(row => row.port === sitePort);
}

function localRequest(path, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      port: apiPort,
      path,
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      agent: false,
      signal: AbortSignal.timeout(2000),
    }, res => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", chunk => {
        text += chunk;
        if (text.length > 16384) req.destroy(new Error("Local Convex response is too large"));
      });
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, text }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function ready(systemEnv, child, instanceName) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Local Convex backend exited before it was ready");
    }
    const response = await localRequest("/instance_name").catch(() => undefined);
    if (response?.status === 200) {
      if (response.text !== instanceName) throw new Error("Unexpected Convex instance on the fixture port");
      if (ownBothListeners(systemEnv, child)) return;
    }
    await delay(150);
  }
  throw new Error("Local Convex backend did not become ready on both fixture ports");
}

async function verifyPush() {
  try {
    const response = await localRequest("/api/query", JSON.stringify({ path: "tasks:list", args: {}, format: "json" }));
    const result = JSON.parse(response.text);
    if (response.status === 200 && result.status === "success" && Array.isArray(result.value) && result.value.length === 0) return;
  } catch {
    // Keep health-check responses out of failures sent to the caller.
  }
  throw new Error("The deployed Convex tasks query did not return an empty anonymous result");
}

function copyTrackedProject(workspace, env) {
  const options = { cwd: spikeRoot, env: { ...env, Path: process.env.Path } };
  const entries = run("Convex source inventory", "git.exe", [
    "ls-files", "--stage", "-z", "--", "convex", "convex.json", "package.json", "package-lock.json",
  ], options);
  // Only regular files from the Git index. Exclude dotfiles and generated code.
  const files = entries.split("\0").flatMap(entry => {
    const match = /^100(?:644|755) [0-9a-f]+ 0\t((?:convex|package(?:-lock)?)\.json|convex\/(?!_generated\/)(?:[\w-]+\/)*[\w.-]+\.(?:ts|js|json))$/.exec(entry);
    return match && !match[1].split("/").some(segment => segment.startsWith(".")) ? [match[1]] : [];
  });
  run("Convex source copy", "git.exe", [
    "checkout-index", `--prefix=${workspace.replaceAll("\\", "/")}/`, "--stdin", "-z",
  ], { ...options, input: files.join("\0") + "\0" });
}

async function stopBackend(child, closed, systemEnv) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  const stopped = await Promise.race([closed, delay(10000, false, { ref: false })]);
  if (!stopped) throw new Error("The fixture Convex process did not stop");
  if (listeners(systemEnv).length) throw new Error("Convex fixture ports still have listeners after cleanup");
}

async function removeWorkspace(workspace, tempRoot) {
  const entry = await lstat(workspace);
  if (dirname(workspace) !== tempRoot || !basename(workspace).startsWith(tempPrefix) ||
    !entry.isDirectory() || entry.isSymbolicLink() || await realpath(workspace) !== workspace) {
    throw new Error("Could not verify ownership of the Convex fixture directory for cleanup");
  }
  try {
    await rm(workspace, { recursive: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    throw new Error("Could not remove the Convex fixture directory");
  }
}

export async function withLocalBackend(action) {
  if (process.platform !== "win32" || !isAbsolute(process.env.SystemRoot ?? "") ||
    !isAbsolute(process.env.LOCALAPPDATA ?? "")) {
    throw new Error("The local Convex fixture requires Windows and its cached backend");
  }
  const systemEnv = { SystemRoot: process.env.SystemRoot };
  if (listeners(systemEnv).length) throw new Error("Convex fixture ports 3210 or 3211 are already in use");
  const binary = join(process.env.LOCALAPPDATA, "convex", "binaries", "precompiled-2026-11-21-cf39368", "convex-local-backend.exe");
  const cli = join(nodeModules, "convex", "bin", "main.js");
  if (!(await stat(binary).catch(() => undefined))?.isFile() || !(await stat(cli).catch(() => undefined))?.isFile()) {
    throw new Error("The pinned Convex binary and spikes/p0 node_modules must be installed");
  }

  const tempRoot = await realpath(tmpdir());
  const workspace = await mkdtemp(join(tempRoot, tempPrefix));
  let backend;
  let closed;
  let result;
  const failures = [];
  try {
    // checkout-index preserves the path relative to the repository root.
    const project = join(workspace, "spikes", "p0");
    const profile = join(workspace, "profile");
    const env = {
      ...systemEnv,
      CI: "1",
      HOME: profile,
      USERPROFILE: profile,
      LOCALAPPDATA: join(profile, "AppData", "Local"),
      APPDATA: join(profile, "AppData", "Roaming"),
      TEMP: join(workspace, "temp"),
      TMP: join(workspace, "temp"),
      CONVEX_PROVISION_HOST: offlineOrigin,
      CONVEX_VERSION_API_ORIGIN: offlineOrigin,
    };
    await Promise.all([project, env.LOCALAPPDATA, env.APPDATA, env.TEMP].map(dir => mkdir(dir, { recursive: true })));
    copyTrackedProject(workspace, env);
    await symlink(nodeModules, join(project, "node_modules"), "junction");

    const instanceName = `anonymous-klaxon-p0-${randomUUID()}`;
    const instanceSecret = randomBytes(32).toString("hex");
    const identity = ["--instance-name", instanceName, "--instance-secret", instanceSecret];
    const childOptions = { cwd: project, env, windowsHide: true };
    const adminKey = run("Local Convex admin key generation", binary, ["keygen", "admin-key", ...identity], childOptions).trim();
    if (!adminKey.startsWith(`${instanceName}|`)) throw new Error("Local Convex generated an invalid admin key");
    if (listeners(systemEnv).length) throw new Error("Convex fixture ports 3210 or 3211 are already in use");
    backend = spawn(binary, [
      "--interface", host, "--port", String(apiPort), "--site-proxy-port", String(sitePort),
      "--convex-origin", url, "--convex-site", siteUrl, "--disable-beacon", "--control-plane-url", offlineOrigin,
      ...identity, "--local-storage", join(workspace, "storage"), join(workspace, "backend.sqlite3"),
    ], { ...childOptions, stdio: "ignore" });
    closed = new Promise(resolve => backend.once("close", () => resolve(true)));
    backend.on("error", () => {});
    await ready(systemEnv, backend, instanceName);

    // Self-hosted mode skips cloud checks. The spike's pinned dependencies lack Node types for users.ts.
    run("Local Convex function push", process.execPath, [cli, "deploy", "--yes", "--typecheck", "disable"], {
      ...childOptions,
      env: { ...env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
      stdio: "ignore",
      timeout: 120000,
    });
    await verifyPush();
    if (!ownBothListeners(systemEnv, backend)) throw new Error("Local Convex listener disappeared after the push");
    result = await action({ url, siteUrl });
  } catch (error) {
    failures.push(error);
  } finally {
    if (backend) {
      await stopBackend(backend, closed, systemEnv).catch(error => failures.push(error));
    }
    await removeWorkspace(workspace, tempRoot).catch(error => failures.push(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Local Convex fixture and cleanup failed");
  return result;
}
