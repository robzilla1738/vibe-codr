import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We test the pure merge logic and the JSONC parsing helpers indirectly
// through readConfigFile / writeConfigFile.

// The functions under test use process.env.XDG_CONFIG_HOME and os.homedir,
// but we test the project-scoped paths which take an explicit cwd.

// Import after setting up the module — we need to dynamically import because
// the module uses node:fs which works in vitest.
const { readConfigFile, writeConfigFile, projectConfigPath } = await import("./config-io");

describe("config-io", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vibe-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("projectConfigPath", () => {
    it("returns .vibe/config.json under the cwd", () => {
      expect(projectConfigPath("/my/project")).toBe("/my/project/.vibe/config.json");
    });
  });

  describe("readConfigFile", () => {
    it("returns null when the file does not exist", async () => {
      const result = await readConfigFile(join(tmpDir, "missing.json"));
      expect(result).toBeNull();
    });

    it("reads plain JSON", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ model: "openai/gpt-5.5", mode: "plan" }));
      const result = await readConfigFile(path);
      expect(result).not.toBeNull();
      expect(result!.config.model).toBe("openai/gpt-5.5");
      expect(result!.config.mode).toBe("plan");
    });

    it("reads JSONC with line comments", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, `{
        // This is a comment
        "model": "anthropic/claude-opus-4-8",
        "mode": "execute" // inline comment
      }`);
      const result = await readConfigFile(path);
      expect(result).not.toBeNull();
      expect(result!.config.model).toBe("anthropic/claude-opus-4-8");
    });

    it("reads JSONC with block comments", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, `{
        /* block comment */
        "model": "ollama/llama3.3"
      }`);
      const result = await readConfigFile(path);
      expect(result).not.toBeNull();
      expect(result!.config.model).toBe("ollama/llama3.3");
    });

    it("reads JSONC with trailing commas", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, `{
        "model": "openai/gpt-5.5",
        "mode": "plan",
      }`);
      const result = await readConfigFile(path);
      expect(result).not.toBeNull();
      expect(result!.config.model).toBe("openai/gpt-5.5");
      expect(result!.config.mode).toBe("plan");
    });

    it("preserves strings that contain // (URLs)", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, `{
        "providers": {
          "ollama": { "baseURL": "http://localhost:11434" }
        }
      }`);
      const result = await readConfigFile(path);
      expect(result).not.toBeNull();
      expect(result!.config.providers?.ollama?.baseURL).toBe("http://localhost:11434");
    });
  });

  describe("writeConfigFile", () => {
    it("creates a new file with the patch", async () => {
      const path = join(tmpDir, "config.json");
      await writeConfigFile(path, { model: "openai/gpt-5.5" });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.model).toBe("openai/gpt-5.5");
    });

    it("merges into an existing file (deep merge)", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ model: "openai/gpt-5.5", mode: "plan", subagent: { maxDepth: 3 } }));
      await writeConfigFile(path, { mode: "execute", subagent: { maxParallel: 8 } });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.model).toBe("openai/gpt-5.5"); // preserved
      expect(parsed.mode).toBe("execute"); // overwritten
      expect(parsed.subagent.maxDepth).toBe(3); // preserved (deep merge)
      expect(parsed.subagent.maxParallel).toBe(8); // added
    });

    it("deletes a key when the patch value is null", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ model: "openai/gpt-5.5", planModel: "openai/o3" }));
      await writeConfigFile(path, { planModel: null });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.model).toBe("openai/gpt-5.5");
      expect(parsed.planModel).toBeUndefined();
    });

    it("skips undefined values in the patch", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ model: "openai/gpt-5.5" }));
      await writeConfigFile(path, { model: undefined, mode: "execute" });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.model).toBe("openai/gpt-5.5"); // preserved (undefined is no-op)
      expect(parsed.mode).toBe("execute");
    });

    it("creates parent directories", async () => {
      const path = join(tmpDir, "nested", "dir", "config.json");
      await writeConfigFile(path, { model: "openai/gpt-5.5" });
      expect(existsSync(path)).toBe(true);
    });

    it("overwrites arrays, not concatenates", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ modelFallbacks: ["a", "b"] }));
      await writeConfigFile(path, { modelFallbacks: ["c"] });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.modelFallbacks).toEqual(["c"]);
    });
  });

  describe("writeConfigFile concurrency", () => {
    it("serializes concurrent writes so neither clobbers the other", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, JSON.stringify({ model: "a", a: 1, b: 1 }));
      // Two overlapping writes — each reads-then-writes. Without serialization
      // the second write would read the pre-first-write state and clobber a.
      await Promise.all([
        writeConfigFile(path, { a: 11 }),
        writeConfigFile(path, { b: 22 }),
      ]);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.a).toBe(11);
      expect(parsed.b).toBe(22);
      expect(parsed.model).toBe("a");
    });
  });

  describe("writeConfigFile atomicity", () => {
    it("does not leave a temp file on success", async () => {
      const path = join(tmpDir, "nested", "config.json");
      await writeConfigFile(path, { model: "x" });
      const dir = join(tmpDir, "nested");
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(dir);
      expect(files).toEqual(["config.json"]);
    });

    it("strips the security-notices key before writing", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ model: "a", __vibeSecurityNotices: ["warn"] }),
      );
      await writeConfigFile(path, { mode: "plan" });
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.__vibeSecurityNotices).toBeUndefined();
      expect(parsed.model).toBe("a");
      expect(parsed.mode).toBe("plan");
    });

    it("refuses to write over a corrupt on-disk config (no wipe)", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(path, "{ not valid json !!!");
      await expect(writeConfigFile(path, { model: "should-not-land" })).rejects.toThrow();
      const raw = await readFile(path, "utf8");
      expect(raw).toContain("not valid json");
      expect(raw).not.toContain("should-not-land");
    });

    it("rejects a non-object patch", async () => {
      const path = join(tmpDir, "config.json");
      await expect(
        writeConfigFile(path, null as unknown as Record<string, unknown>),
      ).rejects.toThrow(/plain object/);
    });

    it("rejects reserved record keys instead of silently dropping them", async () => {
      const path = join(tmpDir, "config.json");
      const patch = JSON.parse(
        '{"providers":{"__proto__":{"apiKey":"secret"}}}',
      ) as Record<string, unknown>;
      await expect(writeConfigFile(path, patch)).rejects.toThrow(
        /reserved key providers\.__proto__/,
      );
      expect(existsSync(path)).toBe(false);
    });

    it("refuses to load an on-disk config containing reserved record keys", async () => {
      const path = join(tmpDir, "config.json");
      await writeFile(
        path,
        '{"mcp":{"servers":{"constructor":{"command":"node"}}}}',
      );
      await expect(readConfigFile(path)).rejects.toThrow(
        /reserved key mcp\.servers\.constructor/,
      );
    });

    it("writeConfigFileValidated rejects invalid merged config under the lock", async () => {
      const { writeConfigFileValidated } = await import("./config-io");
      const path = join(tmpDir, "validated.json");
      const res = await writeConfigFileValidated(
        path,
        { maxSteps: -1 },
        (merged) => (typeof merged.maxSteps === "number" && merged.maxSteps < 1 ? ["maxSteps: must be ≥ 1"] : []),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/maxSteps/);
      // Must not have written an invalid file
      expect(existsSync(path)).toBe(false);
    });

    it("writeConfigFileValidated reports reserved keys without writing", async () => {
      const { writeConfigFileValidated } = await import("./config-io");
      const path = join(tmpDir, "validated-reserved.json");
      const patch = JSON.parse(
        '{"pricing":{"prototype":{"input":1}}}',
      ) as Record<string, unknown>;
      const res = await writeConfigFileValidated(path, patch, () => []);
      expect(res).toEqual({
        ok: false,
        error: "Config patch contains reserved key pricing.prototype",
      });
      expect(existsSync(path)).toBe(false);
    });

    it("writeMemoryFile rejects oversize content", async () => {
      const { writeMemoryFile, MEMORY_MAX_BYTES } = await import("./config-io");
      const path = join(tmpDir, "VIBE.md");
      const huge = "x".repeat(MEMORY_MAX_BYTES + 10);
      await expect(writeMemoryFile(path, huge)).rejects.toThrow(/exceeds/);
    });

    it("rejects a config larger than the read ceiling", async () => {
      const { CONFIG_MAX_WRITE_BYTES } = await import("./config-io");
      const path = join(tmpDir, "oversize.json");
      await expect(
        writeConfigFile(path, { model: "x".repeat(CONFIG_MAX_WRITE_BYTES) }),
      ).rejects.toThrow(/exceeds/);
      expect(existsSync(path)).toBe(false);
    });

    it("writes secret-bearing config with mode 0o600 when platform supports chmod", async () => {
      const { writeConfigFile } = await import("./config-io");
      const { stat } = await import("node:fs/promises");
      const path = join(tmpDir, "secret-mode.json");
      await writeConfigFile(path, { model: "x" });
      const st = await stat(path);
      // On Unix, mode should be owner-only. Windows may report differently — accept owner-readable.
      if (process.platform !== "win32") {
        expect(st.mode & 0o777).toBe(0o600);
      }
    });
  });
});
