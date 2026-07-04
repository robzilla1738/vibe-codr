import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIEvent } from "@vibe/shared";
import { ACCENT_PRESETS, THEME_NAMES } from "@vibe/shared";
import { defaultConfig } from "@vibe/config";
import type { Skill } from "@vibe/plugins";
import { Engine } from "./engine.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { buildSkillPrompt, goalStatusText, handleSlash } from "./engine-commands.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cmd-cp-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@t.dev"]);
  await git(dir, ["config", "user.name", "t"]);
  await Bun.write(join(dir, "a.txt"), "original\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function skill(dir: string): Skill {
  return { name: "helper", description: "d", dir, load: async () => "body" };
}

function collect(engine: Engine): UIEvent[] {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return events;
}

function notices(events: UIEvent[]): Extract<UIEvent, { type: "notice" }>[] {
  return events.filter((e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice");
}

// `/reasoning` must be honest about whether the effort hint reaches the model:
// confirm only when we forward it, caveat when the model reasons natively but the
// transport drops the hint, and warn when the model ignores reasoning entirely.

test("/reasoning confirms plainly on a forwarded provider (openai)", async () => {
  const engine = new Engine({ config: { ...defaultConfig(), model: "openai/gpt-5.5" } });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "reasoning", args: "high" });
  await engine.whenIdle();
  const last = notices(events).at(-1)!;
  expect(last.message).toBe("Reasoning effort: high.");
  expect(last.level).not.toBe("warn");
});

test("/reasoning caveats a natively-reasoning, non-forwarding provider (xai)", async () => {
  const engine = new Engine({ config: { ...defaultConfig(), model: "xai/grok-4.3" } });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "reasoning", args: "medium" });
  await engine.whenIdle();
  const msg = notices(events).at(-1)!.message;
  expect(msg).toContain("reasons natively");
  expect(msg).toContain("not forwarded");
  // It must NOT read as a clean affirmation.
  expect(msg).not.toBe("Reasoning effort: medium.");
});

test("/reasoning warns on a local model that ignores reasoning (ollama)", async () => {
  const engine = new Engine({ config: { ...defaultConfig(), model: "ollama/llama3.1" } });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "reasoning", args: "low" });
  await engine.whenIdle();
  const last = notices(events).at(-1)!;
  expect(last.level).toBe("warn");
  expect(last.message).toContain("likely ignores it");
});

// `/theme` + `/accent` validate against the SHARED theme registry (@vibe/shared's
// THEME_NAMES / ACCENT_PRESETS — the TUI keeps the matching palettes). These
// tests are the engine-side half of the parity check: because both packages now
// import ONE registry, a theme/accent that the UI can render is exactly the set
// the engine accepts, with no hand-synced copy to drift.

test("/theme accepts every name in the shared THEME_NAMES and emits theme-changed", async () => {
  for (const name of THEME_NAMES) {
    const engine = new Engine({ config: defaultConfig() });
    const events = collect(engine);
    engine.send({ type: "run-slash", name: "theme", args: name });
    await engine.whenIdle();
    const changed = events.filter((e): e is Extract<UIEvent, { type: "theme-changed" }> => e.type === "theme-changed");
    expect(changed.at(-1)?.theme).toBe(name);
    expect(notices(events).at(-1)?.level).not.toBe("warn");
  }
});

test("/theme rejects an unknown name (no theme-changed) rather than silently defaulting", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "theme", args: "not-a-real-theme" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "theme-changed")).toBe(false);
  expect(notices(events).at(-1)?.message).toContain("Unknown theme");
});

test("/accent resolves each shared preset NAME to its hex on accent-changed", async () => {
  for (const [name, hex] of Object.entries(ACCENT_PRESETS)) {
    const engine = new Engine({ config: defaultConfig() });
    const events = collect(engine);
    engine.send({ type: "run-slash", name: "accent", args: name });
    await engine.whenIdle();
    const changed = events.filter((e): e is Extract<UIEvent, { type: "accent-changed" }> => e.type === "accent-changed");
    // A preset name resolves to its shared hex; the emitted event carries a hex.
    expect(changed.at(-1)?.accent).toBe(hex);
  }
});

