import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import { bashTool } from "./bash.ts";

function ctx(cwd: string, events: UIEvent[] = []): ToolContext {
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    freshness,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}
const cwd = () => mkdtempSync(join(tmpdir(), "vibe-bash-"));

test("runs a command and returns exit 0 with stdout", async () => {
  const events: UIEvent[] = [];
  const r = await bashTool().execute({ command: "echo hello-bash" }, ctx(cwd(), events));
  expect(r.isError).toBe(false); // bash sets isError = (code !== 0)
  expect(String(r.output)).toContain("exit 0");
  expect(String(r.output)).toContain("hello-bash");
  // Output is streamed as progress events too.
  expect(events.some((e) => e.type === "tool-call-progress")).toBe(true);
});

test("a non-zero exit is reported as an error", async () => {
  const r = await bashTool().execute({ command: "exit 3" }, ctx(cwd()));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("exit 3");
});

test("multibyte UTF-8 output is preserved intact (streaming decode)", async () => {
  // Guards the per-stream streaming TextDecoder: a multibyte char must never
  // be corrupted into a replacement char.
  const r = await bashTool().execute(
    { command: "printf 'café — déjà vu 🚀\\n'" },
    ctx(cwd()),
  );
  expect(String(r.output)).toContain("café — déjà vu 🚀");
});

test("stderr is captured alongside stdout", async () => {
  const r = await bashTool().execute({ command: "echo oops 1>&2" }, ctx(cwd()));
  expect(String(r.output)).toContain("oops");
});

test("high-volume output is capped (retained buffer bounded during streaming)", async () => {
  // Emit ~1MB of output; the captured buffer must stay bounded (not grow to the
  // full volume in memory) and be marked truncated. 20000 lines of 60 chars.
  const r = await bashTool().execute(
    { command: "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -20000" },
    ctx(cwd()),
  );
  const output = String(r.output);
  expect(output).toContain("chars omitted"); // the head+tail elision marker
  // The captured output stays near the cap (status line + 30k + marker), nowhere
  // near the ~1.2MB the command produced.
  expect(output.length).toBeLessThan(31_000);
});

test("a trailing error line survives truncation (head+tail keep)", async () => {
  // A failing build prints its error LAST; a head-only cap would drop exactly
  // that line. Flood stdout well past the 30k cap, then print a final marker
  // line — it's on the same stream, so it's guaranteed to arrive last.
  const r = await bashTool().execute(
    {
      command:
        "for i in $(seq 1 2000); do echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done; echo 'TRAILING_ERROR_LINE_zzz'",
    },
    ctx(cwd()),
  );
  const output = String(r.output);
  expect(output).toContain("chars omitted"); // it WAS truncated…
  expect(output).toContain("TRAILING_ERROR_LINE_zzz"); // …but the last line survived
});

test("a command that exceeds its timeout is reported as a timeout, not a bare exit code", async () => {
  // A killed process exits with a SIGTERM code (143); without the explicit
  // timeout marker the model can't tell that apart from a real failure.
  const r = await bashTool().execute({ command: "sleep 5", timeoutMs: 150 }, ctx(cwd()));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("timed out after 150ms");
  // The misleading "exit 143" status must not be the headline instead.
  expect(String(r.output).startsWith("exit")).toBe(false);
});

test("aborting a foreground bash reaps the whole process tree (grandchildren too)", async () => {
  // Esc/steer aborts the turn. Bun's own signal handling SIGTERMs only the direct
  // `bash` child, orphaning a backgrounded grandchild (node/vite under a dev
  // server) which reparents to PID 1 and leaks its port. The tool must kill the
  // whole tree — while bash is still alive to be the grandchild's parent.
  const ac = new AbortController();
  const c: ToolContext = { ...ctx(cwd()), abortSignal: ac.signal };
  const uniq = 910_000 + Math.floor(Math.random() * 80_000);
  const done = bashTool().execute({ command: `sleep ${uniq} & wait` }, c);
  await Bun.sleep(300); // let the grandchild sleep spawn

  const before = new TextDecoder()
    .decode(Bun.spawnSync(["pgrep", "-f", `sleep ${uniq}`]).stdout)
    .trim();
  expect(before).not.toBe(""); // grandchild is running

  ac.abort();
  await done.catch(() => {}); // old code may reject on abort; new code resolves
  await Bun.sleep(400); // let the tree-kill propagate

  const after = new TextDecoder()
    .decode(Bun.spawnSync(["pgrep", "-f", `sleep ${uniq}`]).stdout)
    .trim();
  expect(after).toBe(""); // the orphaned grandchild was reaped
});

test("background run without a job registry is rejected cleanly", async () => {
  const r = await bashTool().execute({ command: "sleep 1", background: true }, ctx(cwd()));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("unavailable");
});

test("a backgrounded child holding the pipe doesn't hang the call past the grace deadline", async () => {
  // `sh -c "sleep 5 & echo hi"` exits instantly, but the backgrounded `sleep`
  // inherits stdout and keeps the pipe open. Without the post-exit grace race the
  // call would block for the full 5s on pump(); it must return promptly with the
  // captured output plus a note.
  const start = Date.now();
  const r = await bashTool(undefined, undefined, { postKillGraceMs: 200 }).execute(
    { command: "sleep 5 & echo hi" },
    ctx(cwd()),
  );
  expect(Date.now() - start).toBeLessThan(3000); // did NOT wait out the 5s sleep
  expect(String(r.output)).toContain("hi");
  expect(String(r.output)).toContain("still holding stdout");
});
