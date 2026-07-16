import { describe, expect, it } from "vitest";
import {
  buildPushArgs,
  checkoutBranch,
  commit,
  createBranch,
  deleteBranch,
  getFullStatus,
  getWorkingTreeFileDiff,
  isGitRepo,
  listBranches,
  mergeBranch,
  pushBranch,
  redactRemoteUrl,
  runGit,
  stageFiles,
  unstageFiles,
} from "./git-ops";

// These tests use a real git repo in a temp directory to verify the spawn
// and parsing logic. They are integration-style but fast (git is quick on
// small repos). Skip if git is not installed.

const hasGit = await (async () => {
  try {
    const res = await runGit("/", ["--version"]);
    return res.ok;
  } catch {
    return false;
  }
})();

const itGit = hasGit ? it : it.skip;

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-git-test-"));
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "test@test.com"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "README.md"), "# Test\n");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-q", "-m", "initial commit"]);
  return dir;
}

describe("git-ops", () => {
  describe("remote URL presentation", () => {
    it("removes embedded credentials and redacts secret query values", () => {
      expect(
        redactRemoteUrl(
          "https://oauth-user:super-secret@example.com/acme/repo.git?access_token=abc&sig=xyz&view=compact#fragment",
        ),
      ).toBe(
        "https://example.com/acme/repo.git?access_token=%5Bredacted%5D&sig=%5Bredacted%5D&view=compact",
      );
    });

    it("keeps public SSH and HTTPS remotes readable", () => {
      expect(redactRemoteUrl("git@github.com:acme/repo.git")).toBe(
        "git@github.com:acme/repo.git",
      );
      expect(redactRemoteUrl("https://github.com/acme/repo.git")).toBe(
        "https://github.com/acme/repo.git",
      );
    });

    it("redacts credentials for every URL-style Git transport", () => {
      expect(
        redactRemoteUrl("ssh://git:secret@example.com/acme/repo.git?token=abc"),
      ).toBe("ssh://example.com/acme/repo.git?token=%5Bredacted%5D");
      expect(
        redactRemoteUrl("ftp://user:secret@example.com/acme/repo.git?signature=abc"),
      ).toBe("ftp://example.com/acme/repo.git?signature=%5Bredacted%5D");
    });
  });

  describe("runGit", () => {
    itGit("returns ok for --version", async () => {
      const res = await runGit("/", ["--version"]);
      expect(res.ok).toBe(true);
      expect(res.stdout).toContain("git version");
    });

    itGit("returns not ok for invalid args", async () => {
      const res = await runGit("/", ["not-a-command"]);
      expect(res.ok).toBe(false);
    });
  });

  describe("isGitRepo", () => {
    itGit("returns true inside a git repo", async () => {
      const dir = await makeRepo();
      try {
        expect(await isGitRepo(dir)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("returns false outside a git repo", async () => {
      const dir = await mkdtemp(join(tmpdir(), "vibe-non-git-"));
      try {
        expect(await isGitRepo(dir)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("getWorkingTreeFileDiff", () => {
    itGit("returns real tracked and untracked diffs from a nested repository", async () => {
      const parent = await mkdtemp(join(tmpdir(), "vibe-nested-git-test-"));
      const repo = join(parent, "generated-app");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(repo);
      await runGit(repo, ["init", "-q", "-b", "main"]);
      await runGit(repo, ["config", "user.email", "test@test.com"]);
      await runGit(repo, ["config", "user.name", "Test User"]);
      await writeFile(join(repo, "tracked.ts"), "export const value = 1;\n");
      await runGit(repo, ["add", "-A"]);
      await runGit(repo, ["commit", "-q", "-m", "initial"]);
      try {
        await writeFile(join(repo, "tracked.ts"), "export const value = 2;\n");
        await writeFile(join(repo, "new.ts"), "export const added = true;\n");

        const tracked = await getWorkingTreeFileDiff(join(repo, "tracked.ts"));
        expect(tracked.ok, tracked.ok ? "" : tracked.error).toBe(true);
        expect(tracked).toMatchObject({ ok: true, available: true, added: 1, removed: 1 });
        if (tracked.ok && tracked.available) {
          expect(tracked.diff).toContain("-export const value = 1;");
          expect(tracked.diff).toContain("+export const value = 2;");
        }

        const untracked = await getWorkingTreeFileDiff(join(repo, "new.ts"));
        expect(untracked).toMatchObject({ ok: true, available: true, added: 1, removed: 0 });
        if (untracked.ok && untracked.available) {
          expect(untracked.diff).toContain("+export const added = true;");
        }
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    itGit("accepts a no-index diff that also emits a benign Git warning", async () => {
      const repo = await makeRepo();
      const target = join(repo, "warning.txt");
      const { writeFile } = await import("node:fs/promises");
      try {
        await runGit(repo, ["config", "core.autocrlf", "true"]);
        await runGit(repo, ["config", "core.safecrlf", "warn"]);
        await writeFile(target, "line one\nline two\n");
        const result = await getWorkingTreeFileDiff(target);
        expect(result.ok, result.ok ? "" : result.error).toBe(true);
        if (result.ok && result.available) expect(result.diff).toContain("+line one");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    itGit("rejects a no-index diff when captured output is truncated", async () => {
      const repo = await makeRepo();
      const target = join(repo, "oversized.txt");
      const { writeFile } = await import("node:fs/promises");
      try {
        await writeFile(target, `${"x".repeat(10 * 1024 * 1024)}\n`);
        const result = await getWorkingTreeFileDiff(target);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("exceeded");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    itGit("returns a tracked deletion diff after the containing directory is removed", async () => {
      const repo = await makeRepo();
      const { mkdir, writeFile } = await import("node:fs/promises");
      const nested = join(repo, "removed", "nested");
      const target = join(nested, "gone.ts");
      try {
        await mkdir(nested, { recursive: true });
        await writeFile(target, "export const gone = true;\n");
        await runGit(repo, ["add", "-A"]);
        await runGit(repo, ["commit", "-q", "-m", "add nested file"]);
        await rm(join(repo, "removed"), { recursive: true, force: true });

        const deleted = await getWorkingTreeFileDiff(target);
        expect(deleted).toMatchObject({ ok: true, available: true, added: 0, removed: 1 });
        if (deleted.ok && deleted.available) {
          expect(deleted.diff).toContain("-export const gone = true;");
        }
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  });

  describe("getFullStatus", () => {
    itGit("returns null outside a repo", async () => {
      const dir = await mkdtemp(join(tmpdir(), "vibe-non-git-"));
      try {
        expect(await getFullStatus(dir)).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("returns status for a clean repo", async () => {
      const dir = await makeRepo();
      try {
        const status = await getFullStatus(dir);
        expect(status).not.toBeNull();
        expect(status!.branch).toBe("main");
        expect(status!.clean).toBe(true);
        expect(status!.entries).toHaveLength(0);
        expect(status!.branches.length).toBeGreaterThan(0);
        expect(status!.recentCommits.length).toBeGreaterThan(0);
        expect(status!.recentCommits[0]!.subject).toBe("initial commit");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("detects untracked files", async () => {
      const dir = await makeRepo();
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "new-file.ts"), "export const x = 1;\n");
        const status = await getFullStatus(dir);
        expect(status).not.toBeNull();
        expect(status!.clean).toBe(false);
        expect(status!.untrackedCount).toBe(1);
        expect(status!.entries[0]!.path).toBe("new-file.ts");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("detects modified files", async () => {
      const dir = await makeRepo();
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "README.md"), "# Modified\n");
        const status = await getFullStatus(dir);
        expect(status).not.toBeNull();
        expect(status!.clean).toBe(false);
        expect(status!.unstagedCount).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("listBranches", () => {
    itGit("lists local branches", async () => {
      const dir = await makeRepo();
      try {
        await runGit(dir, ["branch", "feature/test"]);
        const branches = await listBranches(dir);
        const localBranches = branches.filter((b) => !b.remote);
        expect(localBranches.length).toBe(2);
        expect(localBranches.some((b) => b.name === "main")).toBe(true);
        expect(localBranches.some((b) => b.name === "feature/test")).toBe(true);
        const mainBranch = localBranches.find((b) => b.name === "main");
        expect(mainBranch?.current).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("branch create/checkout/delete/merge (real git)", () => {
    itGit("createBranch with checkout creates and switches to the named branch", async () => {
      const dir = await makeRepo();
      try {
        const res = await createBranch(dir, "feature/login", undefined, true);
        expect(res.ok, res.stderr).toBe(true);
        const status = await getFullStatus(dir);
        expect(status!.branch).toBe("feature/login");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("createBranch without checkout leaves HEAD on main", async () => {
      const dir = await makeRepo();
      try {
        const res = await createBranch(dir, "feature/hold");
        expect(res.ok, res.stderr).toBe(true);
        const status = await getFullStatus(dir);
        expect(status!.branch).toBe("main");
        expect(status!.branches.some((b) => b.name === "feature/hold" && !b.remote)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("checkoutBranch switches to an existing branch", async () => {
      const dir = await makeRepo();
      try {
        expect((await createBranch(dir, "feature/switch")).ok).toBe(true);
        const res = await checkoutBranch(dir, "feature/switch");
        expect(res.ok, res.stderr).toBe(true);
        expect((await getFullStatus(dir))!.branch).toBe("feature/switch");
        expect((await checkoutBranch(dir, "main")).ok).toBe(true);
        expect((await getFullStatus(dir))!.branch).toBe("main");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("deleteBranch removes a non-current branch", async () => {
      const dir = await makeRepo();
      try {
        expect((await createBranch(dir, "feature/gone")).ok).toBe(true);
        const res = await deleteBranch(dir, "feature/gone");
        expect(res.ok, res.stderr).toBe(true);
        const branches = await listBranches(dir);
        expect(branches.some((b) => b.name === "feature/gone")).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("mergeBranch merges a feature branch into main", async () => {
      const dir = await makeRepo();
      try {
        const { writeFile } = await import("node:fs/promises");
        expect((await createBranch(dir, "feature/merge", undefined, true)).ok).toBe(true);
        await writeFile(join(dir, "extra.ts"), "export const y = 2;\n");
        expect((await stageFiles(dir, ["extra.ts"])).ok).toBe(true);
        expect((await commit(dir, "add extra", {})).ok).toBe(true);
        expect((await checkoutBranch(dir, "main")).ok).toBe(true);
        const res = await mergeBranch(dir, "feature/merge");
        expect(res.ok, res.stderr).toBe(true);
        const status = await getFullStatus(dir);
        expect(status!.branch).toBe("main");
        expect(status!.clean).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("buildPushArgs force uses --force-with-lease (not bare --force)", () => {
      // Pure argv assertion — would fail if force:true ever emitted bare --force.
      const lease = buildPushArgs({ force: true });
      expect(lease).toContain("--force-with-lease");
      expect(lease).not.toContain("--force");
      expect(lease).toEqual(["push", "--force-with-lease", "origin"]);

      const unsafe = buildPushArgs({ forceUnsafe: true, remote: "origin", branch: "main" });
      expect(unsafe).toContain("--force");
      expect(unsafe).not.toContain("--force-with-lease");
      expect(unsafe).toEqual(["push", "--force", "origin", "main"]);

      const normal = buildPushArgs({ setUpstream: true, branch: "feature/x" });
      expect(normal).toEqual(["push", "-u", "origin", "feature/x"]);
      expect(normal).not.toContain("--force");
      expect(normal).not.toContain("--force-with-lease");
    });

    itGit("pushBranch force path still reaches git (integration)", async () => {
      const dir = await makeRepo();
      try {
        await runGit(dir, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
        // buildPushArgs already asserts argv; this proves pushBranch wires it to runGit.
        const res = await pushBranch(dir, { force: true });
        expect(res.stderr).not.toMatch(/must not start with/);
        expect(res.ok).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("rejects option-like branch names before git runs", async () => {
      const dir = await makeRepo();
      try {
        const bad = await createBranch(dir, "--output=/tmp/x", undefined, true);
        expect(bad.ok).toBe(false);
        expect(bad.stderr).toMatch(/must not start with/);
        expect((await getFullStatus(dir))!.branch).toBe("main");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("stageFiles / unstageFiles", () => {
    itGit("stages and unstages a single path", async () => {
      const dir = await makeRepo();
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "README.md"), "# staged-path\n");
        const staged = await stageFiles(dir, ["README.md"]);
        expect(staged.ok).toBe(true);
        let status = await getFullStatus(dir);
        expect(status!.stagedCount).toBe(1);
        const unstaged = await unstageFiles(dir, ["README.md"]);
        expect(unstaged.ok).toBe(true);
        status = await getFullStatus(dir);
        expect(status!.stagedCount).toBe(0);
        expect(status!.unstagedCount).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itGit("empty stageFiles does not wipe the index (not unstage-all)", async () => {
      const dir = await makeRepo();
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "README.md"), "# keep-staged\n");
        expect((await stageFiles(dir, ["README.md"])).ok).toBe(true);
        const empty = await stageFiles(dir, []);
        expect(empty.ok).toBe(false);
        expect(empty.stderr).toMatch(/No paths to stage/i);
        const status = await getFullStatus(dir);
        expect(status!.stagedCount).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
