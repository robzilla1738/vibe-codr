import { test, expect } from "bun:test";
import { z } from "zod";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Machine state (sessions, offload artifacts) goes to the per-project GLOBAL
// state dir — pin it to a temp root so tests never touch ~/.vibe/state.
process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { RepoProfile, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { Engine } from "./engine.ts";

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({ chunks }),
  };
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const textStep = (text: string) =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);

const profile = (commands: RepoProfile["commands"]): RepoProfile => ({
  greenfield: false,
  primaryLanguage: "TypeScript",
  packageManager: "bun",
  framework: null,
  commands,
  monorepo: { tool: null, packages: [] },
  git: { isRepo: true, branch: "main", dirty: false },
  conventions: ["tests via bun test"],
  manifestFiles: ["package.json"],
});

test("engine bootstrap recon: detects real commands, fills verify.command, injects REPO FACTS", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-recon-e2e-"));
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { typecheck: "tsc --noEmit", test: "vitest run", dev: "vite --watch" },
      devDependencies: { typescript: "^5" },
    }),
  );
  writeFileSync(join(cwd, "bun.lock"), "");
  writeFileSync(join(cwd, "src.ts"), "export function fixture() {}\n");

  const systems: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const prompt = (options as { prompt: { role: string; content: unknown }[] }).prompt;
      const sys = prompt.find((m) => m.role === "system");
      systems.push(typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? ""));
      return textStep("ok") as never;
    },
  });
  const config = defaultConfig();
  config.model = "mock/test";
  const engine = new Engine({ config, cwd, registry: mockRegistry(model) });
  await engine.bootstrap();

  // Recon filled verify.command from the detected (watch-script-rejecting) commands.
  expect(config.verify.command).toBe("bun run typecheck && bun run test");

  engine.send({ type: "submit-prompt", text: "hello" });
  await engine.whenIdle();
  expect(systems[0]).toContain("REPO FACTS");
  expect(systems[0]).toContain("bun run typecheck");
  expect(systems[0]).toContain("never invent or guess a build/test command");
});

test("run_check: offered only in execute mode with detected commands; parses PASS/FAIL", async () => {
  const toolNames: string[][] = [];
  const steps = [
    // Turn 1: call run_check(test); turn 1 step 2: finish.
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "run_check", input: JSON.stringify({ check: "test" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("done"),
    // Turn 2 (plan mode): just text.
    textStep("planned"),
  ];
  let call = 0;
  const outputs: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const o = options as { tools?: { name: string }[]; prompt: { role: string; content: unknown }[] };
      toolNames.push((o.tools ?? []).map((t) => t.name));
      for (const m of o.prompt) {
        if (m.role === "tool") outputs.push(JSON.stringify(m.content));
      }
      return steps[call++] as never;
    },
  });
  const config = defaultConfig();
  config.approvalMode = "auto"; // run_check is side-effecting; skip the gate in tests
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-runcheck-")),
    model: "mock/test",
    mode: "execute",
    repoProfile: profile({ test: "echo ' 5 pass'; echo ' 0 fail'" }),
  });
  await session.run("verify the tree");
  expect(toolNames[0]).toContain("run_check");
  // The tool result the model saw is the parsed verdict, not raw output.
  expect(outputs.join("")).toContain("PASS test");

  // Plan mode: run_check is absent (running builds/tests mutates the workspace).
  session.setMode("plan");
  await session.run("plan something");
  expect(toolNames.at(-1)).not.toContain("run_check");
});

test("run_check on an undetected command errors with the detected list", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "run_check", input: JSON.stringify({ check: "lint" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("done"),
  ];
  let call = 0;
  const outputs: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const o = options as { prompt: { role: string; content: unknown }[] };
      for (const m of o.prompt) if (m.role === "tool") outputs.push(JSON.stringify(m.content));
      return steps[call++] as never;
    },
  });
  const config = defaultConfig();
  config.approvalMode = "auto";
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-runcheck2-")),
    model: "mock/test",
    mode: "execute",
    repoProfile: profile({ test: "bun test" }),
  });
  await session.run("lint it");
  expect(outputs.join("")).toContain("No lint command was detected");
  expect(outputs.join("")).toContain("detected: test");
});

