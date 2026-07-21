import { describe, expect, it } from "vitest";
import { validateConfig } from "./config-validate";

describe("validateConfig", () => {
  it("accepts an empty config", () => {
    expect(validateConfig({})).toEqual([]);
  });

  it("accepts a valid config", () => {
    expect(
      validateConfig({
        model: "openai/gpt-5.5",
        mode: "execute",
        maxSteps: 64,
        goal: { assessorModel: "openai/gpt-5.5", checklessCompletion: "pause" },
        providers: { openai: { apiKey: "sk-1", baseURL: "https://api.openai.com/v1" } },
      }),
    ).toEqual([]);
  });

  it("rejects a provider baseURL without a scheme", () => {
    const errs = validateConfig({ providers: { openai: { baseURL: "localhost:1234" } } });
    expect(errs.some((e) => e.includes("providers.openai.baseURL"))).toBe(true);
  });

  it("rejects an empty provider baseURL instead of persisting an engine-invalid value", () => {
    const errors = validateConfig({ providers: { openai: { baseURL: "" } } });
    expect(errors.some((error) => error.includes("providers.openai.baseURL"))).toBe(true);
  });

  it("rejects an MCP url without a host", () => {
    const errs = validateConfig({ mcp: { servers: { myserver: { url: "http://" } } } });
    expect(errs.some((e) => e.includes("mcp.servers.myserver.url"))).toBe(true);
  });

  it("accepts an MCP url with env-var reference", () => {
    expect(validateConfig({ mcp: { servers: { s: { url: "$" + "{MCP_URL}" } } } })).toEqual([]);
    expect(validateConfig({ mcp: { servers: { s: { url: "$" + "{MCP_URL:-https://localhost:3000/mcp}" } } } })).toEqual([]);
  });

  it("rejects malformed MCP env references across connection fields", () => {
    const dollar = "$";
    const errors = validateConfig({
      mcp: {
        servers: {
          remote: {
            url: `https://${dollar}{GOOD}/${dollar}{BAD-NAME}`,
            headers: { Authorization: `Bearer ${dollar}{TOKEN` },
          },
          local: {
            command: `${dollar}{9INVALID}/server`,
            args: ["--token", `${dollar}{TOKEN`],
            env: { API_KEY: `${dollar}{KEY-NAME}` },
            enabled: false,
          },
        },
      },
    });
    for (const path of [
      "mcp.servers.remote.url",
      "mcp.servers.remote.headers.Authorization",
      "mcp.servers.local.command",
      "mcp.servers.local.args[1]",
      "mcp.servers.local.env.API_KEY",
    ]) {
      expect(errors.some((error) => error.includes(path)), path).toBe(true);
    }
  });

  it("rejects a hook with neither command nor url", () => {
    const errs = validateConfig({ hooks: [{ event: "session.start" }] });
    expect(errs.some((e) => e.includes("hooks[0]"))).toBe(true);
  });

  it("rejects a hook with a non-http url", () => {
    const errs = validateConfig({ hooks: [{ event: "session.start", url: "ftp://x" }] });
    expect(errs.some((e) => e.includes("hooks[0].url"))).toBe(true);
  });

  it("rejects maxSteps below 1", () => {
    const errs = validateConfig({ maxSteps: 0 });
    expect(errs.some((e) => e.includes("maxSteps"))).toBe(true);
  });

  it("rejects NaN maxSteps", () => {
    const errs = validateConfig({ maxSteps: NaN });
    expect(errs.some((e) => e.includes("maxSteps"))).toBe(true);
  });

  it("rejects an invalid mode enum", () => {
    const errs = validateConfig({ mode: "yolo" });
    expect(errs.some((e) => e.includes("mode"))).toBe(true);
  });

  it("rejects an invalid approvalMode enum", () => {
    const errs = validateConfig({ approvalMode: "always" });
    expect(errs.some((e) => e.includes("approvalMode"))).toBe(true);
  });

  it("mirrors the engine trace policy without allowing raw content", () => {
    expect(validateConfig({ trace: { enabled: true, content: "redacted" } })).toEqual([]);
    expect(validateConfig({ trace: { content: "raw" } }).some((error) => error.includes("trace.content"))).toBe(true);
  });

  it("rejects compaction threshold out of range", () => {
    const errs = validateConfig({ compaction: { threshold: 1.5 } });
    expect(errs.some((e) => e.includes("compaction.threshold"))).toBe(true);
  });

  it("rejects malformed or duplicate plugin module specifiers", () => {
    const errs = validateConfig({ plugins: ["plugin-a", "plugin-a", " padded ", ""] });
    expect(errs.some((e) => e.includes("plugins[1]") && e.includes("duplicates"))).toBe(true);
    expect(errs.some((e) => e.includes("plugins[2]") && e.includes("whitespace"))).toBe(true);
    expect(errs.some((e) => e.includes("plugins[3]") && e.includes("empty"))).toBe(true);
  });

  it("rejects an invalid build gate check", () => {
    const errs = validateConfig({ build: { gate: { checks: ["typecheck", "invalid"] } } });
    expect(errs.some((e) => e.includes("build.gate.checks"))).toBe(true);
  });

  it("accepts valid build gate checks", () => {
    expect(validateConfig({ build: { gate: { checks: ["typecheck", "test", "build"] } } })).toEqual([]);
  });

  it("rejects enabled stdio MCP servers without a command", () => {
    const errs = validateConfig({
      mcp: { servers: { fs: { command: "", args: [] } } },
    });
    expect(errs.some((e) => e.includes("mcp.servers.fs.command"))).toBe(true);
  });

  it("allows disabled stdio MCP servers with empty command", () => {
    expect(
      validateConfig({
        mcp: { servers: { fs: { command: "", args: [], enabled: false } } },
      }),
    ).toEqual([]);
  });

  it("rejects MCP records that do not match exactly one transport", () => {
    const missingCommand = validateConfig({
      mcp: { servers: { local: { enabled: false } } },
    });
    expect(missingCommand.some((error) => error.includes("mcp.servers.local.command"))).toBe(true);

    const nullUrl = validateConfig({
      mcp: { servers: { remote: { url: null, enabled: false } } },
    });
    expect(nullUrl.some((error) => error.includes("mcp.servers.remote.url"))).toBe(true);

    const ambiguous = validateConfig({
      mcp: { servers: { mixed: { command: "node", url: "https://example.com/mcp" } } },
    });
    expect(ambiguous.some((error) => error.includes("exactly one transport"))).toBe(true);
  });

  it("rejects enabled remote MCP servers without a url", () => {
    const errs = validateConfig({
      mcp: { servers: { remote: { url: "" } } },
    });
    expect(errs.some((e) => e.includes("mcp.servers.remote.url"))).toBe(true);
  });

  it("rejects invalid remote MCP URLs even while the server is disabled", () => {
    const errs = validateConfig({
      mcp: { servers: { remote: { url: "", enabled: false } } },
    });
    expect(errs.some((e) => e.includes("mcp.servers.remote.url"))).toBe(true);
  });

  it("validates nested remote MCP OAuth settings", () => {
    const errs = validateConfig({
      mcp: {
        servers: {
          remote: {
            url: "https://example.com/mcp",
            oauth: { scopes: "read", redirectUri: "ftp://example.com/callback" },
          },
        },
      },
    });
    expect(errs.some((e) => e.includes("oauth.scopes"))).toBe(true);
    expect(errs.some((e) => e.includes("oauth.redirectUri"))).toBe(true);
  });

  it("rejects malformed colors, environment names, and HTTP header names", () => {
    const errors = validateConfig({
      accentColor: "purple",
      providers: { openai: { headers: { "Bad Header": "value" } } },
      mcp: {
        servers: {
          local: { command: "node", env: { "BAD=NAME": "value" } },
          remote: { url: "https://example.com/mcp", headers: { "Bad Header": "value" } },
        },
      },
    });
    for (const path of ["accentColor", "providers.openai.headers", "mcp.servers.local.env", "mcp.servers.remote.headers"]) {
      expect(errors.some((error) => error.includes(path))).toBe(true);
    }
  });

  it("rejects header injection and NUL-bearing process fields before persistence", () => {
    const errors = validateConfig({
      providers: {
        openai: {
          apiKey: "secret\r\nX-Injected: true",
          headers: { Authorization: "Bearer token\nX-Injected: true" },
          tokenFile: "/tmp/token\0.json",
        },
      },
      mcp: {
        servers: {
          local: {
            command: "node\0evil",
            args: ["server.js\0extra"],
            env: { API_KEY: "secret\0tail" },
            cwd: "/tmp/project\0other",
          },
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token\rmalformed" },
            oauth: { tokenStore: "/tmp/tokens\0.json" },
          },
        },
      },
      hooks: [{ event: "session.start", command: "node hook.js\0extra" }],
      verify: { command: "npm test\0extra" },
      lsp: { servers: { ts: { command: "typescript-language-server\0bad" } } },
      sandbox: { writablePaths: ["/tmp/cache\0outside"] },
    });

    for (const path of [
      "providers.openai.apiKey",
      "providers.openai.headers.Authorization",
      "providers.openai.tokenFile",
      "mcp.servers.local.command",
      "mcp.servers.local.args[0]",
      "mcp.servers.local.env.API_KEY",
      "mcp.servers.local.cwd",
      "mcp.servers.remote.headers.Authorization",
      "mcp.servers.remote.oauth.tokenStore",
      "hooks[0].command",
      "verify.command",
      "lsp.servers.ts.command",
      "sandbox.writablePaths[0]",
    ]) {
      expect(errors.some((error) => error.includes(path)), path).toBe(true);
    }
  });

  it("rejects relative sandbox writable paths", () => {
    const errors = validateConfig({ sandbox: { writablePaths: ["build/cache", "/tmp/cache"] } });
    expect(errors.some((error) => error.includes("sandbox.writablePaths[0]"))).toBe(true);
  });

  it.each([
    [{ budget: { limitUSD: 0 } }, "budget.limitUSD"],
    [{ goal: { maxRounds: 0 } }, "goal.maxRounds"],
    [{ goal: { maxRounds: 101 } }, "goal.maxRounds"],
    [{ goal: { assessorModel: "" } }, "goal.assessorModel"],
    [{ goal: { checklessCompletion: "verify" } }, "goal.checklessCompletion"],
    [{ loop: { defaultMax: 1001 } }, "loop.defaultMax"],
    [{ loop: { maxUntilEvalFailures: 0 } }, "loop.maxUntilEvalFailures"],
    [{ retry: { maxAttempts: 11 } }, "retry.maxAttempts"],
    [{ retry: { baseDelayMs: 60_001 } }, "retry.baseDelayMs"],
    [{ mcp: { servers: { remote: { url: "https://example.com", timeoutMs: 0 } } } }, "mcp.servers.remote.timeoutMs"],
    [{ reasoning: { budgetTokens: 0 } }, "reasoning.budgetTokens"],
    [{ itemTimeoutMs: -1 }, "itemTimeoutMs"],
    [{ build: { gate: { maxRounds: 11 } } }, "build.gate.maxRounds"],
    [{ build: { review: { maxRounds: 6 } } }, "build.review.maxRounds"],
    [{ verify: { maxRetries: 11 } }, "verify.maxRetries"],
    [{ contextWindow: { "custom/model": 0 } }, "contextWindow.custom/model"],
  ] as const)("rejects authoritative engine-schema mismatch %#", (config, path) => {
    expect(validateConfig(config as Record<string, unknown>).some((error) => error.includes(path))).toBe(true);
  });

  it("rejects wrong structural types instead of silently accepting them", () => {
    const errors = validateConfig({
      plugins: "plugin-a",
      memory: { semantic: { enabled: "yes" } },
      caching: { cacheTools: 1 },
      providers: { openai: "invalid" },
      permissions: {},
    });
    for (const path of ["plugins", "memory.semantic.enabled", "caching.cacheTools", "providers.openai", "permissions"]) {
      expect(errors.some((error) => error.includes(path))).toBe(true);
    }
  });

  it("requires permission actions and hook events", () => {
    const errors = validateConfig({
      permissions: [{ tool: "bash" }],
      hooks: [{ command: "node hook.js" }],
    });
    expect(errors.some((error) => error.includes("permissions[0].action"))).toBe(true);
    expect(errors.some((error) => error.includes("hooks[0].event"))).toBe(true);
  });

  it("rejects ambiguous or inert permission rules", () => {
    const errors = validateConfig({
      permissions: [
        { tool: "", action: "ask" },
        { tool: "bash", match: "git *", matchExact: "git status", action: "allow" },
      ],
    });
    expect(errors.some((error) => error.includes("permissions[0].tool"))).toBe(true);
    expect(errors.some((error) => error.includes("permissions[1]") && error.includes("mutually exclusive"))).toBe(true);
  });
});
