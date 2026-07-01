import type { CodeCommands, RepoProfile } from "@vibe/shared";
import type { Exec } from "./exec.ts";

/**
 * Deterministic repo intelligence (ported from agentswarm's codeintel): detect
 * how a working directory actually builds and tests itself so no agent ever
 * guesses a command. One batched probe (a single Exec round-trip, not a serial
 * sequence), then pure parsing. None of these functions ever throw — recon
 * failure must degrade a field to null, never fail the session.
 */

const SENTINEL = "@@VIBECODR@@";

/** The raw manifest text reconRepo collected, fed to the pure detectors. */
export interface RepoManifests {
  packageJson?: string;
  pyproject?: string;
  cargo?: string;
  gomod?: string;
  makefile?: string;
  lockfiles: string[];
}

const GREENFIELD_PROFILE: RepoProfile = {
  greenfield: true,
  primaryLanguage: null,
  packageManager: null,
  framework: null,
  commands: {},
  monorepo: { tool: null, packages: [] },
  git: { isRepo: false, branch: null, dirty: false },
  conventions: [],
  manifestFiles: [],
};

/** Dotfiles/boilerplate that don't make a directory "non-empty" for recon. */
const TRIVIAL = new Set(["readme.md", "readme", "license", "license.md", ".gitignore", ".git", ".ds_store"]);

/** Is this directory effectively empty (greenfield) — only dotfiles/README/LICENSE? */
export function looksGreenfield(entries: string[]): boolean {
  return entries.every((e) => e.startsWith(".") || TRIVIAL.has(e.toLowerCase()));
}

/**
 * One batched probe of the working directory. Returns a RepoProfile; any probe
 * failure degrades its field rather than throwing.
 */
export async function reconRepo(exec: Exec, workdir: string, signal?: AbortSignal): Promise<RepoProfile> {
  const sec = (name: string) => `printf '%s\\n' "${SENTINEL}${name}"`;
  const probe = [
    sec("LS"), "ls -A 2>/dev/null",
    sec("GITREPO"), "git rev-parse --is-inside-work-tree 2>/dev/null",
    sec("GITBRANCH"), "git rev-parse --abbrev-ref HEAD 2>/dev/null",
    sec("GITDIRTY"), "git status --porcelain 2>/dev/null | head -5",
    sec("PKG"), "cat package.json 2>/dev/null",
    sec("PYPROJECT"), "cat pyproject.toml 2>/dev/null",
    sec("CARGO"), "cat Cargo.toml 2>/dev/null",
    sec("GOMOD"), "cat go.mod 2>/dev/null",
    sec("MAKEFILE"), "head -80 Makefile 2>/dev/null",
    sec("LOCK"), "ls package-lock.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb 2>/dev/null",
    sec("END"),
  ].join(" ; ");

  let out = "";
  try {
    const r = await exec(probe, { cwd: workdir, timeoutSec: 30, ...(signal ? { signal } : {}) });
    out = r.out ?? "";
  } catch {
    // Recon failed, but the dir isn't necessarily empty — don't claim greenfield.
    return { ...GREENFIELD_PROFILE, greenfield: false };
  }

  const sections = splitSections(out);
  const entries = lines(sections.LS);
  if (looksGreenfield(entries)) return { ...GREENFIELD_PROFILE };

  const manifests: RepoManifests = {
    ...(sections.PKG?.trim() ? { packageJson: sections.PKG.trim() } : {}),
    ...(sections.PYPROJECT?.trim() ? { pyproject: sections.PYPROJECT.trim() } : {}),
    ...(sections.CARGO?.trim() ? { cargo: sections.CARGO.trim() } : {}),
    ...(sections.GOMOD?.trim() ? { gomod: sections.GOMOD.trim() } : {}),
    ...(sections.MAKEFILE?.trim() ? { makefile: sections.MAKEFILE.trim() } : {}),
    lockfiles: lines(sections.LOCK),
  };

  const isRepo = /true/.test(sections.GITREPO ?? "");
  const branch = isRepo ? (lines(sections.GITBRANCH)[0] || null) : null;
  const dirty = isRepo && Boolean((sections.GITDIRTY ?? "").trim());

  const manifestFiles = [
    manifests.packageJson && "package.json",
    manifests.pyproject && "pyproject.toml",
    manifests.cargo && "Cargo.toml",
    manifests.gomod && "go.mod",
    manifests.makefile && "Makefile",
  ].filter(Boolean) as string[];

  return {
    greenfield: false,
    primaryLanguage: detectLanguage(manifests),
    packageManager: detectPackageManager(manifests),
    framework: detectFramework(manifests),
    commands: detectCommands(manifests),
    monorepo: detectMonorepo(manifests),
    git: { isRepo, branch, dirty },
    conventions: detectConventions(manifests),
    manifestFiles,
  };
}