// `/model refresh` must be a catalog refresh, NOT a model switch: the TUI's
// /model picker advertises this spelling, and before the explicit verb it fell
// through to setMainModel — persisting the literal id "refresh" to the global
// config and bricking every later turn.
test("/model refresh refreshes the catalog and never sets the model to 'refresh'", async () => {
  const config = defaultConfig();
  const before = config.model;
  const engine = new Engine({ config });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "model", args: "refresh" });
  await engine.whenIdle();
  expect(config.model).toBe(before);
  expect(engine.snapshot().model).toBe(before);
  const msgs = notices(events).map((n) => n.message);
  expect(msgs.some((m) => m.includes("catalog refreshed"))).toBe(true);
  expect(msgs.some((m) => m.includes("Model → refresh"))).toBe(false);
});

// `/providers` is advertised in the TUI palette; a SUBMITTED line (headless
// REPL, or a draft-time menu that failed to load) must print the provider/key
// summary instead of "Unknown command".
test("/providers lists every provider with key status (and honors a filter)", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "providers", args: "" });
  await engine.whenIdle();
  const all = notices(events).at(-1)!.message;
  expect(all).toContain("Providers");
  expect(all).toContain("anthropic");
  expect(all).toContain("openai");

  engine.send({ type: "run-slash", name: "providers", args: "anthro" });
  await engine.whenIdle();
  const filtered = notices(events).at(-1)!.message;
  expect(filtered).toContain("anthropic");
  expect(filtered).not.toContain("openai");
});

// `/jobs` works in the TUI as a local sub-view toggle; the engine handler is
// the headless/REPL parity path.
test("/jobs reports the empty state when no background jobs exist", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "jobs", args: "" });
  await engine.whenIdle();
  expect(notices(events).at(-1)!.message).toContain("No background jobs");
});

// `/skills <filter>` narrows the list (the palette advertises `[filter]`; the
// engine used to ignore it and always dump everything).
test("/skills honors its filter argument", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vibe-skillfilter-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "deploy", "SKILL.md"),
    "---\ndescription: Ship to production\n---\nBody.",
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "review", "SKILL.md"),
    "---\ndescription: Review a diff\n---\nBody.",
  );
  const engine = new Engine({ config: defaultConfig(), cwd: dir });
  await engine.bootstrap();
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "skills", args: "deploy" });
  await engine.whenIdle();
  const msg = notices(events).at(-1)!.message;
  expect(msg).toContain("deploy");
  expect(msg).not.toContain("review");

  engine.send({ type: "run-slash", name: "skills", args: "zzz-no-match" });
  await engine.whenIdle();
  expect(notices(events).at(-1)!.message).toContain('No skill matches "zzz-no-match"');
});

// A /skill-as-prompt injection must disclose the skill's directory so a body that
// references bundled files ("read helpers.py first") can resolve them.
test("/skill-as-prompt injection discloses the skill directory", () => {
  const prompt = buildSkillPrompt(skill("/tmp/skills/helper"), "read helpers.py first", "");
  expect(prompt).toContain("Skill directory: /tmp/skills/helper");
});

test("/skill-as-prompt injection omits the directory line when a skill has no dir", () => {
  const prompt = buildSkillPrompt(skill(""), "read helpers.py first", "");
  expect(prompt).toContain("read helpers.py first");
  expect(prompt).not.toContain("Skill directory:");
});

