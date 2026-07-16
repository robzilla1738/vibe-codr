import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceFileEntryV1,
  WorkspaceTransferBundleV1,
  WorkspaceTransferManifestV1,
} from "../../shared/cloud";
import type { PortableSessionArchiveV1 } from "../../shared/handoff";

const exec = promisify(execFile);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// Return snapshots are JSON/base64 and capped at 256 MiB by the provider
// download boundary. 128 MiB raw leaves deterministic room for 4/3 expansion,
// Git metadata, and the portable session archive in both directions.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const HARD_EXCLUDES = [
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)\.env[^/]*(?:\/|$)/,
  /(^|\/)\.ssh(?:\/|$)/,
  /(^|\/)\.aws(?:\/|$)/,
  /(^|\/)\.azure(?:\/|$)/,
  /(^|\/)\.kube(?:\/|$)/,
  /(^|\/)\.docker(?:\/|$)/,
  /(^|\/)\.config\/gcloud(?:\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.gitcookies$/,
  /(^|\/)credentials(?:\.json)?$/i,
  /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.[^/]*)?$/i,
  /(^|\/)[^/]+\.(?:pem|key|p12|pfx)$/i,
  /(^|\/)node_modules(?:\/|$)/,
  /(^|\/)\.DS_Store$/,
];

interface CreateTransferOptions {
  cwd: string;
  sessionId: string;
  ownershipGeneration: number;
  engineRevision: string;
  engine: PortableSessionArchiveV1;
  portableCapabilities?: string[];
  relayOnlyCapabilities?: string[];
  restartableJobs?: WorkspaceTransferManifestV1["restartableJobs"];
  additionalExclusions?: string[];
}

export interface RemoteWorkspaceSnapshotV1 {
  entries: WorkspaceFileEntryV1[];
  files: WorkspaceTransferBundleV1["files"];
  git: WorkspaceTransferManifestV1["git"];
}

