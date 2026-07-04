import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { defaultConfig, type Config } from "@vibe/config";
import { CommandRegistry } from "@vibe/plugins";
import { Engine } from "./engine.ts";

// Each Engine gets an isolated temp cwd so `/recall`, `/memory`, checkpoints and
// session persistence never read or write the developer's real `.vibe/` — that
// made `/recall` flaky (it matched leftover sessions from prior runs).
function makeEngine(config: Config = defaultConfig()): Engine {
  return new Engine({ config, cwd: mkdtempSync(join(tmpdir(), "vibe-engine-test-")) });
}

function collect(engine: Engine): { events: UIEvent[]; stop: () => void } {
  const events: UIEvent[] = [];
  const sub = engine.events();
  let active = true;
  void (async () => {
    for await (const e of sub) {
      if (!active) break;
      events.push(e);
    }
  })();
  return { events, stop: () => (active = false) };
}

test("/help lists commands, /model switches, /clear clears", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);

  engine.send({ type: "run-slash", name: "help", args: "" });
  engine.send({ type: "run-slash", name: "model", args: "openai/gpt-x" });
  engine.send({ type: "run-slash", name: "clear", args: "" });
  await engine.whenIdle();
  stop();

  const help = events.find(
    (e) => e.type === "notice" && e.message.includes("/help"),
  );
  expect(help).toBeDefined();

  expect(engine.snapshot().model).toBe("openai/gpt-x");
  expect(events.some((e) => e.type === "model-changed")).toBe(true);
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("cleared")),
  ).toBe(true);
});

test("snapshot.commandNames exposes built-ins, custom commands, and skills", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-cmds-"));
  mkdirSync(join(cwd, ".vibe", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".vibe", "commands", "shipit.md"), "Ship the feature: $ARGS");
  mkdirSync(join(cwd, ".vibe", "skills", "polish"), { recursive: true });
  writeFileSync(
    join(cwd, ".vibe", "skills", "polish", "SKILL.md"),
    "---\nname: polish\ndescription: Polish the UI\n---\nDo the polish.",
  );
  const engine = new Engine({ config: defaultConfig(), cwd });
  await engine.bootstrap();

  const names = engine.snapshot().commandNames;
  expect(names).toContain("help"); // built-in
  expect(names).toContain("cost"); // built-in
  expect(names).toContain("shipit"); // custom command
  expect(names).toContain("polish"); // skill (invocable as /polish)
});

test("/accent sets the accent color and emits accent-changed", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "accent", args: "#abcdef" });
  await engine.whenIdle();
  stop();
  expect(engine.snapshot().accentColor).toBe("#abcdef");
  expect(events.some((e) => e.type === "accent-changed" && e.accent === "#abcdef")).toBe(true);
});

test("/accent accepts named presets (orange → its hex) and rejects unknown names", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "accent", args: "orange" });
  await engine.whenIdle();
  // The event carries the RESOLVED hex, so UIs need no preset map of their own.
  expect(engine.snapshot().accentColor).toBe("#fab283");
  expect(events.some((e) => e.type === "accent-changed" && e.accent === "#fab283")).toBe(true);
  engine.send({ type: "run-slash", name: "accent", args: "chartreuse-ish" });
  await engine.whenIdle();
  stop();
  // Unknown name: warned, unchanged.
  expect(engine.snapshot().accentColor).toBe("#fab283");
  expect(
    events.some((e) => e.type === "notice" && e.level === "warn" && /Unknown accent/.test(e.message)),
  ).toBe(true);
});

test("/theme accepts the ported classic themes", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "theme", args: "tokyonight" });
  await engine.whenIdle();
  stop();
  expect(events.some((e) => e.type === "theme-changed" && e.theme === "tokyonight")).toBe(true);
  expect(engine.snapshot().theme).toBe("tokyonight");
});

test("snapshot.git reports branch and dirty count inside a repo", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-git-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(cwd, "a.txt"), "hello");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  writeFileSync(join(cwd, "b.txt"), "dirty"); // untracked → counts as dirty

  const engine = new Engine({ config: defaultConfig(), cwd });
  await engine.bootstrap();
  const g = engine.snapshot().git;
  expect(g).toBeDefined();
  expect(typeof g?.branch).toBe("string");
  expect(g?.branch.length).toBeGreaterThan(0);
  expect(g?.dirty).toBeGreaterThanOrEqual(1);
  expect(g?.worktree).toBe(false);
});

