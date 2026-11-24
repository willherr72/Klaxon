import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { compile } from "svelte/compiler";

const { values } = parseArgs({ options: { outdir: { type: "string", default: "dist" }, session: { type: "boolean" } } });
const origin = process.env.P0_PUBLIC_DEV_ORIGIN ?? "";
if (values.session && origin) throw new Error("The packaged session fixture runs offline");
if (origin && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/.test(origin)) {
  throw new Error("P0_PUBLIC_DEV_ORIGIN must be a plain HTTPS Convex deployment origin");
}

const bundle = await build({
  entryPoints: [values.session ? "native/packaged-session/main.js" : "portable/main.js"],
  bundle: true, write: false, minify: true, legalComments: "none",
  conditions: ["browser"],
  define: { P0_PORTABLE_ORIGIN: JSON.stringify(origin) },
  plugins: [{
    name: "svelte",
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
        contents: compile(await readFile(path, "utf8"), { filename: path }).js.code,
      }));
    },
  }],
});

const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script").replace(/\r\n/g, "\n");
const style = (await readFile("portable/style.css", "utf8")).replace(/\r\n/g, "\n");
const hash = text => "'sha256-" + createHash("sha256").update(text).digest("base64") + "'";
const connections = origin ? origin + " " + origin.replace(/^http/, "ws") : "'none'";
const policy = [
  "default-src 'none'", "base-uri 'none'", "form-action 'none'",
  "script-src " + hash(script), "style-src " + hash(style), "connect-src " + connections,
].join("; ");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Klaxon · Device check</title><style>${style}</style></head>
<body><main id="app"></main><script>${script}</script></body></html>`;
await mkdir(values.outdir, { recursive: true });
await writeFile(join(values.outdir, "index.html"), html);
console.log(`Built ${join(values.outdir, "index.html")} (${origin || "local fixture"})`);