export function assembleReturnTransfer(options: {
  snapshot: RemoteWorkspaceSnapshotV1;
  engine: PortableSessionArchiveV1;
  workspaceId: string;
  sessionId: string;
  ownershipGeneration: number;
  engineRevision: string;
  sourceRoot: string;
  baseFingerprint: string;
  exclusionRules?: string[];
  excludedPaths?: Array<{ path: string; reason: string }>;
}): WorkspaceTransferBundleV1 {
  const entries = options.snapshot.entries.slice().sort((a, b) => a.path.localeCompare(b.path));
  const files = options.snapshot.files.slice().sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    + files.filter((file) => !file.path.startsWith("workspace/")).reduce((sum, file) => sum + decodedBase64Bytes(file.contentBase64), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Returned workspace transfer exceeds the 128 MiB safety limit");
  const manifestBase = {
    schemaVersion: 1 as const,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    ownershipGeneration: options.ownershipGeneration,
    engineRevision: options.engineRevision,
    sourceRoot: options.sourceRoot,
    sourceRootFingerprint: options.baseFingerprint,
    git: options.snapshot.git,
    entries,
    portableCapabilities: ["git", "terminal", "jobs", "skills", "plugins", "hooks", "http-mcp", "portable-stdio-mcp"],
    relayOnlyCapabilities: ["macos-apps", "local-browser", "ollama", "lm-studio", "local-mcp"],
    restartableJobs: [],
    excludedPaths: [...(options.excludedPaths ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    exclusionRules: [...(options.exclusionRules ?? [])].sort(),
    totalBytes,
    createdAt: Date.now(),
  };
  return { manifest: { ...manifestBase, archiveSha256: hash(canonicalTransfer(manifestBase, files, options.engine)) }, files, engine: options.engine };
}

export async function createWorkspaceTransfer(options: CreateTransferOptions): Promise<WorkspaceTransferBundleV1> {
  const cwd = resolve(options.cwd);
  const canonicalCwd = await realpath(cwd);
  const git = await gitMetadata(cwd);
  const cloudignore = await readCloudignore(cwd);
  const exclusionGlobs = [...cloudignore, ...(options.additionalExclusions ?? [])];
  const patterns = exclusionGlobs.map(globRegex);
  const excludedPaths: WorkspaceTransferManifestV1["excludedPaths"] = [];
  // Cloud gets the complete usable project tree, including Git-ignored files.
  // Git ignore rules are about source control, not sandbox portability. Hard
  // machine-secret/generated exclusions and .vibe/cloudignore still apply.
  const initialCandidates = await walkCandidates(cwd);
  const candidates = [...new Set(initialCandidates)].sort();
  const queuedCandidates = new Set(candidates);
  const entries: WorkspaceFileEntryV1[] = [];
  const files: WorkspaceTransferBundleV1["files"] = [];
  let totalBytes = 0;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const raw = candidates[candidateIndex]!;
    const path = toPortablePath(raw);
    const hard = HARD_EXCLUDES.find((pattern) => pattern.test(path));
    if (hard || patterns.some((pattern) => pattern.test(path))) {
      excludedPaths.push({ path, reason: hard ? "sensitive or generated default" : ".vibe/cloudignore" });
      continue;
    }
    const absolute = join(cwd, ...path.split("/"));
    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try { fileStat = await lstat(absolute); } catch { continue; }
    if (fileStat.isDirectory()) {
      const canonical = await realpath(absolute);
      if (canonical !== canonicalCwd && !canonical.startsWith(`${canonicalCwd}${sep}`)) {
        throw new Error(`Workspace directory escaped root while scanning: ${path}`);
      }
      const nestedCandidates = await walkCandidates(absolute);
      for (const nested of nestedCandidates) {
        const candidate = posix.join(path, nested);
        if (queuedCandidates.has(candidate)) continue;
        queuedCandidates.add(candidate);
        candidates.push(candidate);
      }
      continue;
    }
    if (fileStat.isSocket() || fileStat.isFIFO() || fileStat.isCharacterDevice() || fileStat.isBlockDevice()) {
      excludedPaths.push({ path, reason: "non-portable filesystem object" });
      continue;
    }
    if (fileStat.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = resolve(dirname(absolute), target);
      if (isAbsolute(target) || (resolved !== cwd && !resolved.startsWith(`${cwd}${sep}`))) {
        excludedPaths.push({ path, reason: "symlink escapes workspace" });
        continue;
      }
      const content = Buffer.from(target);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Workspace transfer exceeds the 128 MiB safety limit");
      entries.push({ path, type: "symlink", bytes: content.byteLength, mode: fileStat.mode & 0o777, sha256: hash(content), linkTarget: target });
      continue;
    }
    if (!fileStat.isFile()) continue;
    const opened = await readRegularFileNoFollow(canonicalCwd, absolute, path);
    if (opened.exceeded) {
      excludedPaths.push({ path, reason: "file exceeds 64 MiB" });
      continue;
    }
    const { content, mode } = opened;
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Workspace transfer exceeds the 128 MiB safety limit");
    const sha256 = hash(content);
    entries.push({ path, type: "file", bytes: content.byteLength, mode, sha256 });
    files.push({ path: `workspace/${path}`, contentBase64: content.toString("base64") });
  }

  const temp = await mkdtemp(join(tmpdir(), "vibe-cloud-bundle-"));
  try {
    if (git.isRepository && git.head) {
      await assertGitHistoryExcludes(cwd, patterns);
      const bundle = join(temp, "repository.bundle");
      await exec("git", ["bundle", "create", bundle, "--all"], { cwd, maxBuffer: 16 * 1024 * 1024 });
      const content = await readFile(bundle);
      files.push({ path: "git/repository.bundle", contentBase64: content.toString("base64") });
      git.bundlePath = "git/repository.bundle";
      totalBytes += content.byteLength;
      const staged = await gitRaw(cwd, ["diff", "--cached", "--binary", "--full-index"]);
      if (staged) {
        const data = Buffer.from(staged);
        git.stagedPatchPath = "git/staged.patch";
        files.push({ path: git.stagedPatchPath, contentBase64: data.toString("base64") });
        totalBytes += data.byteLength;
      }
      const worktree = await gitRaw(cwd, ["diff", "--binary", "--full-index"]);
      if (worktree) {
        const data = Buffer.from(worktree);
        git.worktreePatchPath = "git/worktree.patch";
        files.push({ path: git.worktreePatchPath, contentBase64: data.toString("base64") });
        totalBytes += data.byteLength;
      }
    }
    for (const submodule of git.submodules) {
      if (!submodule.head) continue;
      if (patterns.some((pattern) => pattern.test(submodule.path))) {
        excludedPaths.push({ path: submodule.path, reason: ".vibe/cloudignore" });
        continue;
      }
      const bundle = join(temp, `${hash(submodule.path).slice(0, 12)}.bundle`);
      try {
        await assertGitHistoryExcludes(join(cwd, submodule.path), patterns, submodule.path);
        await exec("git", ["bundle", "create", bundle, "--all"], { cwd: join(cwd, submodule.path), maxBuffer: 16 * 1024 * 1024 });
        const content = await readFile(bundle);
        submodule.bundlePath = `git/submodules/${hash(submodule.path).slice(0, 12)}.bundle`;
        files.push({ path: submodule.bundlePath, contentBase64: content.toString("base64") });
        totalBytes += content.byteLength;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Cloud handoff blocked:")) throw error;
        excludedPaths.push({ path: submodule.path, reason: "submodule bundle could not be created" });
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Workspace transfer exceeds the 128 MiB safety limit");

  entries.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const sourceRootFingerprint = fingerprint(git.head, git.branch, git.indexHash, git.deleted, entries);
  const manifestBase = {
    schemaVersion: 1 as const,
    workspaceId: hash(cwd).slice(0, 24),
    sessionId: options.sessionId,
    ownershipGeneration: options.ownershipGeneration,
    engineRevision: options.engineRevision,
    sourceRoot: cwd,
    sourceRootFingerprint,
    git,
    entries,
    portableCapabilities: [...(options.portableCapabilities ?? [])].sort(),
    relayOnlyCapabilities: [...(options.relayOnlyCapabilities ?? [])].sort(),
    restartableJobs: options.restartableJobs ?? [],
    excludedPaths: [...new Map(excludedPaths.map((entry) => [entry.path, entry])).values()]
      .sort((a, b) => a.path.localeCompare(b.path)),
    exclusionRules: [...exclusionGlobs].sort(),
    totalBytes,
    createdAt: Date.now(),
  };
  const archiveSha256 = hash(canonicalTransfer(manifestBase, files, options.engine));
  return { manifest: { ...manifestBase, archiveSha256 }, files, engine: options.engine };
}

async function readRegularFileNoFollow(
  root: string,
  absolute: string,
  portablePath: string,
): Promise<{ exceeded: true } | { exceeded: false; content: Buffer; mode: number }> {
  const file = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await file.stat();
    if (!openedStat.isFile()) throw new Error(`Workspace path changed type while scanning: ${portablePath}`);
    const canonical = await realpath(absolute);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
      throw new Error(`Workspace file escaped root while scanning: ${portablePath}`);
    }
    const pathStat = await lstat(absolute);
    if (!pathStat.isFile() || pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
      throw new Error(`Workspace path changed while scanning: ${portablePath}`);
    }
    if (openedStat.size > MAX_FILE_BYTES) return { exceeded: true };
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_FILE_BYTES + 1 - bytes));
      const result = await file.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > MAX_FILE_BYTES) return { exceeded: true };
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const finalPathStat = await lstat(absolute);
    if (!finalPathStat.isFile() || finalPathStat.dev !== openedStat.dev || finalPathStat.ino !== openedStat.ino) {
      throw new Error(`Workspace path changed while reading: ${portablePath}`);
    }
    return { exceeded: false, content: Buffer.concat(chunks, bytes), mode: openedStat.mode & 0o777 };
  } finally {
    await file.close();
  }
}