test("/plan and /execute toggle mode", async () => {
  const engine = makeEngine();
  collect(engine);
  engine.send({ type: "run-slash", name: "plan", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("plan");
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("execute");
});

test("/plan then /execute never silently lands in YOLO — approvals reset to ask", async () => {
  // Regression: from a YOLO session (approvals=auto), `/plan` then `/execute`
  // used to leave approvals on `auto`, so the next turn ran unprompted while the
  // user believed they were back in gated EXECUTE.
  const engine = makeEngine();
  const { events } = collect(engine);
  // Enter YOLO: approvals → auto.
  engine.send({ type: "run-slash", name: "approvals", args: "auto" });
  await engine.whenIdle();
  // /plan must couple approvals back to ask.
  engine.send({ type: "run-slash", name: "plan", args: "" });
  await engine.whenIdle();
  const afterPlan = events.filter((e) => e.type === "approvals-changed").at(-1);
  expect(afterPlan && afterPlan.type === "approvals-changed" && afterPlan.mode).toBe("ask");
  // And /execute stays gated (ask), not YOLO.
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();
  const last = events.filter((e) => e.type === "approvals-changed").at(-1);
  expect(last && last.type === "approvals-changed" && last.mode).toBe("ask");
  expect(engine.snapshot().mode).toBe("execute");
});

test("a RAW set-mode always lands in gated ask — the engine owns the invariant", () => {
  // The TUI maps typed /plan and /execute to bare `set-mode` commands (NOT the
  // run-slash handlers), and scripted clients send set-mode directly — so the
  // re-gate must live in the engine's set-mode path itself, or a YOLO session
  // that visits plan mode comes back still in YOLO. set-mode/set-approvals are
  // immediate (not queued), so the snapshot asserts synchronously.
  const engine = makeEngine();
  engine.send({ type: "set-approvals", mode: "auto" });
  expect(engine.snapshot().approvalMode).toBe("auto");
  engine.send({ type: "set-mode", mode: "plan" });
  expect(engine.snapshot().mode).toBe("plan");
  expect(engine.snapshot().approvalMode).toBe("ask");
  engine.send({ type: "set-mode", mode: "execute" });
  expect(engine.snapshot().mode).toBe("execute");
  expect(engine.snapshot().approvalMode).toBe("ask");
  // Deliberate YOLO still works: the explicit set-approvals lands AFTER the
  // set-mode (the exact pair the TUI's Shift+Tab yolo target sends)…
  engine.send({ type: "set-mode", mode: "execute" });
  engine.send({ type: "set-approvals", mode: "auto" });
  expect(engine.snapshot().approvalMode).toBe("auto");
  // …and a fresh set-mode re-arms the gate even without a mode change (an
  // explicit /execute in execute means "back to gated", forgetting grants).
  engine.send({ type: "set-mode", mode: "execute" });
  expect(engine.snapshot().approvalMode).toBe("ask");
});

test("/yolo switches to execute with approvals auto, loudly", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "yolo", args: "" });
  await engine.whenIdle();
  stop();
  expect(engine.snapshot().mode).toBe("execute");
  expect(engine.snapshot().approvalMode).toBe("auto");
  // Entering the no-prompts state leaves a transcript-visible warn — the red
  // chip alone is easy to miss.
  expect(
    events.some((e) => e.type === "notice" && e.level === "warn" && /YOLO/.test(e.message)),
  ).toBe(true);
});

test("/goal sets + starts a run, bare /goal shows, /goal clear clears", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "goal", args: "ship it" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBe("ship it");
  // Setting a goal is no longer passive: it announces and enqueues a working
  // turn (which errors here — no provider — and pauses the run via lastError).
  expect(events.some((e) => e.type === "notice" && /Goal set/.test(e.message))).toBe(true);
  expect(events.some((e) => e.type === "user-message")).toBe(true);

  // Bare /goal SHOWS the goal (it used to silently clear it).
  engine.send({ type: "run-slash", name: "goal", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBe("ship it");
  expect(events.some((e) => e.type === "notice" && /^Goal: ship it/.test(e.message))).toBe(true);

  engine.send({ type: "run-slash", name: "goal", args: "clear" });
  await engine.whenIdle();
  stop();
  expect(engine.snapshot().goal).toBeNull();
  expect(events.some((e) => e.type === "notice" && /Goal cleared/.test(e.message))).toBe(true);
});

test("/status, /context, /memory, /recall run and emit notices", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);

  engine.send({ type: "run-slash", name: "status", args: "" });
  engine.send({ type: "run-slash", name: "context", args: "" });
  engine.send({ type: "run-slash", name: "memory", args: "" });
  engine.send({ type: "run-slash", name: "recall", args: "" });
  engine.send({ type: "run-slash", name: "recall", args: "anything" });
  await engine.whenIdle();
  stop();

  const notices = events.filter((e) => e.type === "notice").map((e) => e.message);
  expect(notices.some((m) => m.includes("context"))).toBe(true); // /status row
  expect(notices.some((m) => m.includes("Context window"))).toBe(true); // /context
  expect(notices.some((m) => m.includes("memory") || m.includes("Memory"))).toBe(true);
  // Empty /recall warns about usage; a query with no saved sessions reports no matches.
  expect(notices.some((m) => m.includes("Usage: /recall"))).toBe(true);
  expect(notices.some((m) => m.includes("No matches"))).toBe(true);
});

