import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stage } from "./stage.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const backend = resolve(here, "../../../apps/backend");
const scratch = await mkdtemp(join(tmpdir(), "klaxon-dot-fixture-"));
const staged = join(scratch, "test");
try {
  await stage(staged);
  await mkdir(join(staged, "test"));
  await copyFile(join(here, "test", "dotOAuth.test.ts"), join(staged, "test", "dotOAuth.test.ts"));
  await symlink(join(backend, "node_modules"), join(staged, "node_modules"), "junction");
  const types = spawnSync(process.execPath, [join(backend, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
    { cwd: staged, stdio: "inherit" });
  if (types.error) throw types.error;
  if (types.status !== 0) throw new Error("Fixture type check failed");
  const result = spawnSync(process.execPath, [join(backend, "node_modules", "vitest", "vitest.mjs"),
    "run", "--environment", "edge-runtime", "test/dotOAuth.test.ts"], { cwd: staged, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
