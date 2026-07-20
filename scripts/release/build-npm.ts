#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the npm/bun distribution into `dist/npm/`:
 *  1. `bun build … --target=bun` bundles the CLI + all `@vibe/*` workspace source
 *     into a single `vibecodr.js` (with a `#!/usr/bin/env bun` shebang).
 *  2. generate `dist/npm/package.json` (name `vibe-codr`, bins, engines,
 *     optionalDependencies for lazily-loaded deps that should work out of the
 *     box, plus optional peer metadata for opt-in heavy extras).
 *  3. copy README / CHANGELOG / LICENSE.
 *  4. sanity-check that the provider SDKs are still INLINED (self-contained).
 *
 * CRITICAL: no `--external` for the provider SDKs — the `PROVIDER_MODULES`
 * literal-import map in @vibe/providers must be inlined so the bundle is
 * self-contained (mirrors the standalone binary). The optional peers we load via
 * *variable* specifiers (OpenTUI, MCP SDK, transformers) can't be bundled.
 * OpenTUI/MCP are installed for out-of-the-box TUI/MCP support. Provider SDKs
 * are bundled into vibecodr.js and are NOT installed separately. The semantic
 * memory transformer stack stays a true optional peer because the app degrades
 * to BM25 recall when it is absent, and installing it by default pulls a large
 * native inference stack into every CLI install.
 *
 * The version comes from `packages/cli/src/version.ts` (stamped by set-version).
 * Pure generators are exported for tests; `main()` does the IO.
 */

const REPO_SLUG = "robzilla1738/vibe-codr";

/** Lazily-loaded deps to advertise as optionalDependencies. Provider SDKs are
 * deliberately absent here: the npm bundle inlines them and `missingInlinedSymbols`
 * guards that invariant, so installing a second copy only bloats fresh installs
 * and exposes avoidable transitive advisories. */
export const OPTIONAL_DEP_NAMES = [
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "web-tree-sitter",
  "@modelcontextprotocol/sdk",
] as const;

/** Heavy opt-in extras: the app has a graceful fallback when absent, so these
 * should NOT be installed by default by npm's optionalDependencies behavior. */
export const OPTIONAL_PEER_DEP_NAMES = ["@huggingface/transformers"] as const;

/** The repo doesn't pin these (loaded via variable specifier + graceful
 * degradation), so fall back to `*` — matching the repo's own optional-peer
 * convention in packages/tui's peerDependencies. */
const FALLBACK_VERSIONS: Record<string, string> = {
  "@modelcontextprotocol/sdk": "*",
  "@huggingface/transformers": "*",
};

type Pkg = {
  version?: string;
  license?: string;
  description?: string;
  keywords?: string[];
  repository?: unknown;
  funding?: unknown;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};

/** Merge every dep declaration across the workspace into a name→range map.
 * Root deps/devDeps win over per-package deps/peers (first-writer-wins in this
 * order), so the concrete root range (e.g. `^2.0.83`) beats a loose peer `^2`. */
export function collectWorkspaceVersions(pkgs: Pkg[]): Record<string, string> {
  const out: Record<string, string> = {};
  const absorb = (deps?: Record<string, string>) => {
    if (!deps) return;
    for (const [name, range] of Object.entries(deps)) {
      if (!(name in out)) out[name] = range;
    }
  };
  for (const p of pkgs) {
    absorb(p.dependencies);
    absorb(p.devDependencies);
  }
  for (const p of pkgs) absorb(p.peerDependencies);
  return out;
}

/** Build the optionalDependencies map from the resolved workspace versions,
 * falling back for the deps the repo doesn't pin. Sorted for a stable diff. */
function patchedExactVersion(
  name: string,
  patchedDependencies: Record<string, string>,
): string | undefined {
  for (const key of Object.keys(patchedDependencies)) {
    if (key.startsWith(`${name}@`)) return key.slice(name.length + 1);
  }
}

export function resolveOptionalDeps(
  versions: Record<string, string>,
  patchedDependencies: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...OPTIONAL_DEP_NAMES].sort()) {
    out[name] = patchedExactVersion(name, patchedDependencies) ?? versions[name] ?? FALLBACK_VERSIONS[name] ?? "*";
  }
  return out;
}

export function resolveOptionalPeerDeps(versions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...OPTIONAL_PEER_DEP_NAMES].sort()) {
    out[name] = versions[name] ?? FALLBACK_VERSIONS[name] ?? "*";
  }
  return out;
}

