import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCrashRecord,
  crashDoctorCheck,
  handleCrash,
  handleFatalSignal,
  recentCrashes,
  redactCrash,
  writeCrashLog,
  registerCrashRunEventTail,
} from "./crash.ts";

test("crash records synchronously include only the newest 256 content-free run events", () => {
  const events = Array.from({ length: 300 }, (_, index) => ({
    schemaVersion: 1,
    runId: "run-1",
    seq: index + 1,
    at: index,
    type: "notice",
    content: { message: `secret-${index}` },
  }));
  const unregister = registerCrashRunEventTail(() => events);
  const record = buildCrashRecord("test", new Error("boom"), {
    version: "1",
    now: new Date(0),
    argv: [],
  });
  unregister();
  expect(record.runEventTail).toHaveLength(256);
  expect((record.runEventTail[0] as { seq: number }).seq).toBe(45);
  expect((record.runEventTail.at(-1) as { seq: number }).seq).toBe(300);
  expect(JSON.stringify(record.runEventTail)).not.toContain("secret-");
});

test("redactCrash masks secret-bearing keys", () => {
  const out = redactCrash({
    apiKey: "sk-123",
    api_key: "sk-456",
    Authorization: "Bearer abc",
    token: "t",
    nested: { secret: "s", ok: "keep" },
    keep: "value",
  }) as Record<string, unknown>;
  expect(out.apiKey).toBe("***");
  expect(out.api_key).toBe("***");
  expect(out.Authorization).toBe("***");
  expect(out.token).toBe("***");
  expect((out.nested as Record<string, unknown>).secret).toBe("***");
  expect((out.nested as Record<string, unknown>).ok).toBe("keep");
  expect(out.keep).toBe("value");
});

test("redactCrash masks secrets embedded in free strings (argv-style)", () => {
  const out = redactCrash([
    "--api-key=sk-live-123",
    "Authorization: Bearer xyz",
    "--model=openai/gpt",
  ]) as string[];
  expect(out[0]).toBe("--api-key=***");
  expect(out[1]).toContain("***");
  expect(out[1]).not.toContain("xyz");
  expect(out[2]).toBe("--model=openai/gpt");
});

test("redactCrash masks bare vendor-prefixed secret tokens with no adjacent keyword", () => {
  // Stack frames / argv can carry an unlabeled key that the keyword rules miss.
  const argv = redactCrash([
    "--model=openai/gpt",
    "sk-ABCDEFGHIJ1234567890KLMNOPqrstuv",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
    "xoxb-1234567890-ABCDEFGHIJKLMNOP",
    "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7",
  ]) as string[];
  expect(argv[0]).toBe("--model=openai/gpt"); // ordinary flag untouched
  expect(argv[1]).toBe("***"); // classic sk- key
  expect(argv[2]).toBe("***"); // github token
  expect(argv[3]).toBe("***"); // segmented anthropic key
  expect(argv[4]).toBe("***"); // slack bot token
  expect(argv[5]).toBe("***"); // google api key
  // A leaked token buried in a stack string is masked, ordinary words + short
  // hex are left intact (no over-masking).
  const stack = redactCrash(
    "at handler (/app.ts:42) build a1b2c3 with scikit-learn ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210",
  ) as string;
  expect(stack).toContain("at handler (/app.ts:42)");
  expect(stack).toContain("a1b2c3");
  expect(stack).toContain("scikit-learn");
  expect(stack).not.toContain("ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210");
  expect(stack).toContain("***");
});

test("writeCrashLog writes a redacted record to <iso>.log and returns its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-crash-"));
  const record = buildCrashRecord("uncaughtException", new Error("boom"), {
    version: "1.2.3",
    now: new Date("2026-07-02T10:11:12.500Z"),
    argv: ["bun", "vibecodr", "--api-key=sk-secret"],
  });
  const path = writeCrashLog(record, dir);
  expect(path.startsWith(dir)).toBe(true);
  expect(path.endsWith(".log")).toBe(true);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  expect(parsed.version).toBe("1.2.3");
  expect(parsed.kind).toBe("uncaughtException");
  expect(parsed.message).toBe("boom");
  expect(parsed.platform).toContain("-");
  // The secret in argv is masked.
  expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  expect(parsed.argv[2]).toBe("--api-key=***");
});

test("handleCrash restores, writes a log, prints the path, and exits 1 — each step guarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-crash-"));
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  handleCrash("unhandledRejection", new Error("kaboom"), {
    version: "9.9.9",
    dir,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    argv: ["bun", "vibecodr"],
    writeStdout: (s) => {
      stdout += s;
    },
    writeStderr: (s) => {
      stderr += s;
    },
    exit: (c) => {
      exitCode = c;
    },
  });
  expect(exitCode).toBe(1);
  // (a) terminal restore emitted the alt-screen-exit + show-cursor sequences.
  expect(stdout).toContain("\x1b[?1049l");
  expect(stdout).toContain("\x1b[?25h");
  // (c) the log path is printed to stderr.
  expect(stderr).toContain("kaboom");
  expect(stderr).toContain(dir);
  // (b) the log file exists on disk.
  const files = recentCrashes(7, dir, Date.parse("2026-01-01T00:00:01.000Z"));
  expect(files.length).toBe(1);
});

test("recentCrashes filters by age and tolerates a missing dir", () => {
  expect(recentCrashes(7, join(tmpdir(), "does-not-exist-vibe"))).toEqual([]);

  const dir = mkdtempSync(join(tmpdir(), "vibe-crash-"));
  const now = Date.parse("2026-07-02T00:00:00.000Z");
  const fresh = join(dir, "fresh.log");
  const old = join(dir, "old.log");
  writeFileSync(fresh, "{}");
  writeFileSync(old, "{}");
  // Make `old` 10 days old.
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
  utimesSync(old, tenDaysAgo, tenDaysAgo);

  const within7 = recentCrashes(7, dir, now);
  expect(within7).toEqual([fresh]);
  const within30 = recentCrashes(30, dir, now);
  expect(within30.length).toBe(2);
});

test("crashDoctorCheck is honest: clean → null, dirty → false", () => {
  expect(crashDoctorCheck([])).toMatchObject({ ok: null, detail: "no recent crashes" });
  const check = crashDoctorCheck(["/a/1.log", "/a/2.log"]);
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("2 crash log(s)");
  expect(check.detail).toContain("2.log");
});

test("handleFatalSignal restores the terminal and exits 143 (SIGTERM) / 129 (SIGHUP)", () => {
  let out = "";
  let code = -1;
  handleFatalSignal("SIGTERM", { writeStdout: (s) => (out += s), exit: (c) => (code = c) });
  // Exits alt-screen + shows the cursor (the literal restore sequence).
  expect(out).toContain("\x1b[?1049l");
  expect(out).toContain("\x1b[?25h");
  expect(code).toBe(143);

  out = "";
  code = -1;
  handleFatalSignal("SIGHUP", { writeStdout: (s) => (out += s), exit: (c) => (code = c) });
  expect(out).toContain("\x1b[?1049l");
  expect(code).toBe(129);
});
