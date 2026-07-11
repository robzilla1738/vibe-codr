import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function toolCall(id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
function finalText() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "done" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Build an engine whose model runs `steps`, with a counting `danger` tool. */
function makeEngine(
  steps: unknown[],
  interactive: boolean,
  permissions: { tool: string; match?: string; action: "allow" | "deny" | "ask" }[] = [],
) {
  let runs = 0;
  const danger: ToolDefinition<{ command?: string }> = {
    name: "danger",
    description: "side effect",
    inputSchema: z.object({ command: z.string().optional() }),
    readOnly: false,
    execute: async () => {
      runs += 1;
      return { output: "did it" };
    },
  };
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
  const cwd = mkdtempSync(join(tmpdir(), "vibe-perm-")); // isolated, non-git
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", permissions },
    registry,
    toolset: new Toolset([danger]),
    interactive,
    cwd,
  });
  return { engine, runs: () => runs, cwd };
}

/** A `danger` tool call carrying a `command` scope (for scoped-rule tests). */
function toolCallCmd(id: string, command: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "danger",
          input: JSON.stringify({ command }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Auto-answer every permission-request with `decision`; collect events. */
function drive(engine: Engine, decision: "once" | "always" | "always-project" | "deny") {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  return events;
}

test("interactive: an allowed (once) permission lets the tool run", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(1);
});

test("interactive: a denied permission blocks the tool", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "deny");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(0);
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(
    true,
  );
});

test("interactive: 'always' suppresses the second prompt", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), toolCall("c2"), finalText()], true);
  const events = drive(engine, "always");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1); // asked once, remembered for the second call
  expect(runs()).toBe(2);
});

test("interactive: two tool calls in one step each get a distinct prompt", async () => {
  const twoCalls = {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "c1", toolName: "danger", input: "{}" },
        { type: "tool-call", toolCallId: "c2", toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
  const { engine, runs } = makeEngine([twoCalls, finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();

  const ids = events
    .filter((e) => e.type === "permission-request")
    .map((e) => (e as Extract<UIEvent, { type: "permission-request" }>).id);
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2); // distinct ids, both resolvable
  expect(runs()).toBe(2);
});

test("re-gating approvals to ask forgets a prior 'always' grant (it can't bypass the fresh gate)", async () => {
  // Prompt 1: model calls danger → user grants 'always'. Then approvals are
  // re-gated to ask (a /plan/-execute/plan-accept transition). Prompt 2's danger
  // call must PROMPT AGAIN — the old 'always' grant must not silently bypass it.
  const { engine, runs } = makeEngine(
    [toolCall("c1"), finalText(), toolCall("c2"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request")
        engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
    }
  })();
  engine.send({ type: "submit-prompt", text: "one" });
  await engine.whenIdle();
  const asksAfter1 = events.filter((e) => e.type === "permission-request").length;
  expect(asksAfter1).toBe(1); // asked once, remembered

  // Re-gate to ask (clears the always-allow set).
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();

  engine.send({ type: "submit-prompt", text: "two" });
  await engine.whenIdle();
  const asksTotal = events.filter((e) => e.type === "permission-request").length;
  // A SECOND prompt was required for the second danger call — the grant didn't carry over.
  expect(asksTotal).toBe(2);
  expect(runs()).toBe(2);
});

test("non-interactive: side-effecting tools auto-allow without prompting", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false);
  const events = drive(engine, "deny"); // would deny if asked
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false);
  expect(runs()).toBe(1);
});

test("non-interactive: an EXPLICIT ask rule fails CLOSED (a human gate can't auto-allow)", async () => {
  // A deliberately-authored `{action:"ask"}` gate must not silently become
  // `allow` in a headless run — there is no human to approve.
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false, [
    { tool: "danger", action: "ask" },
  ]);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false); // nothing to answer
  expect(runs()).toBe(0); // blocked, not run
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(
    true,
  );
});