test("/reasoning warns on a non-reasoning (local) model", async () => {
  const engine = makeEngine();
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "model", args: "ollama/llama3.1" });
  engine.send({ type: "run-slash", name: "reasoning", args: "high" });
  await engine.whenIdle();
  stop();
  const warned = events.some(
    (e) => e.type === "notice" && e.level === "warn" && e.message.includes("ignores it"),
  );
  expect(warned).toBe(true);
});

test("a custom /redo command is usable (redo is not a phantom reserved built-in)", async () => {
  // Regression: `redo` was listed in RESERVED_SLASH but had no built-in handler,
  // so a user's own /redo was rejected as "shadows a protected built-in" and then
  // "Unknown command" — permanently unusable. It must now just run.
  const commands = new CommandRegistry();
  commands.register({
    name: "redo",
    description: "custom redo",
    source: "file",
    run: () => ({ kind: "notice", message: "custom redo ran" }),
  });
  const engine = new Engine({
    config: defaultConfig(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-engine-redo-")),
    commands,
  });
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "redo", args: "" });
  await engine.whenIdle();
  stop();

  expect(events.some((e) => e.type === "notice" && e.message === "custom redo ran")).toBe(true);
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("shadows a protected")),
  ).toBe(false);
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("Unknown command")),
  ).toBe(false);
});

test("planModel restore never clobbers an explicit model choice (stale planModelPrev)", async () => {
  const engine = makeEngine({ ...defaultConfig(), model: "prov/A", planModel: "prov/P" });

  engine.send({ type: "set-mode", mode: "plan" }); // prev=A, model->P
  await engine.whenIdle();
  engine.send({ type: "run-slash", name: "model", args: "prov/B" }); // manual switch while planning
  await engine.whenIdle();
  engine.send({ type: "set-mode", mode: "execute" }); // B is not P: no restore
  await engine.whenIdle();
  engine.send({ type: "run-slash", name: "model", args: "prov/P" }); // EXPLICIT user choice: P
  await engine.whenIdle();
  engine.send({ type: "set-mode", mode: "plan" }); // already on P
  await engine.whenIdle();
  engine.send({ type: "set-mode", mode: "execute" }); // must NOT revert to stale A
  await engine.whenIdle();

  expect(engine.snapshot().model).toBe("prov/P");
});

test("resuming mid-plan does not strand execution on the planModel", async () => {
  // #planModelPrev is an engine field and is never persisted: a session saved
  // while planning has meta.model === planModel, so the restore path must fall
  // back to config.model when leaving plan after a resume.
  const now = Date.now();
  const engine = new Engine({
    config: { ...defaultConfig(), model: "prov/A", planModel: "prov/P" },
    cwd: mkdtempSync(join(tmpdir(), "vibe-engine-resume-plan-")),
    resume: {
      meta: { id: "s-plan-resume", model: "prov/P", mode: "plan", goal: null, createdAt: now, updatedAt: now },
      modelMessages: [],
      history: [],
    },
  });
  await engine.whenIdle();
  expect(engine.snapshot().model).toBe("prov/P"); // planning stays on the plan model

  engine.send({ type: "set-mode", mode: "execute" });
  await engine.whenIdle();
  expect(engine.snapshot().model).toBe("prov/A"); // execution restored from config
});

test("project-local skills and commands override plugin-registered ones (most-local-wins)", async () => {
  // Regression: plugins used to load AFTER the project dirs, so a plugin's
  // same-named skill/command silently beat `.vibe/skills/<name>` — the inverse
  // of the documented most-local-wins precedence.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-prec-"));
  mkdirSync(join(cwd, ".vibe", "skills", "foo"), { recursive: true });
  writeFileSync(
    join(cwd, ".vibe", "skills", "foo", "SKILL.md"),
    "---\nname: foo\ndescription: project foo\n---\nProject body.",
  );
  mkdirSync(join(cwd, ".vibe", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".vibe", "commands", "bar.md"), "project bar: $ARGS");

  const pluginDir = mkdtempSync(join(tmpdir(), "vibe-engine-prec-plugin-"));
  mkdirSync(join(pluginDir, "skills", "foo"), { recursive: true });
  writeFileSync(
    join(pluginDir, "skills", "foo", "SKILL.md"),
    "---\nname: foo\ndescription: plugin foo\n---\nPlugin body.",
  );
  const pluginPath = join(pluginDir, "plugin.ts");
  writeFileSync(
    pluginPath,
    `export function register(api) {
       api.addSkillDir(${JSON.stringify(join(pluginDir, "skills"))});
       api.registerCommand({
         name: "bar",
         description: "plugin bar",
         source: "plugin",
         run: () => ({ kind: "notice", message: "plugin bar" }),
       });
     }`,
  );

  const engine = new Engine({ config: { ...defaultConfig(), plugins: [pluginPath] }, cwd });
  await engine.bootstrap();
  expect(engine.skills.get("foo")?.description).toBe("project foo");
  // The project FILE command wins over the plugin's registration.
  expect(engine.commands.get("bar")?.source).toBe("file");
  expect(engine.commands.get("bar")?.run("x").kind).toBe("prompt");
});
