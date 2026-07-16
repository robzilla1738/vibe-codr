import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PortableSessionArchiveV1 } from "../../shared/handoff";
import {
  applyWorkspaceTransfer,
  assembleReturnTransfer,
  createWorkspaceTransfer,
  currentWorkspaceFingerprint,
  rollbackWorkspaceTransfer,
  verifyWorkspaceTransfer,
} from "./workspace-transfer";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const engine: PortableSessionArchiveV1 = {
  schemaVersion: 1,
  sessionId: "session-test",
  sourceRoot: "/source",
  sourceStateRoot: "/state",
  ownershipGeneration: 1,
  executionTarget: { kind: "cloud", provider: "e2b" },
  engineRevision: "abc123",
  createdAt: 1,
  files: [],
  pendingCapabilities: [],
  archiveSha256: "portable-hash",
};

describe("workspace transfer", () => {
  it("builds a deterministic verified non-git transfer and excludes sensitive paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-test-"));
    roots.push(root);
    await mkdir(join(root, ".vibe"), { recursive: true });
    await writeFile(join(root, "hello.txt"), "hello\n");
    await symlink("hello.txt", join(root, "hello-link"));
    await writeFile(join(root, ".env.local"), "SECRET=nope\n");
    await writeFile(join(root, ".envrc"), "export SECRET=nope\n");
    await writeFile(join(root, ".env-secret"), "SECRET=nope\n");
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=nope\n");
    await writeFile(join(root, "private.txt"), "nope\n");
    await writeFile(join(root, ".vibe", "cloudignore"), "private.txt\n");

    const bundle = await createWorkspaceTransfer({
      cwd: root,
      sessionId: "session-test",
      ownershipGeneration: 1,
      engineRevision: "abc123",
      engine,
    });
    expect(() => verifyWorkspaceTransfer(bundle)).not.toThrow();
    expect(bundle.manifest.entries.map((entry) => entry.path)).toContain("hello.txt");
    expect(bundle.manifest.entries).toContainEqual(expect.objectContaining({ path: "hello-link", type: "symlink" }));
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain(".env.local");
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain(".envrc");
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain(".env-secret");
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain(".npmrc");
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain("private.txt");
    expect(bundle.manifest.excludedPaths.map((entry) => entry.path)).toEqual(expect.arrayContaining([".env.local", ".envrc", ".env-secret", ".npmrc", "private.txt"]));
  });

  it("excludes Git metadata from nested repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-nested-git-"));
    roots.push(root);
    await mkdir(join(root, "vendor", "repo", ".git"), { recursive: true });
    await writeFile(join(root, "vendor", "repo", ".git", "config"), "https://token@example.invalid/private.git\n");
    await writeFile(join(root, "vendor", "repo", "source.ts"), "export const portable = true;\n");
    const transfer = await createWorkspaceTransfer({
      cwd: root,
      sessionId: "session-test",
      ownershipGeneration: 1,
      engineRevision: "abc123",
      engine,
    });
    expect(transfer.manifest.entries.some((entry) => entry.path.includes("/.git"))).toBe(false);
    expect(transfer.files.some((file) => file.path.includes("/.git"))).toBe(false);
    expect(transfer.manifest.entries.some((entry) => entry.path === "vendor/repo/source.ts")).toBe(true);
  });

  it("rejects tampered workspace bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-test-"));
    roots.push(root);
    await writeFile(join(root, "hello.txt"), "hello\n");
    const bundle = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    bundle.files.find((file) => file.path === "workspace/hello.txt")!.contentBase64 = Buffer.from("tampered").toString("base64");
    expect(() => verifyWorkspaceTransfer(bundle)).toThrow(/hash mismatch/i);
  });

  it("fails closed when an existing cloudignore policy cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-cloudignore-"));
    roots.push(root);
    await mkdir(join(root, ".vibe"));
    await symlink("missing-policy", join(root, ".vibe", "cloudignore"));
    await writeFile(join(root, "secret.txt"), "must not upload\n");
    await expect(createWorkspaceTransfer({
      cwd: root,
      sessionId: "session-test",
      ownershipGeneration: 1,
      engineRevision: "abc123",
      engine,
    })).rejects.toThrow();
  });

  it("rejects traversal-capable deletion paths from a cloud snapshot", () => {
    const bundle = assembleReturnTransfer({
      snapshot: {
        entries: [],
        files: [],
        git: { isRepository: false, head: null, branch: null, deleted: ["../../outside"], submodules: [] },
      },
      engine,
      workspaceId: "workspace-test",
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: "/source",
      baseFingerprint: "fingerprint",
    });
    expect(() => verifyWorkspaceTransfer(bundle)).toThrow(/unsafe workspace path/i);
  });

  it("rejects protected paths created in cloud before touching the local workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-protected-return-"));
    roots.push(root);
    await writeFile(join(root, ".env.local"), "LOCAL=keep\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: ".env.local", type: "file", bytes: 13, mode: 0o600, sha256: "0".repeat(64) }],
        files: [{ path: "workspace/.env.local", contentBase64: Buffer.from("REMOTE=nope\n").toString("base64") }],
        git: { isRepository: false, head: null, branch: null, deleted: [], submodules: [] },
      },
      engine,
      workspaceId: "workspace-test",
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: "fingerprint",
    });
    await expect(applyWorkspaceTransfer(root, returned)).rejects.toThrow(/excluded path/i);
    await expect(readFile(join(root, ".env.local"), "utf8")).resolves.toBe("LOCAL=keep\n");
  });

  it("does not replace a directory that contains protected local descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-protected-descendant-"));
    roots.push(root);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", ".env"), "LOCAL=keep\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const remoteData = Buffer.from("cloud file\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "config", type: "file", bytes: remoteData.byteLength, mode: 0o644, sha256: createHash("sha256").update(remoteData).digest("hex") }],
        files: [{ path: "workspace/config", contentBase64: remoteData.toString("base64") }],
        git: outbound.manifest.git,
      },
      engine,
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
      exclusionRules: outbound.manifest.exclusionRules,
    });
    const result = await applyWorkspaceTransfer(root, returned);
    expect(result.kind).toBe("diverged");
    await expect(readFile(join(root, "config", ".env"), "utf8")).resolves.toBe("LOCAL=keep\n");
    if (result.kind === "diverged") {
      roots.push(result.worktreePath);
      await expect(readFile(join(result.worktreePath, "config"), "utf8")).resolves.toBe("cloud file\n");
    }
  });

  it("includes Git-ignored project files in the default Cloud workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-ignored-return-"));
    roots.push(root);
    const git = async (...args: string[]) => { await promisify(execFile)("git", args, { cwd: root }); };
    await git("init");
    await git("config", "user.name", "Vibe Test");
    await git("config", "user.email", "vibe@example.invalid");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "base.txt"), "base\n");
    await git("add", ".gitignore", "base.txt");
    await git("commit", "-m", "base");
    await writeFile(join(root, "ignored.txt"), "local generated input\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    expect(outbound.manifest.entries).toContainEqual(expect.objectContaining({ path: "ignored.txt", type: "file" }));
    expect(outbound.files.map((file) => file.path)).toContain("workspace/ignored.txt");
    expect(outbound.manifest.excludedPaths.map((entry) => entry.path)).not.toContain("ignored.txt");
  });

  it("durably announces the recovery path before the first workspace mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-prepared-callback-"));
    roots.push(root);
    await writeFile(join(root, "file.txt"), "local\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const remoteData = Buffer.from("cloud\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "file.txt", type: "file", bytes: remoteData.byteLength, mode: 0o644, sha256: createHash("sha256").update(remoteData).digest("hex") }],
        files: [{ path: "workspace/file.txt", contentBase64: remoteData.toString("base64") }],
        git: outbound.manifest.git,
      },
      engine,
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    let prepared: string | undefined;
    const result = await applyWorkspaceTransfer(root, returned, [], async (planned) => {
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("local\n");
      prepared = planned.kind === "applied" ? planned.recoveryPath : planned.worktreePath;
    });
    expect(result.kind).toBe("applied");
    expect(prepared).toBe(result.kind === "applied" ? result.recoveryPath : result.worktreePath);
    if (result.kind === "applied") roots.push(result.recoveryPath);
  });

  it("rechecks divergence after pre-apply preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-late-divergence-"));
    roots.push(root);
    await writeFile(join(root, "file.txt"), "local base\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const cloud = Buffer.from("cloud\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "file.txt", type: "file", bytes: cloud.byteLength, mode: 0o644, sha256: createHash("sha256").update(cloud).digest("hex") }],
        files: [{ path: "workspace/file.txt", contentBase64: cloud.toString("base64") }],
        git: outbound.manifest.git,
      },
      engine,
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    let changed = false;
    const result = await applyWorkspaceTransfer(root, returned, [], async (planned) => {
      if (planned.kind === "applied" && !changed) {
        changed = true;
        await writeFile(join(root, "file.txt"), "late local edit\n");
      }
    });
    expect(result.kind).toBe("diverged");
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe("late local edit\n");
    if (result.kind === "diverged") {
      roots.push(result.worktreePath);
      await expect(readFile(join(result.worktreePath, "file.txt"), "utf8")).resolves.toBe("cloud\n");
    }
  });

  it("round-trips legitimate file and directory type replacements", async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), "vibe-transfer-file-to-dir-"));
    roots.push(fileRoot);
    await writeFile(join(fileRoot, "foo"), "old file\n");
    const fileOutbound = await createWorkspaceTransfer({ cwd: fileRoot, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const nested = Buffer.from("nested\n");
    const fileToDirectory = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "foo/bar.txt", type: "file", bytes: nested.byteLength, mode: 0o644, sha256: createHash("sha256").update(nested).digest("hex") }],
        files: [{ path: "workspace/foo/bar.txt", contentBase64: nested.toString("base64") }],
        git: { ...fileOutbound.manifest.git, deleted: ["foo"] },
      },
      engine,
      workspaceId: fileOutbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: fileRoot,
      baseFingerprint: fileOutbound.manifest.sourceRootFingerprint,
    });
    const first = await applyWorkspaceTransfer(fileRoot, fileToDirectory);
    expect(first.kind).toBe("applied");
    await expect(readFile(join(fileRoot, "foo", "bar.txt"), "utf8")).resolves.toBe("nested\n");
    if (first.kind === "applied") roots.push(first.recoveryPath);
    if (first.kind === "applied") await rollbackWorkspaceTransfer(fileRoot, first.recoveryPath);
    await expect(readFile(join(fileRoot, "foo"), "utf8")).resolves.toBe("old file\n");

    const directoryRoot = await mkdtemp(join(tmpdir(), "vibe-transfer-dir-to-file-"));
    roots.push(directoryRoot);
    await mkdir(join(directoryRoot, "foo"));
    await writeFile(join(directoryRoot, "foo", "bar.txt"), "old nested\n");
    const directoryOutbound = await createWorkspaceTransfer({ cwd: directoryRoot, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const flat = Buffer.from("flat\n");
    const directoryToFile = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "foo", type: "file", bytes: flat.byteLength, mode: 0o644, sha256: createHash("sha256").update(flat).digest("hex") }],
        files: [{ path: "workspace/foo", contentBase64: flat.toString("base64") }],
        git: { ...directoryOutbound.manifest.git, deleted: ["foo/bar.txt"] },
      },
      engine,
      workspaceId: directoryOutbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: directoryRoot,
      baseFingerprint: directoryOutbound.manifest.sourceRootFingerprint,
    });
    const second = await applyWorkspaceTransfer(directoryRoot, directoryToFile);
    expect(second.kind).toBe("applied");
    await expect(readFile(join(directoryRoot, "foo"), "utf8")).resolves.toBe("flat\n");
    if (second.kind === "applied") roots.push(second.recoveryPath);
    if (second.kind === "applied") await rollbackWorkspaceTransfer(directoryRoot, second.recoveryPath);
    await expect(readFile(join(directoryRoot, "foo", "bar.txt"), "utf8")).resolves.toBe("old nested\n");
  });

  it("applies deletions derived from non-git and untracked outbound entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-return-"));
    roots.push(root);
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, "removed.txt"), "remove\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: outbound.manifest.entries.filter((entry) => entry.path !== "removed.txt"),
        files: outbound.files.filter((file) => file.path !== "workspace/removed.txt"),
        git: { ...outbound.manifest.git, deleted: ["removed.txt"] },
      },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });

    const result = await applyWorkspaceTransfer(root, returned);
    expect(result).toMatchObject({ kind: "applied" });
    if (result.kind === "applied") roots.push(result.recoveryPath);
    await expect(access(join(root, "removed.txt"))).rejects.toThrow();
    await expect(readFile(join(root, "keep.txt"), "utf8")).resolves.toBe("keep\n");
    if (result.kind === "applied") await rollbackWorkspaceTransfer(root, result.recoveryPath);
    await expect(readFile(join(root, "removed.txt"), "utf8")).resolves.toBe("remove\n");
  });

  it("preserves post-interruption local edits before rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-recovery-divergence-"));
    roots.push(root);
    await writeFile(join(root, "file.txt"), "before\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const cloud = Buffer.from("cloud\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "file.txt", type: "file", bytes: cloud.byteLength, mode: 0o644, sha256: createHash("sha256").update(cloud).digest("hex") }],
        files: [{ path: "workspace/file.txt", contentBase64: cloud.toString("base64") }],
        git: outbound.manifest.git,
      },
      engine,
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    const applied = await applyWorkspaceTransfer(root, returned);
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") return;
    roots.push(applied.recoveryPath);
    await writeFile(join(root, "file.txt"), "after interruption\n");
    const preserved = await rollbackWorkspaceTransfer(root, applied.recoveryPath);
    expect(preserved).toBeTruthy();
    if (preserved) {
      roots.push(preserved);
      await expect(readFile(join(preserved, "file.txt"), "utf8")).resolves.toBe("after interruption\n");
    }
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe("before\n");
  });

  it("applies remote deletions inside a divergent review worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-diverged-"));
    roots.push(root);
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, "removed.txt"), "remove\n");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    await writeFile(join(root, "local-change.txt"), "diverged\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: outbound.manifest.entries.filter((entry) => entry.path !== "removed.txt"),
        files: outbound.files.filter((file) => file.path !== "workspace/removed.txt"),
        git: { ...outbound.manifest.git, deleted: ["removed.txt"] },
      },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    const result = await applyWorkspaceTransfer(root, returned);
    expect(result.kind).toBe("diverged");
    if (result.kind !== "diverged") throw new Error("expected divergent worktree");
    roots.push(result.worktreePath);
    await expect(access(join(result.worktreePath, "removed.txt"))).rejects.toThrow();
    await expect(readFile(join(root, "removed.txt"), "utf8")).resolves.toBe("remove\n");
  });

  it("treats an index-only local change as divergence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-index-divergence-"));
    roots.push(root);
    const git = async (...args: string[]) => { await promisify(execFile)("git", args, { cwd: root }); };
    await git("init");
    await git("config", "user.name", "Vibe Test");
    await git("config", "user.email", "vibe@example.invalid");
    await writeFile(join(root, "file.txt"), "base\n");
    await git("add", "file.txt");
    await git("commit", "-m", "base");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    await writeFile(join(root, "file.txt"), "staged\n");
    await git("add", "file.txt");
    await writeFile(join(root, "file.txt"), "base\n");
    const returned = assembleReturnTransfer({
      snapshot: { entries: outbound.manifest.entries, files: outbound.files, git: outbound.manifest.git },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    const result = await applyWorkspaceTransfer(root, returned);
    expect(result.kind).toBe("diverged");
    if (result.kind === "diverged") roots.push(result.worktreePath);
  });

  it("treats a remote branch change as divergence without moving the local branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-branch-divergence-"));
    roots.push(root);
    const gitOutput = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
    await gitOutput("init");
    await gitOutput("config", "user.name", "Vibe Test");
    await gitOutput("config", "user.email", "vibe@example.invalid");
    await writeFile(join(root, "file.txt"), "base\n");
    await gitOutput("add", "file.txt");
    await gitOutput("commit", "-m", "base");
    const originalHead = await gitOutput("rev-parse", "HEAD");
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const returned = assembleReturnTransfer({
      snapshot: { entries: outbound.manifest.entries, files: outbound.files, git: { ...outbound.manifest.git, branch: "feature/cloud" } },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    const result = await applyWorkspaceTransfer(root, returned);
    expect(result.kind).toBe("diverged");
    if (result.kind === "diverged") roots.push(result.worktreePath);
    expect(await gitOutput("rev-parse", "HEAD")).toBe(originalHead);
  });

  it("restores executable modes from a recovery archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-mode-recovery-"));
    roots.push(root);
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho local\n");
    await chmod(join(root, "run.sh"), 0o755);
    const outbound = await createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    const remoteData = Buffer.from("#!/bin/sh\necho cloud\n");
    const returned = assembleReturnTransfer({
      snapshot: {
        entries: [{ path: "run.sh", type: "file", bytes: remoteData.byteLength, mode: 0o644, sha256: createHash("sha256").update(remoteData).digest("hex") }],
        files: [{ path: "workspace/run.sh", contentBase64: remoteData.toString("base64") }],
        git: outbound.manifest.git,
      },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: root,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
    });
    const result = await applyWorkspaceTransfer(root, returned);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied return");
    roots.push(result.recoveryPath);
    await rollbackWorkspaceTransfer(root, result.recoveryPath);
    expect((await lstat(join(root, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("blocks a Git bundle when an excluded path exists only in history", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-history-"));
    roots.push(root);
    const run = async (...args: string[]) => {
      await promisify(execFile)("git", args, { cwd: root });
    };
    await run("init");
    await run("config", "user.name", "Vibe Test");
    await run("config", "user.email", "vibe@example.invalid");
    await writeFile(join(root, ".envrc"), "SECRET=never-upload\n");
    await run("add", ".envrc");
    await run("commit", "-m", "secret history");
    await rm(join(root, ".envrc"));
    await run("commit", "-am", "remove secret");
    await writeFile(join(root, "safe.txt"), "safe\n");

    await expect(createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine }))
      .rejects.toThrow(/excluded paths exist in reachable Git history/i);
  });

  it("blocks common registry credentials that exist only in Git history", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-transfer-registry-history-"));
    roots.push(root);
    const run = async (...args: string[]) => { await promisify(execFile)("git", args, { cwd: root }); };
    await run("init");
    await run("config", "user.name", "Vibe Test");
    await run("config", "user.email", "vibe@example.invalid");
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=never-upload\n");
    await run("add", ".npmrc");
    await run("commit", "-m", "registry credential history");
    await rm(join(root, ".npmrc"));
    await run("commit", "-am", "remove registry credential");

    await expect(createWorkspaceTransfer({ cwd: root, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine }))
      .rejects.toThrow(/excluded paths exist in reachable Git history/i);
  });

  it("includes submodule repository state and working files in the cloud transfer", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibe-transfer-parent-"));
    const child = await mkdtemp(join(tmpdir(), "vibe-transfer-child-"));
    roots.push(parent, child);
    const git = async (cwd: string, ...args: string[]) => { await promisify(execFile)("git", args, { cwd }); };
    for (const cwd of [parent, child]) {
      await git(cwd, "init");
      await git(cwd, "config", "user.name", "Vibe Test");
      await git(cwd, "config", "user.email", "vibe@example.invalid");
    }
    await writeFile(join(child, "library.txt"), "portable submodule\n");
    await writeFile(join(child, ".gitignore"), "secret.pem\n");
    await writeFile(join(child, "secret.pem"), "never upload\n");
    await git(child, "add", "library.txt", ".gitignore");
    await git(child, "commit", "-m", "child");
    await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "modules/child");
    await writeFile(join(parent, "modules", "child", "secret.pem"), "never upload\n");
    await git(parent, "commit", "-am", "add submodule");

    const bundle = await createWorkspaceTransfer({ cwd: parent, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });
    expect(bundle.manifest.git.submodules).toEqual([
      expect.objectContaining({ path: "modules/child", bundlePath: expect.stringMatching(/^git\/submodules\//) }),
    ]);
    expect(bundle.manifest.entries.map((entry) => entry.path)).toContain("modules/child/library.txt");
    expect(bundle.manifest.entries.map((entry) => entry.path)).not.toContain("modules/child/secret.pem");
    expect(bundle.manifest.excludedPaths).toContainEqual({ path: "modules/child/secret.pem", reason: "sensitive or generated default" });
    expect(bundle.files.map((file) => file.path)).toContain("workspace/modules/child/library.txt");
    await expect(currentWorkspaceFingerprint(parent, bundle.manifest.excludedPaths.map((entry) => entry.path)))
      .resolves.toBe(bundle.manifest.sourceRootFingerprint);
  }, 15_000);

  it("blocks workspace-wide exclusions found only in submodule history", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibe-transfer-submodule-history-parent-"));
    const child = await mkdtemp(join(tmpdir(), "vibe-transfer-submodule-history-child-"));
    roots.push(parent, child);
    const git = async (cwd: string, ...args: string[]) => { await promisify(execFile)("git", args, { cwd }); };
    for (const cwd of [parent, child]) {
      await git(cwd, "init");
      await git(cwd, "config", "user.name", "Vibe Test");
      await git(cwd, "config", "user.email", "vibe@example.invalid");
    }
    await writeFile(join(child, "retired.pem"), "private key material\n");
    await git(child, "add", "retired.pem");
    await git(child, "commit", "-m", "add retired key");
    await rm(join(child, "retired.pem"));
    await git(child, "add", "-u");
    await git(child, "commit", "-m", "remove retired key");
    await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "modules/child");
    await git(parent, "commit", "-am", "add submodule");

    await expect(createWorkspaceTransfer({
      cwd: parent,
      sessionId: "session-test",
      ownershipGeneration: 1,
      engineRevision: "abc123",
      engine,
      additionalExclusions: ["**/*.pem"],
    })).rejects.toThrow(/modules\/child\/retired\.pem/);
  });

  it("restores cloud-only submodule commits before completing local return", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibe-return-parent-"));
    const child = await mkdtemp(join(tmpdir(), "vibe-return-child-"));
    const local = await mkdtemp(join(tmpdir(), "vibe-return-local-"));
    roots.push(parent, child, local);
    const git = async (cwd: string, ...args: string[]) => { await promisify(execFile)("git", args, { cwd }); };
    const gitText = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd, encoding: "utf8" })).stdout.trim();
    for (const cwd of [parent, child]) {
      await git(cwd, "init");
      await git(cwd, "config", "user.name", "Vibe Test");
      await git(cwd, "config", "user.email", "vibe@example.invalid");
    }
    await writeFile(join(child, "library.txt"), "base\n");
    await git(child, "add", "library.txt");
    await git(child, "commit", "-m", "base child");
    await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "modules/child");
    await git(parent, "commit", "-am", "base parent");
    await git(tmpdir(), "clone", parent, local);
    await git(local, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
    const outbound = await createWorkspaceTransfer({ cwd: local, sessionId: "session-test", ownershipGeneration: 1, engineRevision: "abc123", engine });

    const remoteSubmodule = join(parent, "modules", "child");
    await git(remoteSubmodule, "config", "user.name", "Vibe Test");
    await git(remoteSubmodule, "config", "user.email", "vibe@example.invalid");
    await writeFile(join(remoteSubmodule, "library.txt"), "cloud commit\n");
    await git(remoteSubmodule, "add", "library.txt");
    await git(remoteSubmodule, "commit", "-m", "cloud-only child");
    const remoteSubmoduleHead = await gitText(remoteSubmodule, "rev-parse", "HEAD");
    await git(parent, "add", "modules/child");
    await git(parent, "commit", "-m", "advance child");
    const remote = await createWorkspaceTransfer({ cwd: parent, sessionId: "session-test", ownershipGeneration: 2, engineRevision: "abc123", engine });
    const returned = assembleReturnTransfer({
      snapshot: { entries: remote.manifest.entries, files: remote.files, git: remote.manifest.git },
      engine: { ...engine, ownershipGeneration: 2, executionTarget: { kind: "local" } },
      workspaceId: outbound.manifest.workspaceId,
      sessionId: "session-test",
      ownershipGeneration: 2,
      engineRevision: "abc123",
      sourceRoot: local,
      baseFingerprint: outbound.manifest.sourceRootFingerprint,
      exclusionRules: outbound.manifest.exclusionRules,
    });
    const result = await applyWorkspaceTransfer(local, returned);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") roots.push(result.recoveryPath);
    expect(await gitText(join(local, "modules", "child"), "rev-parse", "HEAD")).toBe(remoteSubmoduleHead);
    await expect(readFile(join(local, "modules", "child", "library.txt"), "utf8")).resolves.toBe("cloud commit\n");
  }, 15_000);
});
