import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "windows" && target !== "android") {
  throw new Error("Choose windows or android.");
}

const native = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runNode(["apps/native/asset-manifest.mjs", "verify"], { cwd: root });

// Tauri generates a Gradle task that calls this npm script to compile the Android library.
function runTauri(args, env = process.env) {
  runNode([process.env.npm_execpath, "run", "tauri", "--", ...args], { cwd: native, env });
}

if (target === "windows") {
  runTauri(["build", "--ci", "--debug", "--no-bundle", "--", "--locked"]);
} else {
  const androidProject = new URL("./src-tauri/gen/android/settings.gradle", import.meta.url);
  const env = {
    ...process.env,
    ANDROID_USER_HOME: fileURLToPath(new URL("./.android", import.meta.url)),
  };
  if (!existsSync(androidProject)) {
    runTauri(["android", "init", "--ci", "--skip-targets-install"], env);
  }
  runTauri([
    "android", "build", "--ci", "--debug", "--target", "x86_64", "--split-per-abi", "--apk",
    "--", "--locked",
  ], env);
}
