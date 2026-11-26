import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = "klaxon-p3-dot-";
const marker = "dot-operator-stage-v1";
export const backend = fileURLToPath(new URL("../../../apps/backend/", import.meta.url));

export function designatedTarget(environment) {
  const name = environment.KLAXON_DOT_DEV_NAME;
  const key = environment.KLAXON_DOT_DEV_KEY;
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name) || name.length > 63 ||
      environment.KLAXON_DOT_CONFIRM_FRESH !== name ||
      typeof key !== "string" || !key.startsWith(`dev:${name}|`) ||
      !/^[A-Za-z0-9_+/-]+={0,2}$/.test(key.slice(name.length + 5))) {
    throw new Error("An explicitly designated fresh Development deployment and matching scoped key are required");
  }
  return { url: `https://${name}.convex.cloud`, site: `https://${name}.convex.site`, key };
}

export async function stage({ recovery = false, stageFixture = async project => {
  const fixture = fileURLToPath(new URL("../dot-oauth/stage.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [fixture, project], { env: stageEnvironment(), stdio: "ignore", windowsHide: true });
  if (result.status !== 0) throw new Error("The offline OAuth fixture stage failed");
  await symlink(join(backend, "node_modules"), join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
} } = {}) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, prefix));
  try {
    await writeFile(join(directory, marker), marker, { flag: "wx" });
    const project = join(directory, "project");
    if (recovery) {
      await mkdir(project);
      await cp(join(backend, "package.json"), join(project, "package.json"));
      return { directory, project };
    }
    await stageFixture(project);
    await writeFile(join(project, "convex", "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.json", include: ["**/*.ts"] }, null, 2) + "\n",
      { flag: "wx" });
    await cp(new URL("./convex-operator.ts", import.meta.url), join(project, "convex", "dotOperator.ts"));
    const schemaPath = join(project, "convex", "schema.ts");
    const schema = await readFile(schemaPath, "utf8");
    const markerDefinition = 'dotOperatorState: defineTable({ userId: v.id("users") }),';
    if (!schema.includes("export default defineSchema({")) throw new Error("Staged schema entrypoint changed");
    await writeFile(schemaPath, 'import { defineTable } from "convex/server";\nimport { v } from "convex/values";\n' +
      schema.replace("export default defineSchema({", `export default defineSchema({\n  ${markerDefinition}`));
    if (await lstat(join(project, "convex", "crons.ts")).catch(() => undefined)) {
      throw new Error("Staged project must omit all scheduled cron jobs");
    }
    return { directory, project };
  } catch (error) {
    await cleanup(directory);
    throw error;
  }
}

export function stageEnvironment() {
  const keys = ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH", "PATHEXT", "COMSPEC"];
  return Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export async function cleanup(directory) {
  const root = await realpath(tmpdir());
  if (!isAbsolute(directory) || dirname(directory) !== root || !basename(directory).startsWith(prefix) ||
      await realpath(directory) !== directory || !(await lstat(join(directory, marker))).isFile() ||
      await readFile(join(directory, marker), "utf8") !== marker) {
    throw new Error("Refusing to remove an unverified staging directory");
  }
  await rm(directory, { recursive: true, maxRetries: 6, retryDelay: 100 });
}
