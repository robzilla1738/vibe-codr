import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./index.ts";

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
});

test("`sessions` on a fresh dir reports none and exits 0", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  const { code, out } = await capture(["sessions", "--cwd", cwd]);
  expect(code).toBe(0);
  expect(out).toContain("No saved sessions");
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
