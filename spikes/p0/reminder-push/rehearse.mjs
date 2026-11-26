import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchOnce, mockInput } from "./sender.mjs";

if (process.argv.length !== 2) throw Error("The mock rehearsal takes no arguments");
const runDirectory = await mkdtemp(join(tmpdir(), "klaxon-p0-push-"));
try {
  const result = await dispatchOnce({ runDirectory, input: mockInput(), rehearsal: true,
    sendNotification: async () => ({ statusCode: 201 }) });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(runDirectory, { recursive: true, force: true });
}
