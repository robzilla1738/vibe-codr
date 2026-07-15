#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { PortableSessionArchiveV1 } from "@vibe/shared";

const exec = promisify(execFile);

interface Entry { path: string; type: "file" | "symlink"; bytes: number; mode: number; sha256: string; linkTarget?: string }
interface Bundle {
  manifest: {
    schemaVersion: 1;
    archiveSha256: string;
    engineRevision: string;
    entries: Entry[];
    git: {
      isRepository: boolean;
      head: string | null;
      bundlePath?: string;
      stagedPatchPath?: string;
      worktreePatchPath?: string;
      deleted: string[];
      submodules: Array<{ path: string; head: string | null; bundlePath?: string }>;
    };
    [key: string]: unknown;
  };
  files: Array<{ path: string; contentBase64: string }>;
  engine: PortableSessionArchiveV1;
}

const [bundlePath, targetArg, expectedRevision] = process.argv.slice(2);
if (!bundlePath || !targetArg || !expectedRevision) {
  throw new Error("usage: vibe-cloud-bootstrap <bundle.json> <target-root> <engine-revision>");
}
const target = resolve(targetArg);
if (target === "/" || target.length < 4) throw new Error("unsafe target root");
const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Bundle;
verify(bundle, expectedRevision);

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
const content = new Map(bundle.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64")]));
if (bundle.manifest.git.isRepository && bundle.manifest.git.bundlePath) {
  const gitBundle = content.get(bundle.manifest.git.bundlePath);
  if (!gitBundle) throw new Error("git bundle content missing");
  const localBundle = `${target}.bundle`;
  await writeFile(localBundle, gitBundle);
  try { await exec("git", ["clone", localBundle, target], { maxBuffer: 16 * 1024 * 1024 }); }
  finally { await rm(localBundle, { force: true }); }
} else await mkdir(target, { recursive: true });

for (const submodule of [...(bundle.manifest.git.submodules ?? [])].sort((a, b) => {
  const depth = a.path.split("/").length - b.path.split("/").length;
  return depth || a.path.localeCompare(b.path);
})) {
  if (!submodule.bundlePath) continue;
  const data = content.get(submodule.bundlePath);
  if (!data) throw new Error(`submodule bundle content missing: ${submodule.path}`);
  const out = safeJoin(target, submodule.path);
  const localBundle = `${target}.submodule-${sha256(submodule.path).slice(0, 12)}.bundle`;
  await rm(out, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(localBundle, data);
  try {
    await exec("git", ["clone", localBundle, out], { maxBuffer: 16 * 1024 * 1024 });
    if (submodule.head) await exec("git", ["checkout", "--detach", submodule.head], { cwd: out, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await rm(localBundle, { force: true });
  }
}

if (bundle.manifest.git.isRepository) {
  for (const [path, args] of [
    [bundle.manifest.git.stagedPatchPath, ["apply", "--index", "--binary"]],
    [bundle.manifest.git.worktreePatchPath, ["apply", "--binary"]],
  ] as const) {
    if (!path) continue;
    const data = content.get(path);
    if (!data) throw new Error(`git patch missing: ${path}`);
    const patch = `${target}.${path.endsWith("staged.patch") ? "staged" : "worktree"}.patch`;
    await writeFile(patch, data);
    try { await exec("git", [...args, patch], { cwd: target, maxBuffer: 64 * 1024 * 1024 }); }
    finally { await rm(patch, { force: true }); }
  }
}

for (const entry of bundle.manifest.entries) {
  const out = safeJoin(target, entry.path);
  await rm(out, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  if (entry.type === "symlink") {
    if (!entry.linkTarget) throw new Error(`symlink target missing: ${entry.path}`);
    const resolved = resolve(dirname(out), entry.linkTarget);
    if (resolved !== target && !resolved.startsWith(`${target}${sep}`)) throw new Error(`symlink escapes target: ${entry.path}`);
    await symlink(entry.linkTarget, out);
  } else {
    const data = content.get(`workspace/${entry.path}`);
    if (!data || data.byteLength !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`workspace content mismatch: ${entry.path}`);
    await writeFile(out, data, { mode: entry.mode & 0o777 });
    await chmod(out, entry.mode & 0o777);
  }
}
for (const path of bundle.manifest.git.deleted) await rm(safeJoin(target, path), { recursive: true, force: true });
await importPortableSession(target, bundle.engine, expectedRevision);
process.stdout.write(`${JSON.stringify({ ok: true, sessionId: bundle.engine.sessionId, target })}\n`);

function verify(value: Bundle, revision: string): void {
  if (value.manifest.schemaVersion !== 1 || value.manifest.engineRevision !== revision || value.engine.engineRevision !== revision) {
    throw new Error("cloud runtime engine revision mismatch");
  }
  const { archiveSha256, ...manifest } = value.manifest;
  const canonical = JSON.stringify({
    manifest,
    files: value.files.map((file) => [file.path, sha256(Buffer.from(file.contentBase64, "base64"))]),
    engine: value.engine.archiveSha256,
  });
  if (sha256(canonical) !== archiveSha256) throw new Error("workspace archive hash mismatch");
}

function safeJoin(root: string, path: string): string {
  const portable = path.replaceAll("\\", "/");
  if (!portable || portable.startsWith("/") || portable === ".." || portable.startsWith("../") || portable.includes("\0")) throw new Error(`unsafe path: ${path}`);
  const out = resolve(root, ...portable.split("/"));
  if (out !== root && !out.startsWith(`${root}${sep}`)) throw new Error(`path escaped target: ${path}`);
  return out;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function importPortableSession(cwd: string, archive: PortableSessionArchiveV1, revision: string): Promise<void> {
  const host = resolve(import.meta.dirname, "vibecodr-engine-host");
  const child = spawn(host, [], { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const archivePath = resolve(cwd, ".vibe-portable-import.json");
  await writeFile(archivePath, JSON.stringify(archive), { mode: 0o600 });
  child.stdin.write(`${JSON.stringify({ op: "rpc", id: 1, method: "importPortableSession", params: { cwd, archivePath, engineRevision: revision } })}\n`);
  try {
    for await (const line of lines) {
      const message = JSON.parse(line) as { type?: string; id?: number; ok?: boolean; error?: string };
      if (message.type !== "resp" || message.id !== 1) continue;
      if (!message.ok) throw new Error(message.error ?? "portable import failed");
      child.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`engine import host exited ${code}`)));
      });
      return;
    }
    throw new Error("engine import host closed without a response");
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(archivePath, { force: true });
  }
}
