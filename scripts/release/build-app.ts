/**
 * Build the OpenTUI Solid JSX app (`app.tsx`) as a pre-compiled bundle so it
 * can be dynamic-imported at runtime by the CLI — the non-literal specifier in
 * `tui.ts` keeps it out of the main `vibecodr.js` / compiled binary bundle.
 *
 * Imports `@opentui/solid`'s Solid transform plugin factory directly from the
 * package's `scripts/solid-plugin.js` (not exported in `exports`, so resolved
 * via `Bun.resolveSync` + path join) and passes it to `Bun.build()` so the
 * JSX is transpiled with the Solid runtime, not Bun's default React runtime.
 *
 * Without this, the npm package and compiled binary both fall back to the
 * basic REPL because `app.tsx` isn't on disk at runtime.
 *
 *   bun scripts/release/build-app.ts <outfile>
 */
import { join, dirname, dirname as pathDirname } from "node:path";

// Resolve the @opentui/solid package directory, then import the plugin factory
// from its scripts/ subdirectory (not in exports — must use a file path).
const solidPkgDir = pathDirname(Bun.resolveSync("@opentui/solid", process.cwd()));
const pluginPath = join(solidPkgDir, "scripts", "solid-plugin.js");
const { createSolidTransformPlugin } = await import(pluginPath);

const outfile = process.argv[2] ?? "dist/vibecodr-app.js";
const outdir = dirname(outfile);
const outName = outfile.split("/").pop()!;

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "..", "packages", "tui", "src", "app.tsx")],
  target: "bun",
  outdir,
  naming: outName,
  plugins: [createSolidTransformPlugin()],
  // The optional peer deps are installed alongside (npm) or bundled in the
  // binary's runtime — don't inline them here.
  external: ["@opentui/core", "@opentui/solid", "solid-js", "web-tree-sitter"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}
const size = (Bun.file(outfile).size / 1024).toFixed(0);
console.log(`Built ${outfile} (${size} KB)`);