/** The generated dist/npm/package.json (pure). */
export function generateNpmPackageJson(opts: {
  version: string;
  rootPkg: Pkg;
  optionalDependencies: Record<string, string>;
  optionalPeerDependencies?: Record<string, string>;
}): Record<string, unknown> {
  const { version, rootPkg } = opts;
  const patchedDependencies = rootPkg.patchedDependencies;
  const hasPatches = patchedDependencies && Object.keys(patchedDependencies).length > 0;
  const optionalPeerDependencies = opts.optionalPeerDependencies ?? {};
  const hasOptionalPeers = Object.keys(optionalPeerDependencies).length > 0;
  return {
    name: "vibe-codr",
    version,
    description: rootPkg.description ?? "A model-agnostic CLI coding agent for the terminal.",
    license: rootPkg.license ?? "MIT",
    ...(rootPkg.keywords ? { keywords: rootPkg.keywords } : {}),
    repository: rootPkg.repository ?? { type: "git", url: `git+https://github.com/${REPO_SLUG}.git` },
    homepage: `https://github.com/${REPO_SLUG}`,
    ...(rootPkg.funding ? { funding: rootPkg.funding } : {}),
    type: "module",
    bin: { vibecodr: "vibecodr.js", vibe: "vibecodr.js" },
    engines: rootPkg.engines ?? { bun: ">=1.2.0" },
    files: ["vibecodr.js", "vibecodr-engine-worker.js", "app.js", "README.md", "CHANGELOG.md", "LICENSE", ...(hasPatches ? ["patches"] : [])],
    optionalDependencies: opts.optionalDependencies,
    ...(rootPkg.overrides ? { overrides: rootPkg.overrides } : {}),
    ...(hasOptionalPeers
      ? {
          peerDependencies: optionalPeerDependencies,
          peerDependenciesMeta: Object.fromEntries(
            Object.keys(optionalPeerDependencies).map((name) => [name, { optional: true }]),
          ),
        }
      : {}),
    ...(hasPatches ? { patchedDependencies } : {}),
  };
}

const SHEBANG = "#!/usr/bin/env bun";

/** Ensure the bundle starts with the bun shebang (bun build may drop it). */
export function ensureShebang(bundle: string): string {
  return bundle.startsWith("#!") ? bundle : `${SHEBANG}\n${bundle}`;
}

/**
 * SDK export SYMBOLS present ONLY when the provider SDKs are actually inlined.
 * The module SPECIFIER strings (`@ai-sdk/anthropic`) AND the factory names
 * (`createAnthropic`, `createOpenAICompatible`) both appear as literals in
 * `@vibe/providers/defs.ts` whether or not the SDK was bundled — so grepping for
 * either survives a `--external` and can't catch the externalization regression
 * this guard exists to stop. These SDK-internal class exports only exist in the
 * bundle when the SDK source is inlined; externalizing the SDK drops them.
 */
export const REQUIRED_INLINED_SYMBOLS = [
  "AnthropicLanguageModel",
  "OpenAICompatibleChatLanguageModel",
] as const;