function splitSections(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of out.split(SENTINEL)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const name = part.slice(0, nl).trim();
    if (name) map[name] = part.slice(nl + 1);
  }
  return map;
}

function lines(s: string | undefined): string[] {
  return (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Watch/dev-server scripts never terminate — they can't be a build/test gate.
 * dev/serve/start only match as an actual command (line start or after &&/;/|),
 * so a build like "vite build" or a path like "serve-dist" is NOT falsely rejected.
 */
const NON_TERMINATING =
  /--watch\b|\bnodemon\b|\bwebpack-dev-server\b|(?:^|&&|;|\|)\s*(?:next\s+dev|serve|http-server|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve))(?:\s|$)/i;

function parsePackageJson(raw: string | undefined): { scripts: Record<string, string>; deps: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: object;
      devDependencies?: object;
    };
    return {
      scripts: obj.scripts && typeof obj.scripts === "object" ? obj.scripts : {},
      deps: JSON.stringify(obj.dependencies ?? {}) + JSON.stringify(obj.devDependencies ?? {}),
    };
  } catch {
    return null;
  }
}

function detectPackageManager(m: RepoManifests): string | null {
  if (!m.packageJson) return null;
  const lf = m.lockfiles.join(" ");
  if (/pnpm-lock\.yaml/.test(lf)) return "pnpm";
  if (/yarn\.lock/.test(lf)) return "yarn";
  if (/bun\.lockb?\b/.test(lf)) return "bun";
  return "npm";
}

/**
 * Pure: the repo's real build/test/typecheck/lint/install commands. JS reads
 * package.json scripts (skipping non-terminating ones); otherwise language
 * heuristics. A field is omitted when nothing trustworthy is detected.
 */
export function detectCommands(m: RepoManifests): CodeCommands {
  const cmds: CodeCommands = {};
  const pkg = parsePackageJson(m.packageJson);
  if (pkg) {
    const pm = detectPackageManager(m) ?? "npm";
    const runnable = (name: string): string | undefined => {
      const v = pkg.scripts[name];
      if (!v || NON_TERMINATING.test(v)) return undefined;
      return `${pm} run ${name}`;
    };
    cmds.install =
      m.lockfiles.some((l) => /package-lock\.json/.test(l)) && pm === "npm" ? "npm ci" : `${pm} install`;
    const build = runnable("build");
    if (build) cmds.build = build;
    const test =
      runnable("test") ??
      (pkg.scripts.test && !NON_TERMINATING.test(pkg.scripts.test) ? `${pm} test` : undefined);
    if (test) cmds.test = test;
    const typecheck =
      runnable("typecheck") ??
      runnable("tsc") ??
      (/"typescript"/.test(m.packageJson ?? "") || /typescript/.test(pkg.deps) ? "npx tsc --noEmit" : undefined);
    if (typecheck) cmds.typecheck = typecheck;
    const lint = runnable("lint");
    if (lint) cmds.lint = lint;
    return cmds;
  }
  if (m.cargo) {
    return { build: "cargo build", test: "cargo test", typecheck: "cargo check", lint: "cargo clippy -- -D warnings" };
  }
  if (m.gomod) {
    return { build: "go build ./...", test: "go test ./...", typecheck: "go vet ./..." };
  }
  if (m.pyproject) {
    const p = m.pyproject;
    cmds.install = "pip install -e .";
    cmds.test = "python -m pytest -q";
    if (/mypy/.test(p)) cmds.typecheck = "mypy .";
    if (/\bruff\b/.test(p)) cmds.lint = "ruff check .";
    else if (/flake8/.test(p)) cmds.lint = "flake8";
    return cmds;
  }
  if (m.makefile) {
    const mk = m.makefile;
    if (/^build\s*:/m.test(mk)) cmds.build = "make build";
    if (/^test\s*:/m.test(mk)) cmds.test = "make test";
    if (/^lint\s*:/m.test(mk)) cmds.lint = "make lint";
    if (/^(typecheck|check)\s*:/m.test(mk)) cmds.typecheck = "make check";
    return cmds;
  }
  return cmds;
}

/** Scripts that start a long-running web/dev server (the inverse of
 * NON_TERMINATING — here we WANT the server, for browser verification). */
const SERVER_SCRIPT =
  /\b(next\s+(?:dev|start)|vite(?:\s+preview)?|react-scripts\s+start|serve\b|http-server|nuxt\s+dev|astro\s+dev|remix\s+(?:vite:)?dev|ng\s+serve|webpack(?:\s+serve|-dev-server)|gatsby\s+develop)\b/i;

/**
 * Recover the dev/serve command (the one detectCommands deliberately DROPS as
 * non-terminating) so a visual-verification pass can render the built app, with
 * a deterministic port injected per framework. `needsBuild` marks scripts that
 * serve a PRODUCTION build (vite preview, next start, static serve). Null when
 * the repo has no recognizable web server. Pure.
 */
