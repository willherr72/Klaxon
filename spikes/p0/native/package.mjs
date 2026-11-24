import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  target: { type: "string", default: "windows" },
  origin: { type: "string" },
  session: { type: "boolean" },
} });
if (values.session && (values.origin !== undefined || values.target !== "x86_64")) {
  throw new Error("The packaged session fixture requires offline x86_64");
}
if (!["windows", "x86_64", "aarch64"].includes(values.target)) throw new Error("Choose windows, x86_64 or aarch64");
if (values.origin !== undefined && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/.test(values.origin)) {
  throw new Error("Pass only the HTTPS origin of the selected disposable Convex Development deployment");
}
const native = fileURLToPath(new URL(".", import.meta.url));
const spike = fileURLToPath(new URL("../", import.meta.url));
const run = join(native, ".run");
const androidHome = join(run, "android-user");
const config = join(run, "native-csp.json");
await mkdir(run, { recursive: true });
const env = { ...process.env, ANDROID_USER_HOME: androidHome, P0_PUBLIC_DEV_ORIGIN: values.origin ?? "" };
const execute = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: "inherit" });

async function build() {
  // The public origin drives both the portable client's CSP and the native response header.
  execute(process.execPath, ["build-portable.mjs", "--outdir", "native/.frontend", ...(values.session ? ["--session"] : [])], spike);
  const connections = values.origin ? values.origin + " " + values.origin.replace(/^https:/, "wss:") : "'none'";
  const overlay = JSON.stringify({ app: { withGlobalTauri: !!values.session, security: {
    csp: "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; connect-src " + connections,
  } } });
  await writeFile(config, overlay);
  if (values.target === "windows") {
    env.TAURI_CONFIG = overlay;
    execute("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "custom-protocol"], native);
    return;
  }
  await mkdir(androidHome, { recursive: true });
  const gradle = join(native, "src-tauri/gen/android");
  if (!existsSync(join(gradle, "settings.gradle"))) {
    execute("cargo", ["tauri", "android", "init", "--ci", "--skip-targets-install"], native);
  }
  const flavor = values.target === "aarch64" ? "arm64" : "x86_64";
  const apk = join(gradle, "app/build/outputs/apk", flavor, "debug", "app-" + flavor + "-debug.apk");
  // Gradle can leave removed ZIP entries as unused space in incrementally rebuilt debug APKs.
  await rm(apk, { force: true });
  const staged = [];
  try {
    if (values.session) {
      const src = join(gradle, "app/src/debug/java");
      for (const [source, pkg] of [
        ["packaged-session/SessionPlugin.kt", "dev/klaxon/p0native"],
        ["android-session/src/main/java/dev/klaxon/p0session/FixtureStore.java", "dev/klaxon/p0session"],
      ]) {
        const dir = join(src, pkg);
        await mkdir(dir, { recursive: true });
        const dest = join(dir, basename(source));
        await copyFile(join(native, source), dest, constants.COPYFILE_EXCL);
        staged.push(dest);
      }
    }
    execute("cargo", ["tauri", "android", "build", "--ci", "--debug", "--target", values.target,
      ...(values.session ? ["--features", "p0-session"] : []), "--split-per-abi", "--apk", "--config", config], native);
  } finally {
    for (const file of staged) await unlink(file);
  }
  const suffix = values.session ? "-session" : values.origin ? "-development" : "-fixture";
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