test("/undo <index> routes through restoreTo to the chosen checkpoint", async () => {
  const dir = await gitRepo();
  // Seed checkpoints with a session-agnostic manager; the untagged entries are
  // visible to the Engine's own (session-scoped) manager on the same cwd.
  const seed = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await seed.snapshot("v0");
  await Bun.write(join(dir, "a.txt"), "v1\n");
  await seed.snapshot("v1");

  const engine = new Engine({ config: defaultConfig(), cwd: dir });
  const events = collect(engine);
  // Newest = index 1 (v1); index 2 is the older v0.
  engine.send({ type: "run-slash", name: "undo", args: "2" });
  await engine.whenIdle();

  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v0\n");
  expect(notices(events).some((n) => n.message === "Reverted to checkpoint: v0")).toBe(true);
});

test("/undo with an out-of-range index reports honestly instead of restoring", async () => {
  const dir = await gitRepo();
  const seed = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await seed.snapshot("v0");

  const engine = new Engine({ config: defaultConfig(), cwd: dir });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "undo", args: "9" });
  await engine.whenIdle();

  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v0\n"); // unchanged
  expect(notices(events).at(-1)!.message).toContain('No checkpoint "9"');
  expect(notices(events).at(-1)!.level).toBe("warn");
});

test("/redo with no stashed conversation tail still restores the files forward and reports success", async () => {
  // FIX 1 back-compat: a checkpoint with no recorded conversation mark leaves the
  // redo step without a payload; /redo must still move the working tree forward and
  // confirm, not silently do nothing.
  const dir = await gitRepo();
  const seed = new CheckpointManager(dir);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await seed.snapshot("v0"); // no conversation mark recorded
  await Bun.write(join(dir, "a.txt"), "v1\n"); // later, uncommitted edits

  const engine = new Engine({ config: defaultConfig(), cwd: dir });
  const events = collect(engine);

  engine.send({ type: "run-slash", name: "undo", args: "" });
  await engine.whenIdle();
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v0\n");

  engine.send({ type: "run-slash", name: "redo", args: "" });
  await engine.whenIdle();
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n"); // files moved forward
  expect(notices(events).some((n) => n.message === "Redid: v0")).toBe(true);
});

test("/redo with an empty stack reports honestly", async () => {
  const dir = await gitRepo();
  const engine = new Engine({ config: defaultConfig(), cwd: dir });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "redo", args: "" });
  await engine.whenIdle();
  expect(notices(events).at(-1)!.message).toBe("Nothing to redo.");
});

// The redo conversation stash is position-aware: the tail sliced off by /undo is
// re-appended ONLY while the conversation still sits at the rewound mark. A /clear
// or any intervening turn invalidates it — /redo then restores files only, never
// resurrecting cleared context or splicing the undone turn after newer messages.

/** Minimal stand-in for the Session conversation surface handleSlash touches. */
function fakeConversation(initial: number) {
  const msgs: unknown[] = Array.from({ length: initial }, (_, i) => ({ i }));
  const hist: unknown[] = Array.from({ length: initial }, (_, i) => ({ i }));
  return {
    get messageCount() {
      return msgs.length;
    },
    conversationMark: () => ({ messages: msgs.length, history: hist.length }),
    rewindConversation(mark: { messages: number; history: number }) {
      if (mark.messages >= msgs.length && mark.history >= hist.length) return undefined;
      const tail = { modelMessages: msgs.slice(mark.messages), history: hist.slice(mark.history) };
      msgs.length = Math.min(mark.messages, msgs.length);
      hist.length = Math.min(mark.history, hist.length);
      return tail;
    },
    restoreConversation(tail: { modelMessages: unknown[]; history: unknown[] }) {
      msgs.push(...tail.modelMessages);
      hist.push(...tail.history);
    },
    clear() {
      msgs.length = 0;
      hist.length = 0;
    },
    grow(n: number) {
      for (let i = 0; i < n; i++) {
        msgs.push({ fresh: i });
        hist.push({ fresh: i });
      }
    },
  };
}

