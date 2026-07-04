import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { ACCENT_PRESETS, THEME_NAMES } from "@vibe/shared";
import { defaultConfig } from "@vibe/config";
import type { Skill } from "@vibe/plugins";
import { Engine } from "./engine.ts";
import { buildSkillPrompt } from "./engine-commands.ts";

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
