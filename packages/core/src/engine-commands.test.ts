import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { ACCENT_PRESETS, THEME_NAMES } from "@vibe/shared";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

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