test("abort auto-denies a pending permission AND emits permission-settled with its id", async () => {
  // A non-user abort (steer / budget-stop / loop-stop) auto-resolves the pending
  // prompt as deny. Without an event the TUI's card lingered into the next turn;
  // permission-settled tells the UI to drop it (and answering the dead id is then
  // a silent no-op instead of a false "allowed" notice).
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events: UIEvent[] = [];
  let pendingId: string | undefined;
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      // Interrupt WHILE the prompt is pending instead of answering it.
      if (e.type === "permission-request") {
        pendingId = e.id;
        engine.send({ type: "abort" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();

  const settled = events.find(
    (e): e is Extract<UIEvent, { type: "permission-settled" }> => e.type === "permission-settled",
  );
  expect(settled).toBeDefined();
  expect(settled?.reason).toBe("aborted");
  expect(settled?.ids).toContain(pendingId);
  expect(runs()).toBe(0); // the cancelled tool never ran
});

test("steer settles a permission parked in the running turn (the queue isn't frozen behind a dead card)", async () => {
  // Steer aborts the session but (unlike the `abort` case) never called
  // #settlePendingPermissions — a tool parked in #askPermission blocked the
  // tool-execute promise, so the whole FIFO queue (and the steered prompt behind
  // it) froze until a human answered a card the steer was meant to kill. The
  // abort-aware ask now denies the parked prompt + emits permission-settled.
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events: UIEvent[] = [];
  let steered = false;
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      // When "A" parks on the permission, steer the queued "B" instead of answering.
      if (e.type === "permission-request" && !steered) {
        steered = true;
        for (const q of events) {
          if (q.type === "queue-changed") {
            const hit = q.pending.find((p) => p.label === "B");
            if (hit) {
              engine.send({ type: "steer", id: hit.id });
              break;
            }
          }
        }
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "A" });
  engine.send({ type: "submit-prompt", text: "B" });
  await engine.whenIdle();

  const settled = events.find(
    (e): e is Extract<UIEvent, { type: "permission-settled" }> => e.type === "permission-settled",
  );
  expect(settled?.reason).toBe("aborted");
  expect(runs()).toBe(0); // the parked tool never ran
  // B still ran — the queue wasn't wedged behind the dead permission card.
  const prompts = events
    .filter((e): e is Extract<UIEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
  expect(prompts).toContain("B");
});

test("interactive: 'always' is remembered per content scope, not for the whole tool", async () => {
  // Approving `danger {command:"safe"}` with 'always' must NOT auto-allow a later
  // `danger {command:"rm -rf /"}` — that call still prompts.
  const { engine, runs } = makeEngine(
    [toolCallCmd("c1", "safe"), toolCallCmd("c2", "rm -rf /"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        // 'always' the first (safe) call; 'deny' the second (rm) call.
        const decision = prompts.length === 1 ? "always" : "deny";
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  // Both calls prompted — the 'always' for "safe" did not cover "rm -rf /".
  expect(prompts.length).toBe(2);
  expect(runs()).toBe(1); // only the safe one ran
});

/** A path-bearing side-effecting tool + a stream that calls it with a `path`.
 * The built-in `edit`/`write` need a real file on disk; a mock keeps the
 * canonical-path keying test hermetic while still flowing a `path` scope through
 * the permission gate. */
function makePathEngine(steps: unknown[], cwdOverride?: string) {
  let runs = 0;
  const writer: ToolDefinition<{ path?: string }> = {
    name: "writer",
    description: "writes a path",
    inputSchema: z.object({ path: z.string().optional() }),
    readOnly: false,
    execute: async () => {
      runs += 1;
      return { output: "wrote" };
    },
  };
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
  const cwd = cwdOverride ?? mkdtempSync(join(tmpdir(), "vibe-perm-path-"));
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    registry,
    toolset: new Toolset([writer]),
    interactive: true,
    cwd,
  });
  return { engine, runs: () => runs, cwd };
}

/** A `writer` tool call carrying a `path` scope. */
function writerCall(id: string, path: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "writer", input: JSON.stringify({ path }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

test("interactive: 'always' for a path is keyed canonically — a re-spelled same file doesn't re-prompt", async () => {
  // Approving `writer {path:"src/x.ts"}` with 'always' must also cover the next
  // call spelled `./src/x.ts` (the SAME file after resolve(cwd, path)) — the
  // grant map keys the scope by its canonical absolute form, not the raw
  // spelling, so no second prompt.
  const { engine, runs } = makePathEngine([
    writerCall("c1", "src/x.ts"),
    writerCall("c2", "./src/x.ts"),
    finalText(),
  ]);
  const events = drive(engine, "always");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1); // ./src/x.ts is the same canonical file as src/x.ts
  expect(runs()).toBe(2);
});

test("interactive: 'always' for a path does NOT cover a DIFFERENT file", async () => {
  // A grant for src/x.ts must not green-light src/y.ts — a different canonical
  // path still prompts.
  const { engine, runs } = makePathEngine([
    writerCall("c1", "src/x.ts"),
    writerCall("c2", "src/y.ts"),
    finalText(),
  ]);
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(prompts.length).toBe(2); // both distinct files prompted
  expect(runs()).toBe(2);
});

async function readProjectRules(cwd: string): Promise<unknown[]> {
  const f = Bun.file(join(cwd, ".vibe", "config.json"));
  if (!(await f.exists())) return [];
  return (JSON.parse(await f.text()).permissions ?? []) as unknown[];
}

test("always-project: persists a validated command-scoped rule mirroring the in-memory grant", async () => {
  // Approving a command call with 'always-project' both suppresses the next
  // prompt (in-memory) AND writes a scoped {tool, matchExact:<command>,
  // action:"allow"} rule into the project config. A COMMAND scope persists as
  // matchExact (literal equality) — NOT match — so a `*` in the approved command
  // can't glob-broaden across sessions (approving `rm build/*` must not next
  // session auto-allow `rm build/../secret.env`). It mirrors the EXACT-string
  // in-memory command grant.
  const { engine, runs, cwd } = makeEngine(
    [toolCallCmd("c1", "git status"), toolCallCmd("c2", "git status"), finalText()],
    true,
  );
  const events = drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.filter((e) => e.type === "permission-request").length).toBe(1); // remembered
  expect(runs()).toBe(2);
  expect(await readProjectRules(cwd)).toEqual([
    { tool: "danger", matchExact: "git status", action: "allow" },
  ]);
});

test("always-project: a command grant with a glob char persists as matchExact, NOT a broadened match", async () => {
  // The core FIX-3 invariant end-to-end: approving `rm build/*` persists a
  // matchExact rule so a FRESH PermissionChecker load allows ONLY the literal
  // `rm build/*` and NOT the glob-broadened `rm build/../secret.env` that a
  // `match:"rm build/*"` rule (globToRegExp `*`→`.*`) would have auto-allowed.
  const { engine, cwd } = makeEngine([toolCallCmd("c1", "rm build/*"), finalText()], true);
  drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(await readProjectRules(cwd)).toEqual([
    { tool: "danger", matchExact: "rm build/*", action: "allow" },
  ]);
  // A fresh load + checker: the persisted rule allows the exact command…
  const { loadConfig } = await import("@vibe/config");
  const { PermissionChecker } = await import("./permissions.ts");
  const cfg = await loadConfig({ cwd });
  const checker = new PermissionChecker(cfg.permissions, () => false, "ask", cwd);
  expect((await checker.check("danger", { command: "rm build/*" })).allowed).toBe(true);
  // …but NOT a glob-broadened traversal a `match` rule would have wrongly allowed.
  expect((await checker.check("danger", { command: "rm build/../secret.env" })).allowed).toBe(
    false,
  );
});

test("always-project: a path grant persists the REALPATH-canonical path as matchExact (mirrors the key scope)", async () => {
  // Regression (audit backlog): the path grant used to persist `match:
  // resolve(cwd, path)` — the LEXICAL spelling as a GLOB. Under a symlinked
  // ancestor (macOS /var→/private/var, which THIS tmpdir cwd sits under) the
  // checker's allow side judges the REAL target, so the lexical rule never
  // re-matched (silent re-prompt every session); and a literal `*` in the path
  // would have glob-broadened. matchExact on the realpath form fixes both.
  const { engine, cwd } = makePathEngine([writerCall("c1", "src/x.ts"), finalText()]);
  drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(await readProjectRules(cwd)).toEqual([
    { tool: "writer", matchExact: join(realpathSync(cwd), "src/x.ts"), action: "allow" },
  ]);
});

test("always-project: a path grant under a symlinked-ancestor cwd is honored on a fresh load", async () => {
  // End-to-end for the audit-backlog defect: grant in a session whose cwd is
  // spelled THROUGH a symlink (link -> real), then reload the project config
  // fresh — the same file must be allowed again in EVERY spelling, with no
  // re-prompt, and a different file must still ask.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vibe-perm-symgrant-")));
  mkdirSync(join(base, "real"));
  symlinkSync(join(base, "real"), join(base, "link"));
  const linkCwd = join(base, "link");
  const { engine, cwd } = makePathEngine([writerCall("c1", "src/x.ts"), finalText()], linkCwd);
  drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  // Persisted in the symlink-dereferenced form, not the lexical link spelling.
  expect(await readProjectRules(cwd)).toEqual([
    { tool: "writer", matchExact: join(base, "real", "src", "x.ts"), action: "allow" },
  ]);
  const { loadConfig } = await import("@vibe/config");
  const { PermissionChecker } = await import("./permissions.ts");
  const cfg = await loadConfig({ cwd });
  const checker = new PermissionChecker(cfg.permissions, () => false, "ask", cwd);
  // Every spelling of the granted file re-matches: relative, ./-prefixed,
  // lexical absolute (through the link), and the real absolute.
  for (const path of [
    "src/x.ts",
    "./src/x.ts",
    join(linkCwd, "src", "x.ts"),
    join(base, "real", "src", "x.ts"),
  ]) {
    expect((await checker.check("writer", { path })).allowed).toBe(true);
  }
  // A different file is NOT covered → default ask → denied.
  expect((await checker.check("writer", { path: "src/y.ts" })).allowed).toBe(false);
});

test("always-project: a path grant with a literal glob char does NOT broaden to sibling files", async () => {
  // Regression (audit backlog): the old `match` form compiled a literal `*` in
  // the granted FILENAME into `.*`, so granting `src/a*.ts` auto-allowed
  // `src/anything.ts` next session. matchExact keeps it to the one file.
  const { engine, cwd } = makePathEngine([writerCall("c1", "src/a*.ts"), finalText()]);
  drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(await readProjectRules(cwd)).toEqual([
    { tool: "writer", matchExact: join(realpathSync(cwd), "src/a*.ts"), action: "allow" },
  ]);
  const { loadConfig } = await import("@vibe/config");
  const { PermissionChecker } = await import("./permissions.ts");
  const cfg = await loadConfig({ cwd });
  const checker = new PermissionChecker(cfg.permissions, () => false, "ask", cwd);
  // The literally-named file is allowed…
  expect((await checker.check("writer", { path: "src/a*.ts" })).allowed).toBe(true);
  // …but a sibling the old glob rule would have wrongly covered still asks.
  expect((await checker.check("writer", { path: "src/anything.ts" })).allowed).toBe(false);
});

test("always-project: the persisted rule is honored on a fresh load of the project config", async () => {
  const { engine, cwd } = makeEngine([toolCallCmd("c1", "ls"), finalText()], true);
  drive(engine, "always-project");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const { loadConfig } = await import("@vibe/config");
  const cfg = await loadConfig({ cwd });
  expect(cfg.permissions).toContainEqual({ tool: "danger", matchExact: "ls", action: "allow" });
});

test("interactive: a command grant stays EXACT-string keyed (a path-looking command isn't canonicalized)", async () => {
  // PATH scopes are spelling-equivalent; COMMAND scopes are not. Two command
  // strings that WOULD canonicalize to one path ("./src/x.ts" vs "src/x.ts") are
  // DISTINCT command grants — both prompt — so path canonicalization never leaks
  // into command keying.
  const { engine, runs } = makeEngine(
    [toolCallCmd("c1", "./src/x.ts"), toolCallCmd("c2", "src/x.ts"), finalText()],
    true,
  );
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(prompts.length).toBe(2); // command scopes are exact — both prompted
  expect(runs()).toBe(2);
});