/** The inlined-only SDK symbols absent from `bundle` — empty when self-contained. */
export function missingInlinedSymbols(bundle: string): string[] {
  return REQUIRED_INLINED_SYMBOLS.filter((sym) => !bundle.includes(sym));
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, "..", "..");
  const outDir = join(root, "dist", "npm");
  const outFile = join(outDir, "vibecodr.js");
  mkdirSync(outDir, { recursive: true });

  const { VERSION } = (await import(join(root, "packages", "cli", "src", "version.ts"))) as {
    VERSION: string;
  };

  // 1. bundle (no --external on provider SDKs — they must inline).
  const build = Bun.spawnSync([
    "bun",
    "build",
    join(root, "packages", "cli", "bin", "vibecodr.ts"),
    "--target=bun",
    "--outfile",
    outFile,
  ]);
  if (build.exitCode !== 0) {
    process.stderr.write(build.stderr.toString());
    throw new Error("bun build failed");
  }

  // 1b. bundle the engine worker entry as a SIBLING file so the TUI's
  // `WorkerEngineClient` can spawn it via `new Worker(path)` for thread
  // isolation (the freeze fix — see packages/cli/src/engine-worker-client.ts).
  // Same `--target=bun` + no `--external` so the worker runs self-contained
  // with provider SDKs inlined. If this fails, the runtime host falls back
  // to in-process `Engine` (Option B's yield gate alone bounds the freeze),
  // but a missing worker sibling silently halves the fix for npm users.
  const workerFile = join(outDir, "vibecodr-engine-worker.js");
  const buildWorker = Bun.spawnSync([
    "bun",
    "build",
    join(root, "packages", "cli", "src", "engine-worker-entry.ts"),
    "--target=bun",
    "--outfile",
    workerFile,
  ]);
  if (buildWorker.exitCode !== 0) {
    process.stderr.write(buildWorker.stderr.toString());
    throw new Error("bun build (engine worker) failed");
  }

  // 1c. build the OpenTUI Solid JSX app (app.tsx) as a separate bundle
  // (`app.js`) so the npm package ships a pre-compiled TUI the runtime can
  // dynamic-import. `app.tsx` uses a non-literal specifier in `tui.ts` (to
  // keep the optional peer deps out of the main bundle), so `bun build` on
  // the CLI entry can't resolve it. We build it here with the Solid transform
  // plugin passed directly to Bun.build() — `@opentui/solid/preload`'s
  // `Bun.plugin()` registration doesn't propagate to `Bun.build()`.
  // Without this, npm users get the basic REPL instead of the rich TUI.
  const solidPkgDir = join(outDir, "..", "..", "node_modules", "@opentui", "solid");
  const solidResolved = Bun.resolveSync("@opentui/solid", root);
  const solidDir = solidResolved.replace(/\/[^\/]+$/, "");
  const solidPluginPath = join(solidDir, "scripts", "solid-plugin.js");
  const { createSolidTransformPlugin: createSolidPlugin } = await import(solidPluginPath);
  const appFile = join(outDir, "app.js");
  const appBuild = await Bun.build({
    entrypoints: [join(root, "packages", "tui", "src", "app.tsx")],
    target: "bun",
    outdir: outDir,
    naming: "app.js",
    plugins: [createSolidPlugin()],
    // External: the optional peer deps are installed by the package's
    // optionalDependencies and resolved at runtime — don't inline them.
    external: ["@opentui/core", "@opentui/solid", "solid-js", "web-tree-sitter"],
  });
  if (!appBuild.success) {
    const logs = appBuild.logs.map((l) => l.message).join("\n");
    throw new Error(`bun build (app.tsx) failed: ${logs}`);
  }

  // 2. shebang + executable bit on the main bundle.
  writeFileSync(outFile, ensureShebang(readFileSync(outFile, "utf8")));
  chmodSync(outFile, 0o755);

  // 3. generated package.json.
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
  const pkgPaths = [
    join(root, "package.json"),
    ...[...new Bun.Glob("packages/*/package.json").scanSync({ cwd: root })].map((r) => join(root, r)),
  ];
  const versions = collectWorkspaceVersions(
    pkgPaths.map((p) => JSON.parse(readFileSync(p, "utf8")) as Pkg),
  );
  const npmPkg = generateNpmPackageJson({
    version: VERSION,
    rootPkg,
    optionalDependencies: resolveOptionalDeps(versions, rootPkg.patchedDependencies),
    optionalPeerDependencies: resolveOptionalPeerDeps(versions),
  });
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(npmPkg, null, 2)}\n`);

  // 4. copy docs/license and any dependency patches needed by the runtime package.
  for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) {
    try {
      copyFileSync(join(root, f), join(outDir, f));
    } catch {
      process.stderr.write(`warning: could not copy ${f}\n`);
    }
  }
  if (rootPkg.patchedDependencies && existsSync(join(root, "patches"))) {
    cpSync(join(root, "patches"), join(outDir, "patches"), { recursive: true });
  }

  // 5. verify the provider SDKs stayed INLINED (self-contained bundle). Assert
  // on SDK-internal symbols that only survive when the SDK source is bundled in —
  // the module ids + factory names are literals in defs.ts either way.
  const bundle = readFileSync(outFile, "utf8");
  const missing = missingInlinedSymbols(bundle);
  if (missing.length) {
    throw new Error(
      `bundle is missing inlined provider SDK symbol(s): ${missing.join(", ")} — a stray --external?`,
    );
  }

  process.stdout.write(
    `Built dist/npm/vibecodr.js (${(bundle.length / 1024).toFixed(0)} KB) + package.json for vibe-codr@${VERSION}.\n`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`build-npm: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
