import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../..");

export async function stage(destination) {
  if (typeof destination !== "string" || !isAbsolute(destination)) throw new Error("Use an absolute new staging directory");
  const absolute = resolve(destination);
  const target = join(await realpath(dirname(absolute)), basename(absolute));
  const inside = relative(await realpath(root), target);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) {
    throw new Error("Stage outside the repository");
  }
  await mkdir(target);
  const backend = join(root, "apps", "backend");
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", ".gitignore"]) {
    await cp(join(backend, file), join(target, file), { errorOnExist: true, force: false });
  }
  const convex = join(target, "convex");
  await cp(join(backend, "convex"), convex, {
    recursive: true, filter: path => !/(?:^|[\\/])\./u.test(relative(backend, path)),
  });
  await cp(join(here, "fixture"), convex, { recursive: true, force: false, errorOnExist: true });
  const schemaPath = join(convex, "schema.ts");
  const routesPath = join(convex, "http.ts");
  const dispatchPath = join(convex, "model", "agentHttp.ts");
  const mcpPath = join(convex, "model", "agentMcp.ts");
  const schema = await readFile(schemaPath, "utf8");
  const routes = await readFile(routesPath, "utf8");
  const dispatch = await readFile(dispatchPath, "utf8");
  const mcp = await readFile(mcpPath, "utf8");
  const dispatchStart = "  const grant = mcpGrant ?? await ctx.runMutation(charge, {";
  const dispatchQuery = '  if (endpoint.kind === "query") return ctx.runQuery(makeFunctionReference<"query">(endpoint.handler), args);';
  const openMcp = "    const grant = await ctx.runMutation(open, proof);";
  const beginMcp = "  const oauth = oauthConfig();";
  const filter = "if (!grant.scopes.includes(tool.scope)) continue;";
  if (!schema.includes("export default defineSchema({") || !routes.includes("export default http;") ||
      !routes.includes("oauthMetadataPath, oauthMetadataResponse") ||
      !routes.includes("httpAction(async () => oauthMetadataResponse())") || !dispatch.includes(dispatchStart) ||
      !dispatch.includes(dispatchQuery) ||
      !mcp.includes(openMcp) || !mcp.includes(beginMcp) || !mcp.includes(filter)) {
    throw new Error("Backend schema, HTTP entrypoint, or agent dispatch changed");
  }
  await writeFile(schemaPath, 'import { dotOAuthTables } from "./dotOAuth/tables";\n' +
    schema.replace("export default defineSchema({", "export default defineSchema({\n  ...dotOAuthTables,"));
  await writeFile(routesPath, 'import { dotResourceMetadata, registerDotOAuth } from "./dotOAuth/routes";\n' +
    routes.replace("oauthMetadataPath, oauthMetadataResponse", "oauthMetadataPath")
      .replace("httpAction(async () => oauthMetadataResponse())", "dotResourceMetadata")
      .replace("export default http;", "registerDotOAuth(http);\n\nexport default http;"));
  await writeFile(dispatchPath, 'import { fixtureTaskList, requireFixtureOperation } from "../dotOAuth/operationGate";\n' +
    dispatch.replace(dispatchStart, '  const fixture = requireFixtureOperation(endpoint.name, body, proof, mcpGrant);\n' + dispatchStart)
      .replace(dispatchQuery, '  if (endpoint.kind === "query") {\n' +
        '    const result = await ctx.runQuery(makeFunctionReference<"query">(endpoint.handler), args);\n' +
        '    return endpoint.name === "list_tasks" ? fixtureTaskList(result, fixture.taskId) : result;\n  }'));
  await writeFile(mcpPath, 'import { fixtureTools, requireFixtureSession } from "../dotOAuth/operationGate";\n' +
    'import { setupMcpResponse } from "../dotOAuth/routes";\n' +
    mcp.replace(beginMcp, '  const setup = setupMcpResponse(request);\n  if (setup) return setup;\n' + beginMcp)
      .replace(openMcp, '    requireFixtureSession(proof);\n' + openMcp)
      .replace(filter, "if (!fixtureTools.has(tool.name) || !grant.scopes.includes(tool.scope)) continue;"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error("Usage: node stage.mjs <absolute new staging directory>");
  await stage(process.argv[2]);
}
