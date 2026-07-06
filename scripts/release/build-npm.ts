#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the npm/bun distribution into `dist/npm/`:
 *  1. `bun build … --target=bun` bundles the CLI + all `@vibe/*` workspace source
 *     into a single `vibecodr.js` (with a `#!/usr/bin/env bun` shebang).
 *  2. generate `dist/npm/package.json` (name `vibe-codr`, bins, engines,
 *     optionalDependencies for the optional peer deps we load lazily).
 *  3. copy README / CHANGELOG / LICENSE.
 *  4. sanity-check that the provider SDKs are still INLINED (self-contained).
 *
 * CRITICAL: no `--external` for the provider SDKs — the `PROVIDER_MODULES`
 * literal-import map in @vibe/providers must be inlined so the bundle is
 * self-contained (mirrors the standalone binary). The optional peers we load via
 * *variable* specifiers (OpenTUI, MCP SDK, transformers) can't be bundled, so
 * they're declared as optionalDependencies for the install to resolve at runtime.
 *
 * The version comes from `packages/cli/src/version.ts` (stamped by set-version).
 * Pure generators are exported for tests; `main()` does the IO.
 */

const REPO_SLUG = "robzilla1738/vibe-codr";

/** The optional peer deps to advertise as optionalDependencies, and how they're
 * loaded. Provider SDKs are ALSO bundled (belt-and-suspenders); OpenTUI/MCP/
 * transformers are the ones that actually must resolve from node_modules. */
export const OPTIONAL_DEP_NAMES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/deepseek",
  "@ai-sdk/openai-compatible",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "web-tree-sitter",
  "@modelcontextprotocol/sdk",
  "@huggingface/transformers",
] as const;

/** The repo doesn't pin these two (loaded via variable specifier + graceful
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

/** The generated dist/npm/package.json (pure). */
export function generateNpmPackageJson(opts: {
  version: string;
  rootPkg: Pkg;
  optionalDependencies: Record<string, string>;
}): Record<string, unknown> {
  const { version, rootPkg } = opts;
  const patchedDependencies = rootPkg.patchedDependencies;
  const hasPatches = patchedDependencies && Object.keys(patchedDependencies).length > 0;
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
    files: ["vibecodr.js", "README.md", "CHANGELOG.md", "LICENSE", ...(hasPatches ? ["patches"] : [])],
    optionalDependencies: opts.optionalDependencies,
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
  "AnthropicMessagesLanguageModel",
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

  // 2. shebang + executable bit.
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