async function assertGitHistoryExcludes(cwd: string, patterns: RegExp[], workspacePrefix = ""): Promise<void> {
  const outputs = await Promise.all([
    gitRaw(cwd, ["log", "--all", "--pretty=format:", "--name-only", "-z"]),
    gitRaw(cwd, ["diff", "--cached", "--name-only", "-z"]),
    gitRaw(cwd, ["diff", "--name-only", "-z"]),
  ]);
  const blocked = new Set<string>();
  for (const raw of outputs.join("\0").split("\0")) {
    const value = raw.replace(/^\n+|\n+$/g, "");
    if (!value) continue;
    let path: string;
    try { path = toPortablePath(value); } catch { throw new Error("Git history contains a path that cannot be transferred safely"); }
    const workspacePath = workspacePrefix ? `${workspacePrefix}/${path}` : path;
    if (HARD_EXCLUDES.some((pattern) => pattern.test(workspacePath)) || patterns.some((pattern) => pattern.test(workspacePath))) {
      blocked.add(workspacePath);
    }
  }
  if (blocked.size) {
    const preview = [...blocked].sort().slice(0, 8).join(", ");
    throw new Error(`Cloud handoff blocked: excluded paths exist in reachable Git history (${preview}). Purge them from history or use a sanitized repository before handoff.`);
  }
}

