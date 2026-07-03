import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, defaultConfig, loadConfig, writeGlobalConfig, globalConfigPath } from "./index.ts";

test("defaultConfig is valid and carries the documented defaults", () => {
  const c = defaultConfig();
  expect(c.model).toBe("anthropic/claude-opus-4-8");
  expect(c.mode).toBe("execute");
  expect(c.approvalMode).toBe("ask");
  expect(c.maxSteps).toBe(64);
  expect(c.theme).toBe("default");
  // Nested defaults fill in too.
  expect(c.subagent.maxDepth).toBe(3);
  expect(c.subagent.retainCompleted).toBe(16);
  expect(c.subagent.structuredMaxAttempts).toBe(2);
  expect(c.subagent.maxDetached).toBe(8); // == maxParallel's default
  expect(c.verify.auto).toBe(false);
  expect(c.compaction.threshold).toBe(0.75);
  expect(c.retry.maxAttempts).toBe(2);
  expect(c.update.check).toBe(true);
  // Sandbox ships OFF (opt-in) this release; network on, no extra writable paths.
  expect(c.sandbox.mode).toBe("off");
  expect(c.sandbox.network).toBe("on");
  expect(c.sandbox.writablePaths).toEqual([]);
  // Multi-language LSP diagnostics: on by default with the documented deadlines.
  expect(c.lsp.enabled).toBe(true);
  expect(c.lsp.timeoutMs).toBe(2000);
  expect(c.lsp.idleShutdownMs).toBe(300_000);
  expect(c.lsp.disabledLanguages).toEqual([]);
  expect(c.lsp.servers).toEqual({});
});

test("lsp accepts per-language overrides and a partial block fills defaults", () => {
  const r = ConfigSchema.safeParse({
    lsp: { timeoutMs: 500, disabledLanguages: ["go"], servers: { py: { command: "pyright-langserver", args: ["--stdio"] } } },
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.lsp.enabled).toBe(true); // default preserved under a partial block
    expect(r.data.lsp.timeoutMs).toBe(500);
    expect(r.data.lsp.idleShutdownMs).toBe(300_000); // default preserved
    expect(r.data.lsp.disabledLanguages).toEqual(["go"]);
    expect(r.data.lsp.servers.py?.command).toBe("pyright-langserver");
    expect(r.data.lsp.servers.py?.args).toEqual(["--stdio"]);
  }
});

test("the schema fills nested defaults under a partial object", () => {
  const r = ConfigSchema.safeParse({ model: "openai/gpt-x" });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.model).toBe("openai/gpt-x");
    expect(r.data.subagent.maxDepth).toBe(3); // default applied
    expect(r.data.approvalMode).toBe("ask"); // default applied
  }
});

test("invalid values are rejected with a descriptive issue", () => {
  const bad = ConfigSchema.safeParse({ mode: "nope", maxSteps: -5 });
  expect(bad.success).toBe(false);
  if (!bad.success) {
    const paths = bad.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("mode");
    expect(paths).toContain("maxSteps");
  }
});

test("loadConfig throws a ConfigError-style message on an invalid project file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cfg-"));
  await mkdir(join(cwd, ".vibe"), { recursive: true });
  await writeFile(join(cwd, ".vibe", "config.json"), JSON.stringify({ maxSteps: -1 }));
  await expect(loadConfig({ cwd })).rejects.toThrow(/Invalid configuration/);
});

test("loadConfig strips JSONC comments and applies CLI overrides last (highest precedence)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cfg-"));
  await mkdir(join(cwd, ".vibe"), { recursive: true });
  await writeFile(
    join(cwd, ".vibe", "config.json"),
    `{
      // project model
      "model": "deepseek/deepseek-chat",
      "maxSteps": 10
    }`,
  );
  // No override → project value wins (and comments parsed without error).
  const project = await loadConfig({ cwd });
  expect(project.model).toBe("deepseek/deepseek-chat");
  expect(project.maxSteps).toBe(10);
  // CLI override is applied last, so it beats the project file.
  const overridden = await loadConfig({ cwd, overrides: { model: "openai/gpt-x" } });
  expect(overridden.model).toBe("openai/gpt-x");
  expect(overridden.maxSteps).toBe(10); // untouched project value preserved
});

test("comment-stripping preserves // and /* */ inside string values", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cfg-"));
  await mkdir(join(cwd, ".vibe"), { recursive: true });
  await writeFile(
    join(cwd, ".vibe", "config.json"),
    `{
      // a real comment is stripped
      "providers": {
        "custom": { "baseURL": "https://api.example.com/v1" }
      },
      "theme": "a/*not a comment*/b",
      "model": "openai/gpt-x" /* trailing block comment */
    }`,
  );
  const cfg = await loadConfig({ cwd });
  // The // in the URL and the /* */ inside the theme string must survive; only
  // the genuine comments are removed.
  expect(cfg.providers.custom?.baseURL).toBe("https://api.example.com/v1");
  expect(cfg.theme).toBe("a/*not a comment*/b");
  expect(cfg.model).toBe("openai/gpt-x");
});

