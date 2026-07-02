import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandboxPolicy, wrapCommand, type SandboxNetwork } from "./sandbox.ts";

/**
 * Real end-to-end enforcement against the host's OWN backend (Seatbelt/bwrap).
 * Skipped cleanly wherever no backend is enforceable (win32, or a missing
 * binary), so the suite is green on every platform.
 */
const REAL = resolveSandboxPolicy(
  { mode: "workspace-write", network: "on", writablePaths: [] },
  { cwd: process.cwd() },
);
const created: string[] = [];
afterAll(() => {
  for (const p of created) rmSync(p, { force: true, recursive: true });
});

/** Spawn an argv, kill after a grace window (defense against a hang), return the exit code. */
async function run(argv: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  }, 8000);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

function freshCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-sbx-cwd-"));
  created.push(dir);
  return dir;
}

describe.skipIf(!REAL.available)(`OS sandbox integration (${REAL.backend})`, () => {
  test("workspace-write BLOCKS a write outside the writable roots", async () => {
    const cwd = freshCwd();
    // No stateDirs → writable roots are just cwd + tmp; $HOME is NOT writable.
    const policy = resolveSandboxPolicy(
      { mode: "workspace-write", network: "on", writablePaths: [] },
      { cwd },
    );
    const target = join(homedir(), `vibe-sbx-outside-${process.pid}-${Date.now()}`);
    created.push(target);
    const argv = wrapCommand(policy, { cwd, command: `printf x > '${target}'` });
    const code = await run(argv, cwd);
    expect(code).not.toBe(0); // the OS denied the write
    expect(existsSync(target)).toBe(false); // and nothing landed on disk
  });

  test("workspace-write ALLOWS a write inside cwd (sanity — the sandbox isn't a brick)", async () => {
    const cwd = freshCwd();
    const policy = resolveSandboxPolicy(
      { mode: "workspace-write", network: "on", writablePaths: [] },
      { cwd },
    );
    const argv = wrapCommand(policy, { cwd, command: "printf ok > inside.txt" });
    const code = await run(argv, cwd);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "inside.txt"))).toBe(true);
  });

  test('network:"off" blocks an outbound TCP connect', async () => {
    const cwd = freshCwd();
    const policy = resolveSandboxPolicy(
      { mode: "workspace-write", network: "off" as SandboxNetwork, writablePaths: [] },
      { cwd },
    );
    // bash /dev/tcp connect; `|| exit 7` makes the redirection failure the exit code.
    const argv = wrapCommand(policy, {
      cwd,
      command: "exec 3<>/dev/tcp/1.1.1.1/80 || exit 7",
    });
    const code = await run(argv, cwd);
    expect(code).not.toBe(0);
  });
});