function redoHarness(dir: string, session: ReturnType<typeof fakeConversation>) {
  const checkpoints = new CheckpointManager(dir);
  const messages: { message: string; level?: string }[] = [];
  const h = {
    checkpoints,
    session,
    commands: { get: () => undefined },
    notice: (message: string, level?: string) => messages.push({ message, level }),
    emit: () => {},
    // /clear pauses a live goal run before wiping; the harness has none.
    pauseGoalRun: () => {},
  } as unknown as Parameters<typeof handleSlash>[0];
  return { checkpoints, h, messages };
}

test("/redo after /clear does not resurrect the cleared conversation (files still restore)", async () => {
  const dir = await gitRepo();
  const session = fakeConversation(3);
  const { checkpoints, h } = redoHarness(dir, session);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await checkpoints.snapshot("v0", { messages: 1, history: 1 });
  await Bun.write(join(dir, "a.txt"), "v1\n"); // newest edits above the checkpoint

  await handleSlash(h, "undo", ""); // files → v0, conversation → 1 message, tail stashed
  expect(session.messageCount).toBe(1);
  await handleSlash(h, "clear", ""); // context deliberately reset
  expect(session.messageCount).toBe(0);

  await handleSlash(h, "redo", "");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n"); // tree moves forward
  expect(session.messageCount).toBe(0); // the cleared context stays cleared
});

test("/redo skips a stale tail when the conversation moved past the undo mark", async () => {
  const dir = await gitRepo();
  const session = fakeConversation(3);
  const { checkpoints, h, messages } = redoHarness(dir, session);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await checkpoints.snapshot("v0", { messages: 1, history: 1 });
  await Bun.write(join(dir, "a.txt"), "v1\n");

  await handleSlash(h, "undo", "");
  expect(session.messageCount).toBe(1);
  session.grow(2); // an intervening (e.g. plan-mode) turn appends messages

  await handleSlash(h, "redo", "");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n");
  expect(session.messageCount).toBe(3); // 1 + 2 fresh — the stale tail was NOT appended
  expect(messages.some((m) => m.message.includes("Conversation changed since the undo"))).toBe(true);
});

test("/undo then immediate /redo still round-trips the conversation tail", async () => {
  const dir = await gitRepo();
  const session = fakeConversation(3);
  const { checkpoints, h } = redoHarness(dir, session);
  await Bun.write(join(dir, "a.txt"), "v0\n");
  await checkpoints.snapshot("v0", { messages: 1, history: 1 });
  await Bun.write(join(dir, "a.txt"), "v1\n");

  await handleSlash(h, "undo", "");
  expect(session.messageCount).toBe(1);
  await handleSlash(h, "redo", "");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("v1\n");
  expect(session.messageCount).toBe(3); // tail re-appended at the matching mark
});

test("goalStatusText names the run's actual state (active / paused / met / detached / none)", () => {
  const base = { phase: null, round: 0, max: 25, pausedReason: null, met: false } as const;
  expect(goalStatusText(null, { ...base, active: false })).toContain("No goal set");
  // Active: phase while planning, round counter while executing.
  expect(goalStatusText("ship it", { ...base, active: true, phase: "plan" })).toContain("Run active (planning)");
  expect(goalStatusText("ship it", { ...base, active: true, phase: "execute", round: 7 })).toContain(
    "Run active (round 7/25)",
  );
  // Paused: says WHY and how to re-arm.
  const paused = goalStatusText("ship it", { ...base, active: false, pausedReason: "interrupted (Esc)" });
  expect(paused).toContain("Run paused — interrupted (Esc)");
  expect(paused).toContain("/goal resume");
  // Met: no false "stops it" implication of a live run.
  expect(goalStatusText("ship it", { ...base, active: false, met: true })).toContain("verified met");
  // Goal set but never ran (legacy sessions): resume still offered.
  expect(goalStatusText("ship it", { ...base, active: false })).toContain("No run attached");
});