test("writeGlobalConfig deep-merges, and a null value clears a persisted key", async () => {
  // Point the global config at a throwaway dir so we never touch the real one.
  // Must use XDG_CONFIG_HOME, not HOME — Bun's os.homedir() caches at startup and
  // ignores a runtime HOME change, but globalConfigPath() reads XDG_CONFIG_HOME live.
  const dir = mkdtempSync(join(tmpdir(), "vibe-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    await writeGlobalConfig({
      model: "ollama/gpt-oss:120b",
      subagent: { model: "deepseek/deepseek-chat" },
      providers: { ollama: { apiKey: "k1" } },
    });
    let written = JSON.parse(await Bun.file(globalConfigPath()).text());
    expect(written.model).toBe("ollama/gpt-oss:120b");
    expect(written.subagent.model).toBe("deepseek/deepseek-chat");
    expect(written.providers.ollama.apiKey).toBe("k1");

    // A second write merges (doesn't clobber) and `null` removes the subagent model.
    await writeGlobalConfig({
      providers: { deepseek: { apiKey: "k2" } },
      subagent: { model: null },
    });
    written = JSON.parse(await Bun.file(globalConfigPath()).text());
    expect(written.model).toBe("ollama/gpt-oss:120b"); // untouched
    expect(written.providers.ollama.apiKey).toBe("k1"); // preserved
    expect(written.providers.deepseek.apiKey).toBe("k2"); // added
    expect(written.subagent.model).toBeUndefined(); // cleared
    // And the cleared result still validates (subagent.model is optional).
    expect(ConfigSchema.safeParse(written).success).toBe(true);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("writeGlobalConfig REJECTS an invalid patch instead of bricking future loads", async () => {
  // Regression: onboarding wrote unvalidated patches, so a custom baseURL typed
  // without a scheme (`localhost:1234`) persisted and every later `vibe` run then
  // threw ConfigError on load — a bricked CLI. The write must reject up front.
  const dir = mkdtempSync(join(tmpdir(), "vibe-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    await expect(
      writeGlobalConfig({ providers: { custom: { baseURL: "not a url" } } }),
    ).rejects.toThrow(/invalid configuration/i);
    // Nothing was persisted, so a subsequent load still succeeds on defaults.
    await expect(loadConfig({ cwd: dir })).resolves.toBeDefined();
    // A VALID baseURL still writes fine.
    await writeGlobalConfig({ providers: { custom: { baseURL: "https://api.example.com/v1" } } });
    const written = JSON.parse(await Bun.file(globalConfigPath()).text());
    expect(written.providers.custom.baseURL).toBe("https://api.example.com/v1");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("defaultConfig returns independent copies (no shared mutable defaults)", () => {
  const a = defaultConfig();
  const b = defaultConfig();
  // Distinct nested instances (Zod's object/array defaults are shared by ref).
  expect(a.webfetch.allowHosts).not.toBe(b.webfetch.allowHosts);
  expect(a.mcp.servers).not.toBe(b.mcp.servers);
  expect(a.providers).not.toBe(b.providers);
  expect(a.subagent).not.toBe(b.subagent);
  // Mutating one config (as the engine does — e.g. `/model key` writes providers)
  // must NOT leak into another config or a later defaultConfig().
  a.webfetch.allowHosts.push("evil.example.com");
  a.providers.openai = { apiKey: "leaked" };
  a.subagent.model = "mock/x";
  expect(b.webfetch.allowHosts).toEqual([]);
  expect(b.providers).toEqual({});
  expect(b.subagent.model).toBeUndefined();
  expect(defaultConfig().webfetch.allowHosts).toEqual([]);
});

test("concurrent writeGlobalConfig calls don't clobber each other (serialized RMW)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-xdg-race-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // Fire many distinct-key writes at once WITHOUT awaiting between them, exactly
    // as the engine's fire-and-forget #persistConfig does. Every key must survive.
    await Promise.all([
      writeGlobalConfig({ model: "a/one" }),
      writeGlobalConfig({ accentColor: "#111111" }),
      writeGlobalConfig({ theme: "opencode" }),
      writeGlobalConfig({ reasoning: { effort: "high" } }),
      writeGlobalConfig({ subagent: { model: "b/two" } }),
    ]);
    const written = JSON.parse(await Bun.file(globalConfigPath()).text());
    expect(written.model).toBe("a/one");
    expect(written.accentColor).toBe("#111111");
    expect(written.theme).toBe("opencode");
    expect(written.reasoning.effort).toBe("high");
    expect(written.subagent.model).toBe("b/two");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("compaction rejects offload.threshold >= threshold (the layering must hold)", () => {
  // offload (lossless) must fire BELOW the summary (lossy) threshold; inverting
  // them silently summarizes before ever offloading.
  const bad = ConfigSchema.safeParse({
    compaction: { threshold: 0.75, offload: { threshold: 0.9 } },
  });
  expect(bad.success).toBe(false);

  const ok = ConfigSchema.safeParse({
    compaction: { threshold: 0.75, offload: { threshold: 0.6 } },
  });
  expect(ok.success).toBe(true);
  if (ok.success) expect(ok.data.compaction.offload.maxArtifactBytes).toBe(64 * 1024 * 1024);
});
