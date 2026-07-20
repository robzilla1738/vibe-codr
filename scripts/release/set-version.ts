#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stamp a release version across the repo. Run by the release workflow from the
 * pushed tag (or a local dry-run). All rewrites are PURE functions over file
 * text (exported for tests); `main()` reads argv/env, discovers the files, and
 * writes them.
 *
 *   bun scripts/release/set-version.ts 0.3.0
 *   bun scripts/release/set-version.ts        # uses $GITHUB_REF_NAME
 */

/** Strip a leading `v` and validate a semver-ish version, else throw. */
export function parseVersion(input: string): string {
  const v = input.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new Error(`not a valid semver version: "${input}"`);
  }
  return v;
}

/** Rewrite the `export const VERSION = "…"` literal in version.ts. */
export function rewriteVersionFile(content: string, version: string): string {
  if (!/export const VERSION = "[^"]*"/.test(content)) {
    throw new Error("version.ts has no `export const VERSION = \"…\"` to rewrite");
  }
  return content.replace(/(export const VERSION = )"[^"]*"/, `$1"${version}"`);
}

/** Rewrite the top-level `"version"` field of a package.json (preserves other
 * formatting by editing just that one line). */
export function rewritePackageJsonVersion(content: string, version: string): string {
  if (!/"version"\s*:\s*"[^"]*"/.test(content)) {
    throw new Error('package.json has no "version" field to rewrite');
  }
  return content.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
}

/** Update npm's root package metadata without touching dependency versions. */
export function rewritePackageLockVersion(content: string, version: string): string {
  const lock = JSON.parse(content) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  if (typeof lock.version !== "string" || typeof lock.packages?.[""]?.version !== "string") {
    throw new Error("package-lock.json is missing root version metadata");
  }
  lock.version = version;
  lock.packages[""]!.version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * Promote the `## Unreleased` changelog section to `## <version> — <date>`,
 * leaving a fresh empty `## Unreleased` on top for the next cycle. If there is
 * no Unreleased section the content is returned unchanged (idempotent-ish).
 */
export function promoteChangelog(content: string, version: string, date: string): string {
  const heading = /^## Unreleased[^\n]*$/m;
  if (!heading.test(content)) return content;
  return content.replace(heading, `## Unreleased\n\n## ${version} — ${date}`);
}

/** Extract the body of the changelog section for a version (everything under
 * `## <version> …` up to the next `## ` heading), for the GitHub Release notes.
 * Tolerates an optional leading `v` on the heading (`## 0.2.0` and `## v0.2.0`
 * both match) — the v0.2.0 notes shipped as the "See CHANGELOG.md." fallback
 * because a hand-written `## v…` heading missed the bare-version regex. */
export function extractChangelogSection(content: string, version: string): string {
  const bare = version.replace(/^v/, "");
  const lines = content.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## v?${escapeRe(bare)}(\\s|$|\\b)`).test(l));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  return body.join("\n").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Today's date as YYYY-MM-DD in UTC. */
export function todayUTC(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Every workspace package.json path (root + each package). */
function workspacePackageJsons(root: string): string[] {
  const paths = [join(root, "package.json")];
  const glob = new Bun.Glob("packages/*/package.json");
  for (const rel of glob.scanSync({ cwd: root })) paths.push(join(root, rel));
  const extensionGlob = new Bun.Glob("extensions/*/package.json");
  for (const rel of extensionGlob.scanSync({ cwd: root })) paths.push(join(root, rel));
  const desktop = join(root, "apps", "desktop", "package.json");
  if (existsSync(desktop)) paths.push(desktop);
  return paths;
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, "..", "..");
  const raw = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!raw) throw new Error("usage: set-version.ts <version> (or set $GITHUB_REF_NAME)");
  const version = parseVersion(raw);
  const date = process.argv[3] ? parseDate(process.argv[3]) : todayUTC();

  const versionFile = join(root, "packages", "cli", "src", "version.ts");
  writeFileSync(versionFile, rewriteVersionFile(readFileSync(versionFile, "utf8"), version));

  for (const pkg of workspacePackageJsons(root)) {
    writeFileSync(pkg, rewritePackageJsonVersion(readFileSync(pkg, "utf8"), version));
  }

  const desktopLock = join(root, "apps", "desktop", "package-lock.json");
  if (existsSync(desktopLock)) {
    writeFileSync(
      desktopLock,
      rewritePackageLockVersion(readFileSync(desktopLock, "utf8"), version),
    );
  }

  const changelog = join(root, "CHANGELOG.md");
  writeFileSync(changelog, promoteChangelog(readFileSync(changelog, "utf8"), version, date));
  const desktopChangelog = join(root, "apps", "desktop", "CHANGELOG.md");
  if (existsSync(desktopChangelog)) {
    writeFileSync(
      desktopChangelog,
      promoteChangelog(readFileSync(desktopChangelog, "utf8"), version, date),
    );
  }

  process.stdout.write(`Stamped version ${version} (${date}).\n`);
}

function parseDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`date must be YYYY-MM-DD, got "${s}"`);
  return s;
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`set-version: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