export function verifyWorkspaceTransfer(bundle: WorkspaceTransferBundleV1, additionalExclusions: readonly string[] = []): void {
  if (bundle.manifest.schemaVersion !== 1) throw new Error("Unsupported workspace transfer schema");
  const returnExclusions = additionalExclusions.map(globRegex);
  const entryByPath = new Map<string, WorkspaceFileEntryV1>();
  for (const entry of bundle.manifest.entries) {
    const path = toPortablePath(entry.path);
    if (HARD_EXCLUDES.some((pattern) => pattern.test(path)) || returnExclusions.some((pattern) => pattern.test(path))) {
      throw new Error(`Returned workspace contains an excluded path: ${path}`);
    }
    if (entryByPath.has(path)) throw new Error(`Duplicate workspace entry: ${path}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) throw new Error(`Invalid workspace entry size: ${path}`);
    if (entry.type === "symlink") assertContainedLink(path, entry.linkTarget);
    entryByPath.set(path, entry);
  }
  const paths = [...entryByPath.keys()].sort();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    if (paths[index + 1]?.startsWith(`${path}/`)) {
      throw new Error(`Workspace entry descends through another entry: ${paths[index + 1]}`);
    }
  }
  const deleted = new Set<string>();
  for (const raw of bundle.manifest.git.deleted) {
    const path = toPortablePath(raw);
    if (HARD_EXCLUDES.some((pattern) => pattern.test(path)) || returnExclusions.some((pattern) => pattern.test(path))) {
      throw new Error(`Returned workspace deletes an excluded path: ${path}`);
    }
    if (deleted.has(path)) throw new Error(`Duplicate workspace deletion: ${path}`);
    if (entryByPath.has(path)) throw new Error(`Workspace deletion conflicts with returned content: ${path}`);
    deleted.add(path);
  }
  const filePaths = new Set<string>();
  for (const file of bundle.files) {
    const transferPath = toPortablePath(file.path);
    if (filePaths.has(transferPath)) throw new Error(`Duplicate transfer file: ${transferPath}`);
    filePaths.add(transferPath);
    if (!file.path.startsWith("workspace/")) continue;
    const path = toPortablePath(file.path.slice("workspace/".length));
    const entry = entryByPath.get(path);
    if (entry?.type !== "file") throw new Error(`Unmanifested workspace file: ${path}`);
    const data = Buffer.from(file.contentBase64, "base64");
    if (data.byteLength !== entry.bytes || hash(data) !== entry.sha256) throw new Error(`Workspace file hash mismatch: ${path}`);
  }
  for (const [path, entry] of entryByPath) {
    if (entry.type === "file" && !filePaths.has(`workspace/${path}`)) throw new Error(`Workspace content missing: ${path}`);
  }
  const computedBytes = bundle.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    + bundle.files.filter((file) => !file.path.startsWith("workspace/")).reduce((sum, file) => sum + decodedBase64Bytes(file.contentBase64), 0);
  if (computedBytes > MAX_TOTAL_BYTES) throw new Error("Workspace transfer exceeds the 128 MiB safety limit");
  if (bundle.manifest.totalBytes !== computedBytes) throw new Error("Workspace transfer size manifest mismatch");
  const { archiveSha256, ...manifestBase } = bundle.manifest;
  if (hash(canonicalTransfer(manifestBase, bundle.files, bundle.engine)) !== archiveSha256) {
    throw new Error("Workspace transfer archive hash mismatch");
  }
}

export async function currentWorkspaceFingerprint(cwd: string, excluded: readonly string[] = []): Promise<string> {
  const root = resolve(cwd);
  const git = await gitMetadata(root);
  const candidates = await walkCandidates(root);
  const queuedCandidates = new Set(candidates);
  const entries: WorkspaceFileEntryV1[] = [];
  const excludedPatterns = excluded.map(globRegex);
  candidates.sort();
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const raw = candidates[candidateIndex]!;
    const path = toPortablePath(raw);
    if (HARD_EXCLUDES.some((pattern) => pattern.test(path)) || excludedPatterns.some((pattern) => pattern.test(path))) continue;
    try {
      const stat = await lstat(join(root, ...path.split("/")));
      if (stat.isDirectory()) {
        for (const nested of await walkCandidates(join(root, ...path.split("/")))) {
          const candidate = posix.join(path, nested);
          if (queuedCandidates.has(candidate)) continue;
          queuedCandidates.add(candidate);
          candidates.push(candidate);
        }
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(join(root, ...path.split("/")));
        entries.push({ path, type: "symlink", bytes: Buffer.byteLength(target), mode: stat.mode & 0o777, sha256: hash(target), linkTarget: target });
      } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        const data = await readFile(join(root, ...path.split("/")));
        entries.push({ path, type: "file", bytes: data.byteLength, mode: stat.mode & 0o777, sha256: hash(data) });
      }
    } catch { /* changed during scan; fingerprint will diverge */ }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return fingerprint(git.head, git.branch, git.indexHash, git.deleted, entries);
}

export type WorkspaceApplyResult =
  | { kind: "applied"; recoveryPath: string }
  | { kind: "diverged"; worktreePath: string };

export async function applyWorkspaceTransfer(
  cwd: string,
  bundle: WorkspaceTransferBundleV1,
  additionalExclusions: readonly string[] = [],
  onPrepared?: (result: WorkspaceApplyResult) => Promise<void>,
): Promise<WorkspaceApplyResult> {
  verifyWorkspaceTransfer(bundle, additionalExclusions);
  const root = resolve(cwd);
  const current = await currentWorkspaceFingerprint(root, [
    ...bundle.manifest.excludedPaths.map((entry) => entry.path),
    ...additionalExclusions,
  ]);
  const localGit = await gitMetadata(root);
  const branchDiverged = bundle.manifest.git.isRepository && localGit.isRepository
    && bundle.manifest.git.branch !== localGit.branch;
  const protectedReturn = await returnTouchesProtectedLocalPath(root, bundle, additionalExclusions);
  const fetchedHead = await fetchTransferredGit(root, bundle, additionalExclusions);
  await validateTransferredSubmoduleBundles(bundle, additionalExclusions);
  const submoduleRepositoryDiverged = await hasMissingSubmoduleRepository(root, bundle);
  if (current !== bundle.manifest.sourceRootFingerprint || branchDiverged || submoduleRepositoryDiverged || protectedReturn) {
    return applyDivergedWorkspace(root, bundle, fetchedHead, onPrepared);
  }

  const recoveryPath = join(homedir(), ".vibe", "recovery", bundle.manifest.workspaceId, `${Date.now()}-${randomUUID()}`);
  const affected = new Set([...bundle.manifest.entries.map((entry) => entry.path), ...bundle.manifest.git.deleted]);
  try {
    for (const path of affected) await assertNoSymlinkParents(root, path);
    await assertNoProtectedDescendants(root, affected, additionalExclusions);
    await mkdir(recoveryPath, { recursive: true });
    await pruneRecoveryArchives(dirname(recoveryPath));
    for (const path of minimalAffectedRoots(affected)) {
      const source = safeJoin(root, path);
      try {
        const stat = await lstat(source);
        const destination = safeJoin(join(recoveryPath, "files"), path);
        await mkdir(dirname(destination), { recursive: true });
        if (stat.isSymbolicLink()) await symlink(await readlink(source), destination);
        else if (stat.isFile()) await writeFile(destination, await readFile(source), { mode: stat.mode & 0o777 });
        else if (stat.isDirectory()) {
          await cp(source, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    await writeFile(join(recoveryPath, "manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
    const previousSubmodules: Array<{ path: string; head: string }> = [];
    for (const submodule of bundle.manifest.git.submodules) {
      try {
        const head = await gitText(safeJoin(root, submodule.path), ["rev-parse", "HEAD"]);
        if (head) previousSubmodules.push({ path: submodule.path, head });
      } catch { /* divergence check already keeps missing repositories out of this path */ }
    }
    if (previousSubmodules.length) {
      await writeFile(join(recoveryPath, "submodules.json"), `${JSON.stringify(previousSubmodules)}\n`);
    }
    await onPrepared?.({ kind: "applied", recoveryPath });
    const finalFingerprint = await currentWorkspaceFingerprint(root, [
      ...bundle.manifest.excludedPaths.map((entry) => entry.path),
      ...additionalExclusions,
    ]);
    const finalGit = await gitMetadata(root);
    const finalBranchDiverged = bundle.manifest.git.isRepository && finalGit.isRepository
      && bundle.manifest.git.branch !== finalGit.branch;
    if (
      finalFingerprint !== bundle.manifest.sourceRootFingerprint
      || finalBranchDiverged
      || await hasMissingSubmoduleRepository(root, bundle)
    ) {
      await rm(recoveryPath, { recursive: true, force: true });
      return applyDivergedWorkspace(root, bundle, fetchedHead, onPrepared);
    }
    let oldHead: string | null = null;
    if (bundle.manifest.git.isRepository) {
      try {
        const oldIndexTree = (await gitRaw(root, ["write-tree"])).trim();
        if (oldIndexTree) await writeFile(join(recoveryPath, "old-index-tree"), `${oldIndexTree}\n`);
      } catch { /* conflicted indexes are already forced to the divergent path */ }
    }
    if (fetchedHead) {
      oldHead = (await gitRaw(root, ["rev-parse", "HEAD"])).trim();
      if (oldHead !== fetchedHead) {
        await durableWriteFile(join(recoveryPath, "old-head"), `${oldHead}\n`);
        await exec("git", ["update-ref", "HEAD", fetchedHead, oldHead], { cwd: root });
        await exec("git", ["read-tree", "--reset", fetchedHead], { cwd: root });
      }
    }
    await restoreTransferredSubmodules(root, bundle, false);
    await applyGitPatches(root, bundle);
    await applyWorkspaceDeletions(root, bundle.manifest.git.deleted);
    await writeBundleFiles(root, bundle);
    const appliedFingerprint = await currentWorkspaceFingerprint(root, [
      ...bundle.manifest.excludedPaths.map((entry) => entry.path),
      ...bundle.manifest.exclusionRules,
    ]);
    await durableWriteFile(join(recoveryPath, "applied-fingerprint"), `${appliedFingerprint}\n`);
    return { kind: "applied", recoveryPath };
  } catch (error) {
    await rollbackWorkspaceTransfer(root, recoveryPath).catch(() => undefined);
    throw error;
  }
}

async function applyDivergedWorkspace(
  root: string,
  bundle: WorkspaceTransferBundleV1,
  fetchedHead: string | null,
  onPrepared?: (result: WorkspaceApplyResult) => Promise<void>,
): Promise<WorkspaceApplyResult> {
  const worktreePath = join(homedir(), ".vibe", "worktrees", bundle.manifest.workspaceId, String(bundle.manifest.ownershipGeneration));
  await onPrepared?.({ kind: "diverged", worktreePath });
  await mkdir(dirname(worktreePath), { recursive: true });
  await rm(worktreePath, { recursive: true, force: true });
  try {
    if (bundle.manifest.git.isRepository && bundle.manifest.git.head) {
      await exec("git", ["worktree", "add", "--detach", worktreePath, fetchedHead ?? bundle.manifest.git.head], { cwd: root });
    } else {
      await mkdir(worktreePath, { recursive: true });
    }
    await restoreTransferredSubmodules(worktreePath, bundle, true);
    await applyGitPatches(worktreePath, bundle);
    await applyWorkspaceDeletions(worktreePath, bundle.manifest.git.deleted);
    await writeBundleFiles(worktreePath, bundle);
    return { kind: "diverged", worktreePath };
  } catch (error) {
    if (bundle.manifest.git.isRepository) {
      await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: root }).catch(() => undefined);
      await exec("git", ["worktree", "prune"], { cwd: root }).catch(() => undefined);
    }
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function returnTouchesProtectedLocalPath(
  root: string,
  bundle: WorkspaceTransferBundleV1,
  additionalExclusions: readonly string[],
): Promise<boolean> {
  const affected = new Set([
    ...bundle.manifest.entries.map((entry) => toPortablePath(entry.path)),
    ...bundle.manifest.git.deleted.map(toPortablePath),
  ]);
  const excluded = bundle.manifest.excludedPaths.map((entry) => toPortablePath(entry.path));
  for (const path of affected) {
    if (excluded.some((protectedPath) =>
      path === protectedPath || path.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${path}/`))) return true;
    try {
      await exec("git", ["check-ignore", "-q", "--", path], { cwd: root });
      return true;
    } catch { /* not ignored or not a Git repository */ }
    try {
      const info = await lstat(safeJoin(root, path));
      if (info.isFile() && info.size > MAX_FILE_BYTES) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  try {
    await assertNoProtectedDescendants(root, affected, additionalExclusions);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cloud return would replace a directory containing protected local data:")) return true;
    throw error;
  }
  return false;
}

