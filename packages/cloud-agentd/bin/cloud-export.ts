#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [rootArg, baseBundlePath, outputPath] = process.argv.slice(2);
if (!rootArg || !baseBundlePath || !outputPath) throw new Error("usage: vibe-cloud-export <workspace> <outbound-bundle.json> <output.json>");
const root = resolve(rootArg);
const base = JSON.parse(await readFile(baseBundlePath, "utf8")) as { manifest?: { entries?: Array<{ path: string }> } };
const paths = [...new Set(await candidates(root))].sort();
const queuedPaths = new Set(paths);
const entries: Array<{ path: string; type: "file" | "symlink"; bytes: number; mode: number; sha256: string; linkTarget?: string }> = [];
const files: Array<{ path: string; contentBase64: string }> = [];
for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
  const path = paths[pathIndex]!;
  const absolute = safeJoin(root, path);
  const stat = await lstat(absolute);
  if (stat.isDirectory()) {
    for (const nested of await walk(absolute)) {
      const candidate = posix.join(path, nested);
      if (queuedPaths.has(candidate)) continue;
      queuedPaths.add(candidate);
      paths.push(candidate);
    }
  } else if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    const resolved = resolve(dirname(absolute), target);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) continue;
    entries.push({ path, type: "symlink", bytes: Buffer.byteLength(target), mode: stat.mode & 0o777, sha256: hash(target), linkTarget: target });
  } else if (stat.isFile() && stat.size <= 64 * 1024 * 1024) {
    const data = await readFile(absolute);
    entries.push({ path, type: "file", bytes: data.byteLength, mode: stat.mode & 0o777, sha256: hash(data) });
    files.push({ path: `workspace/${path}`, contentBase64: data.toString("base64") });
  }
}
const current = new Set(entries.map((entry) => entry.path));
const deleted = (base.manifest?.entries ?? []).map((entry) => entry.path).filter((path) => !current.has(path));
let head: string | null = null;
let branch: string | null = null;
let bundlePath: string | undefined;
let stagedPatchPath: string | undefined;
let worktreePatchPath: string | undefined;
const submodules: Array<{ path: string; head: string | null; bundlePath?: string }> = [];
try {
  head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
  branch = (await exec("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" })).stdout.trim() || null;
  const repositoryBundle = `${outputPath}.bundle`;
  await exec("git", ["bundle", "create", repositoryBundle, "--all"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  files.push({ path: "git/repository.bundle", contentBase64: (await readFile(repositoryBundle)).toString("base64") });
  bundlePath = "git/repository.bundle";
  const staged = (await exec("git", ["diff", "--cached", "--binary", "--full-index"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
  if (staged) { stagedPatchPath = "git/staged.patch"; files.push({ path: stagedPatchPath, contentBase64: Buffer.from(staged).toString("base64") }); }
  const worktree = (await exec("git", ["diff", "--binary", "--full-index"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
  if (worktree) { worktreePatchPath = "git/worktree.patch"; files.push({ path: worktreePatchPath, contentBase64: Buffer.from(worktree).toString("base64") }); }
} catch { /* non-git or unborn */ }
if (head) {
  const status = (await exec("git", ["submodule", "status", "--recursive"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
  for (const line of status.split("\n")) {
    const match = line.match(/^[ +-U]?([0-9a-f]{40,64})\s+([^\s]+)(?:\s|$)/);
    if (!match?.[1] || !match[2]) continue;
    const path = portable(match[2]);
    const submoduleRoot = safeJoin(root, path);
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: submoduleRoot, encoding: "utf8" })).stdout.trim() || match[1];
    const submoduleBundle = `${outputPath}.submodule-${hash(path).slice(0, 12)}.bundle`;
    await exec("git", ["bundle", "create", submoduleBundle, "--all"], { cwd: submoduleRoot, maxBuffer: 16 * 1024 * 1024 });
    const submoduleBundlePath = `git/submodules/${hash(path).slice(0, 12)}.bundle`;
    files.push({ path: submoduleBundlePath, contentBase64: (await readFile(submoduleBundle)).toString("base64") });
    submodules.push({ path, head, bundlePath: submoduleBundlePath });
  }
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ entries, files, git: { isRepository: !!head, head, branch, deleted, submodules, ...(bundlePath ? { bundlePath } : {}), ...(stagedPatchPath ? { stagedPatchPath } : {}), ...(worktreePatchPath ? { worktreePatchPath } : {}) } })}\n`);

async function candidates(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean).map(portable);
  } catch { return walk(cwd); }
}

async function walk(cwd: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(cwd, prefix), { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    if (/(^|\/)(?:\.git|node_modules|\.ssh|\.aws|\.azure|\.kube|\.docker)(?:\/|$)/.test(path) || /(^|\/)\.env(?:\.|$)/.test(path)) continue;
    if (entry.isDirectory()) out.push(...await walk(cwd, path)); else out.push(path);
  }
  return out;
}

function portable(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.startsWith("../") || path.includes("\0")) throw new Error("unsafe path");
  return path;
}
function safeJoin(cwd: string, path: string): string {
  const out = resolve(cwd, ...portable(path).split("/"));
  if (out !== cwd && !out.startsWith(`${cwd}${sep}`)) throw new Error("path escaped root");
  return out;
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