test("subagent forks inherit the repo profile and get the symbol map injected", async () => {
  const systems: string[] = [];
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "spawn_subagent", input: JSON.stringify({ prompt: "scout the code" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("child done"), // the child's turn
    textStep("parent done"),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const prompt = (options as { prompt: { role: string; content: unknown }[] }).prompt;
      const sys = prompt.find((m) => m.role === "system");
      systems.push(typeof sys?.content === "string" ? sys.content : "");
      return steps[call++] as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: mkdtempSync(join(tmpdir(), "vibe-fork-map-")),
    model: "mock/test",
    mode: "execute",
    repoProfile: profile({ test: "bun test" }),
    repoMap: "src/index.ts\n  export function main()",
  });
  await session.run("go");
  // Call 2 is the child: it carries the symbol map AND the inherited repo facts.
  expect(systems[1]).toContain("REPO SYMBOL MAP");
  expect(systems[1]).toContain("export function main()");
  expect(systems[1]).toContain("REPO FACTS");
  // The parent does NOT carry the map block (it's kickoff context for children).
  expect(systems[0]).not.toContain("REPO SYMBOL MAP");
});

test("an edit that breaks the types surfaces TS diagnostics in the SAME tool result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-diag-e2e-"));
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
  );
  writeFileSync(join(cwd, "app.ts"), "export const version: number = 1;\n");

  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "e1",
        toolName: "edit",
        input: JSON.stringify({ path: "app.ts", oldString: "= 1;", newString: '= "one";' }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    textStep("done"),
  ];
  let call = 0;
  const outputs: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const o = options as { prompt: { role: string; content: unknown }[] };
      for (const m of o.prompt) if (m.role === "tool") outputs.push(JSON.stringify(m.content));
      return steps[call++] as never;
    },
  });
  const config = defaultConfig();
  config.model = "mock/test";
  config.approvalMode = "auto";
  const engine = new Engine({ config, cwd, registry: mockRegistry(model) });
  engine.send({ type: "submit-prompt", text: "break the types" });
  await engine.whenIdle();

  const toolOut = outputs.join("");
  expect(toolOut).toContain("Edited app.ts");
  expect(toolOut).toContain("TypeScript diagnostics");
  expect(toolOut).toContain("TS2322");
});

test("mid-turn microcompaction: older bulky results are offloaded, previewed, and retrievable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-offload-"));
  const BLOB = "L".repeat(30_000);
  const bigTool = {
    name: "big_read",
    description: "returns a huge blob",
    inputSchema: z.object({ path: z.string() }),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => ({ output: BLOB }),
  } as unknown as ToolDefinition;

  const toolCall = (id: string, path: string) =>
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: id, toolName: "big_read", input: JSON.stringify({ path }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]);
  const prompts: string[] = [];
  const steps = [toolCall("big1", "a.txt"), toolCall("big2", "b.txt"), textStep("done reading")];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      prompts.push(JSON.stringify((options as { prompt: unknown }).prompt));
      return steps[call++] as never;
    },
  });
  const config = defaultConfig();
  // Protect only the single most recent result so the FIRST bulky read becomes
  // offloadable once the second lands (the default of 2 would shield both here).
  config.compaction.offload.keepLiveResults = 1;
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([bigTool]),
    bus: new EventBus(),
    cwd,
    model: "mock/test",
    mode: "execute",
    // Tiny window: 0.6 * 8000 = 4800-token offload threshold; two 30k-char
    // results (~15k tokens) trip it before step 3.
    getContextWindow: async () => 8_000,
  });
  await session.run("read both huge files");

  // Step 3's prompt: the OLD result is a preview note; the fresh one is intact.
  const step3 = prompts[2]!;
  expect(step3).toContain("saved to");
  const blobCount = step3.split(BLOB).length - 1;
  expect(blobCount).toBe(1); // big2 stays whole, big1 is previewed
  // The artifact holds the FULL text, retrievable via the read tool. Offload
  // artifacts live in the project's GLOBAL state dir now, recorded as an
  // ABSOLUTE path (so the pointer resolves regardless of cwd).
  const abs = /\/[^"\\]*tool-results[^"\\]+\.txt/.exec(step3)?.[0];
  expect(abs).toBeDefined();
  expect(await Bun.file(abs!).text()).toBe(BLOB);
  // The DURABLE history (what persists + feeds the next turn) carries the
  // preview too — the ephemeral prepareStep edit was folded in at end-of-turn.
  expect(session.contextTokens).toBeLessThan(12_000);
});