export async function rollbackWorkspaceTransfer(cwd: string, recoveryPath: string): Promise<string | undefined> {
  const root = resolve(cwd);
  const manifest = JSON.parse(await readFile(join(recoveryPath, "manifest.json"), "utf8")) as WorkspaceTransferManifestV1;
  const affected = new Set([...manifest.entries.map((entry) => toPortablePath(entry.path)), ...manifest.git.deleted.map(toPortablePath)]);
  let preservedPath: string | undefined;
  try {
    const expected = (await readFile(join(recoveryPath, "applied-fingerprint"), "utf8")).trim();
    const current = await currentWorkspaceFingerprint(root, [
      ...manifest.excludedPaths.map((entry) => entry.path),
      ...manifest.exclusionRules,
    ]);
    if (!expected || current !== expected) preservedPath = await preserveAffectedWorkspace(root, manifest, affected);
  } catch {
    // A crash before the final applied fingerprint is intentionally treated as
    // divergence: preserve the current affected state before restoring backup.
    preservedPath = await preserveAffectedWorkspace(root, manifest, affected);
  }
  try {
    const oldHead = (await readFile(join(recoveryPath, "old-head"), "utf8")).trim();
    if (oldHead) {
      await exec("git", ["update-ref", "HEAD", oldHead], { cwd: root });
      await exec("git", ["read-tree", "--reset", oldHead], { cwd: root });
    }
  } catch { /* no git head move */ }
  try {
    const submodules = JSON.parse(await readFile(join(recoveryPath, "submodules.json"), "utf8")) as Array<{ path: string; head: string }>;
    for (const submodule of submodules) {
      await exec("git", ["checkout", "--detach", submodule.head], { cwd: safeJoin(root, submodule.path) });
    }
  } catch { /* no submodule head changes */ }
  for (const path of [...affected].sort()) {
    await assertNoSymlinkParents(root, path);
    await removeWorkspacePath(root, path);
  }
  await restoreRecovery(root, join(recoveryPath, "files"));
  try {
    const oldIndexTree = (await readFile(join(recoveryPath, "old-index-tree"), "utf8")).trim();
    if (oldIndexTree) await exec("git", ["read-tree", oldIndexTree], { cwd: root });
  } catch { /* non-git recovery */ }
  return preservedPath;
}

