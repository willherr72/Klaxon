import { execFileSync } from "node:child_process";
import { constants, existsSync, lstatSync } from "node:fs";
import { copyFile, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { androidProviderPreflightConnections, convexDevelopmentOriginPattern, hostedProviderConnections } from "../build-policy.mjs";

const { values } = parseArgs({ options: {
  target: { type: "string", default: "windows" },
  origin: { type: "string" },
  session: { type: "boolean" },
  "sign-out-http": { type: "boolean" },
  "android-provider-preflight": { type: "boolean" },
  "android-provider-hosted": { type: "boolean" },
} });
const signOutHttp = values["sign-out-http"];
const androidProviderPreflight = values["android-provider-preflight"];
const androidProviderHosted = values["android-provider-hosted"];
const androidProvider = androidProviderPreflight || androidProviderHosted;
const androidProviderMode = androidProviderHosted ? "android-provider-hosted" : "android-provider-preflight";
if (androidProviderHosted && (values.target !== "x86_64" || !values.session || signOutHttp ||
    androidProviderPreflight || !convexDevelopmentOriginPattern.test(values.origin))) {
  throw Error("Android hosted provider requires --target x86_64 --session and a plain HTTPS Convex --origin");
}
if (androidProviderPreflight && (values.target !== "x86_64" || !values.session || values.origin !== undefined || signOutHttp)) {
  throw new Error("Android provider preflight requires --target x86_64 --session without --origin or --sign-out-http");
}
if (signOutHttp && (!values.session || values.target !== "windows" || values.origin !== undefined)) {
  throw new Error("HTTP sign-out requires the offline Windows session fixture");
}
if (values.session && !androidProviderHosted && (values.origin !== undefined || !["windows", "x86_64"].includes(values.target))) {
  throw new Error("The packaged session fixture requires offline Windows or Android x86_64");
}
if (!["windows", "x86_64", "aarch64"].includes(values.target)) throw new Error("Choose windows, x86_64 or aarch64");
if (values.origin !== undefined && !convexDevelopmentOriginPattern.test(values.origin)) {
  throw new Error("Pass only the HTTPS origin of the selected disposable Convex Development deployment");
}
const native = fileURLToPath(new URL(".", import.meta.url));
const spike = fileURLToPath(new URL("../", import.meta.url));
const run = join(native, ".run");
const androidHome = join(run, "android-user");
const gradle = join(native, "src-tauri/gen/android");
const androidFixtureSources = [
  ["packaged-session/SessionPlugin.kt", "dev/klaxon/p0native"],
  ["android-session/src/main/java/dev/klaxon/p0session/FixtureStore.java", "dev/klaxon/p0session"],
  ["packaged-session/LocalProviderPlugin.kt", "dev/klaxon/p0native", true],
].map(([source, pkg, preflightOnly = false]) => ({
  preflightOnly,
  source: join(native, source),
  destination: join(gradle, "app/src/debug/java", pkg, basename(source)),
}));
const config = join(run, androidProvider ? androidProviderMode + ".json" : "native-csp.json");
await mkdir(run, { recursive: true });
const env = { ...process.env, ANDROID_USER_HOME: androidHome, P0_PUBLIC_DEV_ORIGIN: values.origin ?? "" };
if (androidProviderHosted) env.KLAXON_P0_HOSTED_ORIGIN = values.origin;
const execute = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: "inherit" });

async function build() {
  if (values.target !== "windows") {
    // Gradle compiles these paths in every debug APK, even without p0-session.
    for (const { destination } of androidFixtureSources) {
      if (lstatSync(destination, { throwIfNoEntry: false })) {
        throw new Error("Found staged Android fixture source at " + destination +
          ". Verify any interrupted build has stopped, then move this file out of the generated Android source tree before retrying.");
      }
    }
  }
  const windowsSession = values.target === "windows" && values.session;
  let frontend = ".frontend";
  if (windowsSession) frontend = ".run/windows-session-frontend";
  if (androidProvider) frontend = ".run/" + androidProviderMode + "-frontend";
  execute(process.execPath, ["build-portable.mjs", "--outdir", "native/" + frontend,
    ...(values.session ? ["--session"] : []), ...(windowsSession ? ["--windows-tasks"] : []),
    ...(androidProvider ? ["--" + androidProviderMode] : [])], spike);
  let connections = values.origin ? values.origin + " " + values.origin.replace(/^https:/, "wss:") : "'none'";
  if (androidProviderPreflight) connections = androidProviderPreflightConnections;
  if (androidProviderHosted) connections = hostedProviderConnections(values.origin);
  const overlay = JSON.stringify({ ...((windowsSession || androidProvider) && { build: { frontendDist: "../" + frontend } }), app: { withGlobalTauri: !!values.session, security: {
    csp: "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; connect-src " + connections,
  } } });
  await writeFile(config, overlay);
  if (values.target === "windows") {
    env.TAURI_CONFIG = overlay;
    const features = ["custom-protocol"];
    if (signOutHttp) {
      features.push("p0-windows-sign-out-http");
      env.CARGO_NET_OFFLINE = "true";
      env.CARGO_TARGET_DIR = join(native, "src-tauri/target/sign-out-http");
    } else if (windowsSession) {
      features.push("p0-session");
    }
    const args = [...(windowsSession ? ["--bin", "windows_session"] : []), "--features", features.join(",")];
    execute("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", ...args], native);
    return;
  }
  await mkdir(androidHome, { recursive: true });
  if (!existsSync(join(gradle, "settings.gradle"))) {
    execute("cargo", ["tauri", "android", "init", "--ci", "--skip-targets-install"], native);
  }
  const flavor = values.target === "aarch64" ? "arm64" : "x86_64";
  const apk = join(gradle, "app/build/outputs/apk", flavor, "debug", "app-" + flavor + "-debug.apk");
  // Gradle can leave removed ZIP entries as unused space in incrementally rebuilt debug APKs.
  await rm(apk, { force: true });
  const staged = [];
  const features = values.session ? ["p0-session"] : [];
  if (androidProvider) features.push("p0-android-provider-preflight");
  if (androidProviderHosted) features.push("p0-hosted-provider");
  try {
    if (values.session) {
      for (const { source, destination, preflightOnly } of androidFixtureSources) {
        if (preflightOnly && !androidProvider) continue;
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        staged.push(destination);
      }
    }
    execute("cargo", ["tauri", "android", "build", "--ci", "--debug", "--target", values.target,
      ...(features.length ? ["--features", ...features] : []), "--split-per-abi", "--apk", "--config", config], native);
  } finally {
    for (const file of staged) await unlink(file);
  }
  let suffix = values.session ? "-session" : values.origin ? "-development" : "-fixture";
  if (androidProviderPreflight) suffix = "-provider-preflight";
  if (androidProviderHosted) suffix = "-provider-hosted";
  const out = join(run, "klaxon-p0-" + flavor + suffix + ".apk");
  await copyFile(apk, out);
  console.log(out);
}

const lockPath = join(run, "package.lock");
const lock = await open(lockPath, "wx").catch(error => {
  if (error.code === "EEXIST") throw new Error("A native build owns .run/package.lock. See native/README.md for stale lock recovery.");
  throw error;
});
try {
  await lock.writeFile(String(process.pid));
  await build();
} finally {
  await lock.close();
  await unlink(lockPath);
}
