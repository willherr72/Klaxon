import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const javaHome = process.env.JAVA_HOME;
const packagePath = "dev/klaxon/p0alarmvisible";
const source = fileURLToPath(new URL(`./src/main/java/${packagePath}/AlarmRun.java`, import.meta.url));
const test = fileURLToPath(new URL(`./src/test/java/${packagePath}/AlarmRunTest.java`, import.meta.url));

function runJavaTool(name, args) {
  const binary = process.platform === "win32" ? `${name}.exe` : name;
  const executable = javaHome ? resolve(javaHome, "bin", binary) : binary;
  const { error, signal, status } = spawnSync(executable, args, { cwd: classes, stdio: "inherit" });
  if (error) {
    console.error(`Could not run ${executable}. Set JAVA_HOME or PATH to a JDK 17 or newer.`, error.message);
  } else if (signal) {
    console.error(`${executable} terminated by ${signal}.`);
  }
  return status ?? 1;
}

const temp = realpathSync(tmpdir());
const classes = realpathSync(mkdtempSync(join(temp, "klaxon-alarm-host-")));
if (dirname(classes) !== temp) throw new Error("Expected temporary classes beneath the host temp directory.");
try {
  process.exitCode = runJavaTool("javac", ["--release", "17", "-classpath", ".", "-d", ".", source, test]);
  if (process.exitCode === 0) {
    process.exitCode = runJavaTool("java", ["-classpath", ".", "dev.klaxon.p0alarmvisible.AlarmRunTest"]);
  }
} finally {
  rmSync(classes, { recursive: true, force: true });
}
