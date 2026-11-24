import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchOnce } from "./sender.mjs";

// Operator-only entry point for an approved live test. Importing the fixture never sends.
async function main() {
  if (process.argv.length !== 3) throw Error("usage");
  const runDirectory = await realpath(process.argv[2]);
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const fromRepository = relative(repository, runDirectory);
  if (!isAbsolute(fromRepository) && fromRepository !== ".." && !fromRepository.startsWith(".." + sep)) throw Error("private directory required");
  const inputPath = join(runDirectory, "input.json");
  if (!(await lstat(inputPath)).isFile()) throw Error("private input file required");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const { sendNotification, generateRequestDetails } = await import("web-push");
  const report = await dispatchOnce({ runDirectory, input, sendNotification, prepareNotification: generateRequestDetails });
  console.log(JSON.stringify(report, null, 2));
  if (report.targets.some(row => row.transportStatus !== "accepted")) process.exitCode = 1;
}

main().catch(() => {
  console.error("Sender stopped. Check the private run directory, input.json and sender dependencies. Keep any attempted.json and do not retry a claimed run.");
  process.exitCode = 1;
});