export function detectServeCommand(
  m: RepoManifests,
  port: number,
): { cmd: string; port: number; needsBuild: boolean } | null {
  const pkg = parsePackageJson(m.packageJson);
  if (!pkg) return null;
  const pm = detectPackageManager(m) ?? "npm";
  let script: string | undefined;
  let val = "";
  for (const name of ["dev", "start", "serve", "preview"]) {
    const v = pkg.scripts[name];
    if (v && SERVER_SCRIPT.test(v)) {
      script = name;
      val = v;
      break;
    }
  }
  if (!script) return null;
  const fw = detectFramework(m);
  const run = `${pm} run ${script}`;
  const needsBuild = script === "preview" || /vite\s+preview|next\s+start|\bserve\b|http-server/.test(val);
  if (/vite/.test(val) || fw === "Vue" || fw === "Svelte")
    return { cmd: `${run} -- --port ${port} --strictPort --host 127.0.0.1`, port, needsBuild };
  if (fw === "Next.js" || /next\s+(?:dev|start)/.test(val))
    return { cmd: `PORT=${port} ${run} -- -p ${port}`, port, needsBuild };
  if (/react-scripts/.test(val)) return { cmd: `PORT=${port} BROWSER=none ${run}`, port, needsBuild };
  if (/\bserve\b/.test(val)) return { cmd: `${run} -- -l ${port}`, port, needsBuild };
  if (/http-server/.test(val)) return { cmd: `${run} -- -p ${port} -a 127.0.0.1`, port, needsBuild };
  return { cmd: `PORT=${port} ${run} -- --port ${port}`, port, needsBuild };
}

/** True when this repo is a renderable web/UI app. */
export function isWebApp(profile: RepoProfile): boolean {
  return ["Next.js", "React", "Vue", "Svelte"].includes(profile.framework ?? "");
}

/**
 * Detached-launch shell command for a serve command. The serve command runs
 * through `sh -c` so a `PORT=<p> …` env prefix is parsed as an environment
 * ASSIGNMENT (a naive `nohup PORT=<p> npm …` treats it as nohup's program
 * operand and never binds). nohup + `</dev/null` daemonizes it past the call.
 */
export function serveDaemonCommand(serveCmd: string, logFile: string, pidFile: string): string {
  return `nohup sh -c ${JSON.stringify(serveCmd)} > ${JSON.stringify(logFile)} 2>&1 < /dev/null & echo $! > ${JSON.stringify(pidFile)}`;
}

function detectLanguage(m: RepoManifests): string | null {
  if (m.packageJson) return /"typescript"/.test(m.packageJson) ? "TypeScript" : "JavaScript";
  if (m.cargo) return "Rust";
  if (m.gomod) return "Go";
  if (m.pyproject) return "Python";
  return null;
}

function detectFramework(m: RepoManifests): string | null {
  const p = m.packageJson ?? "";
  if (/"next"/.test(p)) return "Next.js";
  if (/"react"/.test(p)) return "React";
  if (/"vue"/.test(p)) return "Vue";
  if (/"svelte"/.test(p)) return "Svelte";
  if (/"express"/.test(p)) return "Express";
  if (/"@nestjs\/core"/.test(p)) return "NestJS";
  if (/"fastify"/.test(p)) return "Fastify";
  if (m.pyproject && /django/i.test(m.pyproject)) return "Django";
  if (m.pyproject && /fastapi/i.test(m.pyproject)) return "FastAPI";
  return null;
}

function detectMonorepo(m: RepoManifests): { tool: string | null; packages: string[] } {
  const p = m.packageJson ?? "";
  if (/"turbo"/.test(p)) return { tool: "turborepo", packages: [] };
  if (/"nx"/.test(p)) return { tool: "nx", packages: [] };
  if (/"workspaces"/.test(p)) return { tool: "npm-workspaces", packages: [] };
  if (m.lockfiles.some((l) => /pnpm-lock/.test(l)) && /"workspaces"|packages:/.test(p))
    return { tool: "pnpm", packages: [] };
  return { tool: null, packages: [] };
}

function detectConventions(m: RepoManifests): string[] {
  const out: string[] = [];
  const p = m.packageJson ?? "";
  if (/"prettier"/.test(p)) out.push("formatted with prettier");
  if (/"biome(js)?"|"@biomejs\/biome"/.test(p)) out.push("formatted/linted with biome");
  if (/"eslint"/.test(p)) out.push("linted with eslint");
  if (/"typescript"/.test(p)) out.push("TypeScript — keep the tree type-clean (tsc --noEmit)");
  if (/"jest"/.test(p)) out.push("tests in jest");
  else if (/"vitest"/.test(p)) out.push("tests in vitest");
  else if (/"bun"/.test(p) && /"test"/.test(p)) out.push("tests via bun test");
  if (m.cargo && /clippy/.test(m.cargo)) out.push("clippy-clean");
  return out;
}