export async function rollbackWorkspaceApplication(cwd: string, applied: WorkspaceApplyResult): Promise<string | undefined> {
  if (applied.kind === "applied") {
    return rollbackWorkspaceTransfer(cwd, applied.recoveryPath);
  }
  try {
    await exec("git", ["worktree", "remove", "--force", applied.worktreePath], { cwd: resolve(cwd) });
  } catch {
    await rm(applied.worktreePath, { recursive: true, force: true });
  }
  return undefined;
}

async function preserveAffectedWorkspace(
  root: string,
  manifest: WorkspaceTransferManifestV1,
  affected: ReadonlySet<string>,
): Promise<string> {
  const reviewPath = join(
    homedir(),
    ".vibe",
    "worktrees",
    manifest.workspaceId,
    `recovery-${manifest.ownershipGeneration}-${Date.now()}-${randomUUID()}`,
  );
  await mkdir(dirname(reviewPath), { recursive: true });
  const localGit = await gitMetadata(root);
  if (localGit.isRepository && localGit.head) {
    await exec("git", ["worktree", "add", "--detach", reviewPath, localGit.head], { cwd: root });
  } else {
    await mkdir(reviewPath, { recursive: true });
  }
  for (const path of minimalAffectedRoots(affected)) {
    const source = safeJoin(root, path);
    const destination = safeJoin(reviewPath, path);
    await rm(destination, { recursive: true, force: true });
    try {
      const info = await lstat(source);
      await mkdir(dirname(destination), { recursive: true });
      if (info.isSymbolicLink()) await symlink(await readlink(source), destination);
      else if (info.isDirectory()) await cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      else if (info.isFile()) await cp(source, destination, { preserveTimestamps: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  await writeFile(
    join(reviewPath, "VIBE-RECOVERY.md"),
    "This review workspace preserves local state detected after an interrupted cloud return. Compare it before deleting.\n",
  );
  return reviewPath;
}

async function pruneRecoveryArchives(root: string): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  let names: string[];
  try { names = await readdir(root); } catch { return; }
  await Promise.all(names.map(async (name) => {
    const path = join(root, name);
    try { if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }));
}

async function applyGitPatches(root: string, bundle: WorkspaceTransferBundleV1): Promise<void> {
  if (!bundle.manifest.git.isRepository) return;
  const specs = [
    [bundle.manifest.git.stagedPatchPath, ["apply", "--index", "--binary"]],
    [bundle.manifest.git.worktreePatchPath, ["apply", "--binary"]],
  ] as const;
  const temp = await mkdtemp(join(tmpdir(), "vibe-git-patches-"));
  try {
    for (const [path, args] of specs) {
      if (!path) continue;
      const item = bundle.files.find((file) => file.path === path);
      if (!item) throw new Error(`Transferred Git patch is missing: ${path}`);
      const patch = join(temp, basename(path));
      await writeFile(patch, Buffer.from(item.contentBase64, "base64"));
      await exec("git", [...args, patch], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function fetchTransferredGit(
  root: string,
  bundle: WorkspaceTransferBundleV1,
  additionalExclusions: readonly string[],
): Promise<string | null> {
  const head = bundle.manifest.git.head;
  const path = bundle.manifest.git.bundlePath;
  if (!bundle.manifest.git.isRepository || !head || !path) return null;
  const item = bundle.files.find((file) => file.path === path);
  if (!item) throw new Error("Transferred Git bundle is missing");
  const temp = await mkdtemp(join(tmpdir(), "vibe-return-git-"));
  try {
    const file = join(temp, "repository.bundle");
    await writeFile(file, Buffer.from(item.contentBase64, "base64"));
    await exec("git", ["bundle", "verify", file], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const inspection = join(temp, "inspection.git");
    await exec("git", ["clone", "--bare", file, inspection], { maxBuffer: 16 * 1024 * 1024 });
    const history = await gitRaw(inspection, ["log", "--all", "--pretty=format:", "--name-only", "-z"]);
    const patterns = additionalExclusions.map(globRegex);
    for (const raw of history.split("\0")) {
      const value = raw.replace(/^\n+|\n+$/g, "");
      if (!value) continue;
      const candidate = toPortablePath(value);
      if (HARD_EXCLUDES.some((pattern) => pattern.test(candidate)) || patterns.some((pattern) => pattern.test(candidate))) {
        throw new Error(`Returned Git history contains an excluded path: ${candidate}`);
      }
    }
    await exec("git", ["-c", "fetch.recurseSubmodules=false", "fetch", file, head], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return head;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function validateTransferredSubmoduleBundles(
  bundle: WorkspaceTransferBundleV1,
  additionalExclusions: readonly string[],
): Promise<void> {
  const patterns = additionalExclusions.map(globRegex);
  for (const submodule of bundle.manifest.git.submodules) {
    if (!submodule.bundlePath || !submodule.head) continue;
    const item = bundle.files.find((file) => file.path === submodule.bundlePath);
    if (!item) throw new Error(`Transferred submodule bundle is missing: ${submodule.path}`);
    const temp = await mkdtemp(join(tmpdir(), "vibe-return-submodule-"));
    try {
      const file = join(temp, "repository.bundle");
      const inspection = join(temp, "inspection.git");
      await writeFile(file, Buffer.from(item.contentBase64, "base64"));
      await exec("git", ["clone", "--bare", file, inspection], { maxBuffer: 16 * 1024 * 1024 });
      await exec("git", ["cat-file", "-e", `${submodule.head}^{commit}`], { cwd: inspection });
      const history = await gitRaw(inspection, ["log", "--all", "--pretty=format:", "--name-only", "-z"]);
      for (const raw of history.split("\0")) {
        const value = raw.replace(/^\n+|\n+$/g, "");
        if (!value) continue;
        const nested = toPortablePath(value);
        const workspacePath = posix.join(submodule.path, nested);
        if (HARD_EXCLUDES.some((pattern) => pattern.test(workspacePath)) || patterns.some((pattern) => pattern.test(workspacePath))) {
          throw new Error(`Returned submodule history contains an excluded path: ${workspacePath}`);
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

async function hasMissingSubmoduleRepository(root: string, bundle: WorkspaceTransferBundleV1): Promise<boolean> {
  for (const submodule of bundle.manifest.git.submodules) {
    try { await gitText(safeJoin(root, submodule.path), ["rev-parse", "--git-dir"]); }
    catch { return true; }
  }
  return false;
}

async function restoreTransferredSubmodules(
  root: string,
  bundle: WorkspaceTransferBundleV1,
  cloneMissing: boolean,
): Promise<void> {
  for (const submodule of [...bundle.manifest.git.submodules].sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    return depth || a.path.localeCompare(b.path);
  })) {
    if (!submodule.bundlePath || !submodule.head) continue;
    const item = bundle.files.find((file) => file.path === submodule.bundlePath);
    if (!item) throw new Error(`Transferred submodule bundle is missing: ${submodule.path}`);
    const temp = await mkdtemp(join(tmpdir(), "vibe-apply-submodule-"));
    try {
      const file = join(temp, "repository.bundle");
      const out = safeJoin(root, submodule.path);
      // Include the leaf itself: a checked-out Git tree can replace a
      // submodule path with a symlink after archive verification.
      await assertNoSymlinkParents(root, `${submodule.path}/.vibe-submodule-boundary`);
      await writeFile(file, Buffer.from(item.contentBase64, "base64"));
      if (cloneMissing) {
        await rm(out, { recursive: true, force: true });
        await mkdir(dirname(out), { recursive: true });
        await exec("git", ["clone", file, out], { maxBuffer: 16 * 1024 * 1024 });
      } else {
        await exec("git", ["-c", "fetch.recurseSubmodules=false", "fetch", file, submodule.head], { cwd: out, maxBuffer: 16 * 1024 * 1024 });
      }
      await exec("git", ["checkout", "--detach", submodule.head], { cwd: out, maxBuffer: 16 * 1024 * 1024 });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

async function writeBundleFiles(root: string, bundle: WorkspaceTransferBundleV1): Promise<void> {
  const content = new Map(bundle.files.filter((file) => file.path.startsWith("workspace/")).map((file) => [file.path.slice(10), file.contentBase64]));
  for (const entry of bundle.manifest.entries) {
    const out = safeJoin(root, entry.path);
    await assertNoSymlinkParents(root, entry.path);
    await rm(out, { recursive: true, force: true });
    await mkdir(dirname(out), { recursive: true });
    if (entry.type === "symlink") await symlink(entry.linkTarget!, out);
    else {
      const encoded = content.get(entry.path);
      if (!encoded) throw new Error(`Workspace content missing: ${entry.path}`);
      await writeFile(out, Buffer.from(encoded, "base64"), { mode: entry.mode });
      await chmod(out, entry.mode);
    }
  }
}

async function applyWorkspaceDeletions(root: string, deleted: readonly string[]): Promise<void> {
  const ordered = [...deleted].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
  for (const path of ordered) await removeWorkspacePath(root, path);
}

async function removeWorkspacePath(root: string, path: string): Promise<void> {
  await assertNoSymlinkParents(root, path);
  try { await rm(safeJoin(root, path), { recursive: true, force: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
}

async function restoreRecovery(root: string, recovery: string, prefix = ""): Promise<void> {
  let entries: Dirent[];
  try { entries = await readdir(join(recovery, prefix), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      const source = join(recovery, ...rel.split("/"));
      const out = safeJoin(root, rel);
      const sourceStat = await lstat(source);
      await mkdir(out, { recursive: true, mode: sourceStat.mode & 0o777 });
      await restoreRecovery(root, recovery, rel);
      await chmod(out, sourceStat.mode & 0o777);
    }
    else {
      const source = join(recovery, ...rel.split("/"));
      const out = safeJoin(root, rel);
      await mkdir(dirname(out), { recursive: true });
      if (entry.isSymbolicLink()) await symlink(await readlink(source), out);
      else {
        const sourceStat = await lstat(source);
        await writeFile(out, await readFile(source), { mode: sourceStat.mode & 0o777 });
        await chmod(out, sourceStat.mode & 0o777);
      }
    }
  }
}

async function gitMetadata(cwd: string): Promise<WorkspaceTransferManifestV1["git"]> {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    const head = await gitText(cwd, ["rev-parse", "HEAD"]);
    const branch = await gitText(cwd, ["branch", "--show-current"]);
    let indexHash: string;
    try { indexHash = await gitText(cwd, ["write-tree"]); }
    catch { indexHash = hash(await gitRaw(cwd, ["diff", "--cached", "--binary", "--full-index"])); }
    const deleted = splitNul(await gitRaw(cwd, ["ls-files", "--deleted", "-z"]));
    const submodules: WorkspaceTransferManifestV1["git"]["submodules"] = [];
    try {
      const output = await gitRaw(cwd, ["submodule", "status", "--recursive"]);
      for (const line of output.split("\n")) {
        const match = line.match(/^[ +-U]?([0-9a-f]{40,64})\s+([^\s]+)(?:\s|$)/);
        if (match?.[2]) submodules.push({ path: toPortablePath(match[2]), head: match[1] ?? null });
      }
    } catch { /* none */ }
    return { isRepository: true, head: head || null, branch: branch || null, indexHash, deleted, submodules };
  } catch {
    return { isRepository: false, head: null, branch: null, deleted: [], submodules: [], syntheticBase: hash(cwd) };
  }
}

async function walkCandidates(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = posix.join(prefix, entry.name);
    if (HARD_EXCLUDES.some((pattern) => pattern.test(rel))) { out.push(rel); continue; }
    if (entry.isDirectory()) out.push(...await walkCandidates(root, rel));
    else out.push(rel);
  }
  return out;
}

async function readCloudignore(cwd: string): Promise<string[]> {
  const path = join(cwd, ".vibe", "cloudignore");
  try {
    return (await readFile(path, "utf8"))
      .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // readFile also returns ENOENT for a broken symlink. Only an actually
    // absent policy file means there are no workspace-specific exclusions.
    try { await lstat(path); }
    catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw statError;
    }
    throw error;
  }
}

function minimalAffectedRoots(affected: ReadonlySet<string>): string[] {
  const paths = [...affected].map(toPortablePath).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const roots: string[] = [];
  for (const path of paths) {
    if (!roots.some((root) => path.startsWith(`${root}/`))) roots.push(path);
  }
  return roots;
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/^\//, "");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^(?:${escaped})(?:/.*)?$`);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean).map(toPortablePath);
}

function toPortablePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path === "." || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("\0") || posix.normalize(path) !== path) throw new Error(`Unsafe workspace path: ${value}`);
  return path;
}

function safeJoin(root: string, portablePath: string): string {
  const out = resolve(root, ...toPortablePath(portablePath).split("/"));
  if (out === resolve(root) || !out.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Workspace path escaped root: ${portablePath}`);
  return out;
}

function assertContainedLink(path: string, target: string | undefined): void {
  if (!target || isAbsolute(target) || target.includes("\0") || target.includes("\\")) throw new Error(`Unsafe workspace symlink: ${path}`);
  const base = "/workspace";
  const resolved = posix.resolve(base, posix.dirname(path), target);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) throw new Error(`Workspace symlink escaped root: ${path}`);
}

async function assertNoSymlinkParents(root: string, portablePath: string): Promise<void> {
  const parts = toPortablePath(portablePath).split("/");
  let current = resolve(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Workspace path crosses a symlink: ${portablePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertNoProtectedDescendants(
  root: string,
  affected: ReadonlySet<string>,
  exclusionRules: readonly string[],
): Promise<void> {
  const patterns = exclusionRules.map(globRegex);
  for (const path of affected) {
    const absolute = safeJoin(root, path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(absolute); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A cloud file may replace a local directory (or vice versa). In that
      // case an affected descendant can legitimately cross a non-directory
      // ancestor and lstat reports ENOTDIR rather than ENOENT.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (!info.isDirectory()) continue;
    for (const descendant of await walkAllCandidates(absolute)) {
      const workspacePath = posix.join(path, descendant);
      const configured = HARD_EXCLUDES.some((pattern) => pattern.test(workspacePath))
        || patterns.some((pattern) => pattern.test(workspacePath));
      let ignored = false;
      if (!configured) {
        try {
          await exec("git", ["check-ignore", "-q", "--", workspacePath], { cwd: root });
          ignored = true;
        } catch { /* not ignored or not a Git repository */ }
      }
      if (configured || ignored) {
        throw new Error(`Cloud return would replace a directory containing protected local data: ${workspacePath}`);
      }
    }
  }
}

async function walkAllCandidates(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...await walkAllCandidates(root, path));
    else out.push(path);
  }
  return out;
}

function fingerprint(head: string | null, branch: string | null, indexHash: string | undefined, deleted: string[], entries: WorkspaceFileEntryV1[]): string {
  return hash(`${head ?? "synthetic"}\n${branch ?? "detached"}\n${indexHash ?? "no-index"}\n${deleted.slice().sort().join("\n")}\n${entries.map((entry) => `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.sha256}`).join("\n")}`);
}

function canonicalTransfer(manifest: Omit<WorkspaceTransferManifestV1, "archiveSha256">, files: WorkspaceTransferBundleV1["files"], engine: PortableSessionArchiveV1): string {
  return JSON.stringify({ manifest, files: files.map((file) => [file.path, hash(Buffer.from(file.contentBase64, "base64"))]), engine: engine.archiveSha256 });
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodedBase64Bytes(value: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid base64 transfer content");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

async function durableWriteFile(path: string, content: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
