import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, defaultConfig, loadConfig } from "./index.ts";

test("defaultConfig is valid and carries the documented defaults", () => {
  const c = defaultConfig();
  expect(c.model).toBe("anthropic/claude-opus-4-8");
  expect(c.mode).toBe("execute");
  expect(c.approvalMode).toBe("ask");
  expect(c.maxSteps).toBe(64);
  expect(c.theme).toBe("default");
  // Nested defaults fill in too.
  expect(c.subagent.maxDepth).toBe(3);
  expect(c.verify.auto).toBe(false);
  expect(c.compaction.threshold).toBe(0.75);
  expect(c.retry.maxAttempts).toBe(2);
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
