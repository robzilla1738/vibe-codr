import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCliModeOverride, run } from "./index.ts";

// Capture stdout/stderr around a run() call so we can assert on the CLI's
// actual user-facing output and exit code — exercising real arg parsing,
// config loading, and command dispatch (no model/provider key needed).
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
  const code = await run(argv);
  restore();
  restore = null;
  return { code, out, err };
}

test("--version prints the version and exits 0", async () => {
  const { code, out } = await capture(["--version"]);
  expect(code).toBe(0);
  expect(out).toContain("vibe-codr");
});

test("--help prints usage and exits 0", async () => {
  const { code, out } = await capture(["--help"]);
  expect(code).toBe(0);
  expect(out).toContain("USAGE");
  expect(out).toContain("--prompt");
  expect(out).toContain("plan | execute | yolo");
});

test("`sessions` on a fresh dir reports none and exits 0", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  const { code, out } = await capture(["sessions", "--cwd", cwd]);
  expect(code).toBe(0);
  expect(out).toContain("No saved sessions");
});

test("--mode yolo is accepted as the third user-facing mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  const { code, out, err } = await capture(["sessions", "--cwd", cwd, "--mode", "yolo"]);
  expect(code).toBe(0);
  expect(out).toContain("No saved sessions");
  expect(err).toBe("");
});

test("CLI --mode maps the 3 user-facing labels to exact engine approval state", () => {
  const plan = { approvalMode: "auto" as const };
  expect(applyCliModeOverride(plan, "plan")).toBe(true);
  expect(plan).toMatchObject({ mode: "plan", approvalMode: "ask" });

  const execute = { approvalMode: "auto" as const };
  expect(applyCliModeOverride(execute, "execute")).toBe(true);
  expect(execute).toMatchObject({ mode: "execute", approvalMode: "ask" });

  const yolo = { approvalMode: "ask" as const };
  expect(applyCliModeOverride(yolo, "yolo")).toBe(true);
  expect(yolo).toMatchObject({ mode: "execute", approvalMode: "auto" });

  const invalid = {};
  expect(applyCliModeOverride(invalid, "plann")).toBe(false);
  expect(invalid).toEqual({});
});

test("--mode rejects typos with every accepted value named", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  const { code, err } = await capture(["sessions", "--cwd", cwd, "--mode", "plann"]);
  expect(code).toBe(1);
  expect(err).toContain('expected "plan", "execute", or "yolo"');
});

test("a headless prompt with no provider key fails cleanly with exit 1", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { code, err } = await capture([
      "-p",
      "hello",
      "-m",
      "anthropic/claude-opus-4-8",
      "--cwd",
      cwd,
    ]);
    expect(code).toBe(1); // non-zero so scripts/CI see the failure
    expect(err).toContain("anthropic"); // actionable "not configured" message
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("resolveEngineWorkerPath finds Windows .exe sibling (BUG-106)", async () => {
  const { resolveEngineWorkerPath } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "vibe-worker-exe-"));
  const exe = join(dir, "vibecodr.exe");
  const worker = join(dir, "vibecodr-engine-worker.exe");
  await Bun.write(exe, "fake");
  await Bun.write(worker, "fake-worker");
  const found = resolveEngineWorkerPath({ execPath: exe, moduleDir: join(dir, "no-npm") });
  expect(found).toBe(worker);
});
