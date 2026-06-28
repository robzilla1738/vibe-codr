/**
 * Dev-only: generate faithful PNG screenshots of the vibe-codr TUI.
 *
 * Drives the REAL engine/session with a scripted MockLanguageModelV2 to produce
 * genuine UIEvent streams (real tools run for real — edits in temp dirs, real
 * git in a temp repo), reduces them into display lines (mirroring the OpenTUI
 * app in packages/tui/src/app.tsx), renders a terminal-styled HTML frame, and
 * screenshots it with the bundled Playwright Chromium.
 *
 * Run: bun packages/core/scripts/screenshot.ts <outDir>
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { LanguageModel } from "ai";
import type {
  UIEvent,
  ToolDefinition,
  Task,
  QueuedItem,
  SessionUsage,
} from "@vibe/shared";
import { ProviderRegistry, type ModelInfo } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig, type Config } from "@vibe/config";
import { Session } from "../src/session.ts";
import { Engine } from "../src/engine.ts";
import { EventBus } from "../src/event-bus.ts";
import { SessionStore } from "../src/store.ts";
import { formatModelList } from "../src/commands.ts";

/** Resolve the bundled Chromium, tolerating a different build number. */
function resolveChrome(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const hard = join(root, "chromium-1194", "chrome-linux", "chrome");
  if (existsSync(hard)) return hard;
  try {
    const dir = readdirSync(root).find(
      (d) => d.startsWith("chromium-") && !d.includes("headless"),
    );
    if (dir) {
      const p = join(root, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  } catch {
    /* fall through */
  }
  return hard;
}
const CHROME = resolveChrome();

// ── Tokyo-night palette (matches packages/tui colors) ──────────────────────
const COLORS = {
  bg: "#1a1b26",
  bgDim: "#16161e",
  fg: "#c0caf5",
  dim: "#565f89",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  yellow: "#e0af68",
  magenta: "#bb9af7",
  red: "#f7768e",
};

type LineKind =
  | "user"
  | "assistant"
  | "tool"
  | "toolresult"
  | "notice"
  | "subagent"
  | "add"
  | "del"
  | "ctx"
  | "plain";

interface Line {
  kind: LineKind;
  text: string;
}

interface PlanBlock {
  title: string;
  body: string[];
  hint: string;
}

interface Scene {
  name: string;
  status: string;
  cwd: string;
  lines: Line[];
  plan?: PlanBlock;
  tasks?: Task[];
  queued?: QueuedItem[];
  usage?: SessionUsage;
  input: string;
  inputHint?: string;
}

interface Reduced {
  lines: Line[];
  plan?: PlanBlock;
  tasks?: Task[];
  queued?: QueuedItem[];
  usage?: SessionUsage;
  context?: { usedTokens: number; contextWindow: number };
}

// ── Event -> display-line reducer (mirrors app.tsx onMount handler) ─────────
function reduce(events: UIEvent[]): Reduced {
  const lines: Line[] = [];
  let plan: PlanBlock | undefined;
  let tasks: Task[] | undefined;
  let queued: QueuedItem[] = [];
  let usage: SessionUsage | undefined;
  let context: { usedTokens: number; contextWindow: number } | undefined;
  let assistant: Line | null = null;
  // edit/write return their diff as text too; skip that echo since the
  // file-changed event already rendered it.
  let suppressResult = false;
  const pushText = (delta: string) => {
    if (!assistant) {
      assistant = { kind: "assistant", text: "" };
      lines.push(assistant);
    }
    assistant.text += delta;
  };
  for (const e of events) {
    switch (e.type) {
      case "user-message":
        lines.push({ kind: "user", text: e.text });
        assistant = null;
        break;
      case "assistant-text-delta":
        pushText(e.delta);
        break;
      case "tool-call-started":
        lines.push({
          kind: "tool",
          text: `⚒ ${e.toolName} ${truncate(JSON.stringify(e.input ?? {}), 64)}`,
        });
        assistant = null;
        break;
      case "tool-call-finished": {
        if (suppressResult) {
          suppressResult = false;
          break;
        }
        const out =
          typeof e.output === "string" ? e.output : JSON.stringify(e.output);
        for (const t of firstLines(out, 4)) {
          lines.push({ kind: "toolresult", text: `  ↳ ${truncate(t, 72)}` });
        }
        break;
      }
      case "file-changed": {
        suppressResult = true;
        const verb = e.action === "write" ? "wrote" : "edited";
        lines.push({ kind: "tool", text: `✎ ${verb} ${e.path}  +${e.added} -${e.removed}` });
        for (const dl of e.diff ? e.diff.split("\n") : []) {
          const kind: LineKind = dl.startsWith("+") ? "add" : dl.startsWith("-") ? "del" : "ctx";
          lines.push({ kind, text: dl });
        }
        assistant = null;
        break;
      }
      case "permission-request":
        lines.push({
          kind: "notice",
          text: `⚠ allow ${e.toolName}? ${truncate(JSON.stringify(e.input ?? {}), 52)}`,
        });
        lines.push({ kind: "notice", text: "  [y]es · [a]lways · [n]o" });
        break;
      case "subagent-started":
        lines.push({ kind: "subagent", text: `⤷ subagent: ${truncate(e.prompt, 60)}` });
        assistant = null;
        break;
      case "subagent-finished":
        lines.push({ kind: "subagent", text: `⤶ subagent done` });
        break;
      case "plan-presented":
        plan = {
          title: "Plan",
          body: e.plan.split("\n"),
          hint: "Run /execute to proceed.",
        };
        assistant = null;
        break;
      case "tasks-updated":
        tasks = e.tasks;
        break;
      case "usage-updated":
        usage = e.usage;
        break;
      case "context-updated":
        context = { usedTokens: e.usedTokens, contextWindow: e.contextWindow };
        break;
      case "queue-changed":
        if (e.pending.length >= queued.length) queued = e.pending;
        break;
      case "notice":
        lines.push({ kind: "notice", text: e.message });
        break;
      default:
        break;
    }
  }
  return {
    lines: lines.flatMap(splitMultiline),
    ...(plan ? { plan } : {}),
    ...(tasks && tasks.length ? { tasks } : {}),
    ...(queued.length ? { queued } : {}),
    ...(usage ? { usage } : {}),
    ...(context ? { context } : {}),
  };
}

function splitMultiline(line: Line): Line[] {
  if (!line.text.includes("\n")) return [line];
  return line.text.split("\n").map((t) => ({ kind: line.kind, text: t }));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function firstLines(s: string, n: number): string[] {
  return s.split("\n").filter((l) => l.length).slice(0, n);
}

/** Local copy of headless.formatUsage (core must not import @vibe/tui). */
function formatUsage(u: SessionUsage): string {
  const tok =
    u.totalTokens >= 1000 ? `${(u.totalTokens / 1000).toFixed(1)}k` : `${u.totalTokens}`;
  const cost = u.costUSD > 0 ? ` · $${u.costUSD.toFixed(u.costUSD < 1 ? 4 : 2)}` : "";
  const cached =
    u.cachedInputTokens && u.cachedInputTokens > 0 ? ` · ${u.cachedInputTokens} cached` : "";
  return `${tok} tok${cost}${cached}`;
}

// ── Minimal inline LanguageModelV2 mock (avoids the ai/test -> vitest dep) ───
type Step = unknown[];
const USAGE = { inputTokens: 1240, outputTokens: 320, totalTokens: 1560 };
const USAGE_CACHED = {
  inputTokens: 1240,
  outputTokens: 320,
  totalTokens: 1560,
  cachedInputTokens: 1100,
};
const PRICE = async () => ({ input: 3, output: 15 }); // USD / 1M tokens

function partsStream(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function mockModel(steps: Step[]): LanguageModel {
  let i = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock",
    supportedUrls: {},
    async doStream() {
      return {
        stream: partsStream(steps[i++] ?? []),
        request: {},
        response: {},
        warnings: [],
      };
    },
    async doGenerate() {
      throw new Error("doGenerate is not used by these screenshots");
    },
  } as unknown as LanguageModel;
}

interface RunOpts {
  mode: "plan" | "execute";
  modelString: string;
  prompt: string;
  cwd?: string;
  config?: Config;
}

async function runSession(
  model: LanguageModel,
  tools: ToolDefinition[],
  opts: RunOpts,
): Promise<UIEvent[]> {
  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const ev of sub) events.push(ev);
  })();
  const providerId = opts.modelString.split("/")[0]!;
  const session = new Session({
    config: opts.config ?? defaultConfig(),
    registry: new ProviderRegistry([
      { id: providerId, auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset(tools),
    bus,
    cwd: opts.cwd ?? REPO_ROOT,
    model: opts.modelString,
    mode: opts.mode,
    getPricing: PRICE,
  });
  await session.run(opts.prompt);
  bus.close();
  await collector;
  return events;
}

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

/** Make a throwaway working dir seeded with files. */
function seedDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-shot-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// ── Scenes ──────────────────────────────────────────────────────────────────
async function buildScenes(): Promise<Scene[]> {
  const exec = (overrides: Partial<Config> = {}): Config => ({
    ...defaultConfig(),
    approvalMode: "auto",
    ...overrides,
  });

  // A — chat with a real glob tool call against this repo.
  const a = reduce(
    await runSession(
      mockModel([
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "I'll locate the package entry points and read the manifest.\n" },
          { type: "text-end", id: "a" },
          { type: "tool-call", toolCallId: "t1", toolName: "glob", input: JSON.stringify({ pattern: "packages/*/src/index.ts" }) },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ],
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "b" },
          { type: "text-delta", id: "b", delta: "Found 8 package entry points. The CLI is wired in\n`packages/cli/bin/vibecodr.ts`: it loads config, builds the Engine,\nand hands off to the TUI (or headless `-p`). The agent loop lives in\n`packages/core/src/session.ts`." },
          { type: "text-end", id: "b" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ],
      ]),
      new Toolset().all(),
      { mode: "execute", modelString: "anthropic/claude-opus-4-8", prompt: "Where are the package entry points and how is the CLI wired?" },
    ),
  );

  // B — live diff: the real `edit` tool runs in a temp dir -> file-changed event.
  const diffDir = seedDir({
    "greeting.ts": [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}`;",
      "}",
      "",
      "console.log(greet(\"world\"));",
      "",
    ].join("\n"),
  });
  const diff = reduce(
    await runSession(
      mockModel([
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "e" },
          { type: "text-delta", id: "e", delta: "I'll make the greeting friendlier and add a punctuation mark.\n" },
          { type: "text-end", id: "e" },
          { type: "tool-call", toolCallId: "t2", toolName: "edit", input: JSON.stringify({ path: "greeting.ts", edits: [{ oldString: "return `Hello, ${name}`;", newString: "return `Hey there, ${name}! 👋`;" }, { oldString: 'greet("world")', newString: 'greet("vibecodr")' }] }) },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ],
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "e2" },
          { type: "text-delta", id: "e2", delta: "Done — two edits applied atomically and the diff is above." },
          { type: "text-end", id: "e2" },
          { type: "finish", finishReason: "stop", usage: USAGE_CACHED },
        ],
      ]),
      new Toolset().all(),
      { mode: "execute", modelString: "anthropic/claude-opus-4-8", prompt: "Make the greeting friendlier", cwd: diffDir, config: exec() },
    ),
  );

  // C — plan mode with a present_plan call.
  const planText =
    "Add a usage/cost footer to the TUI:\n1. Track cumulative usage on the session from step-finished events.\n2. Resolve per-token pricing from the models.dev catalog.\n3. Render `tokens · $cost` in the status bar, right-aligned.";
  const plan = reduce(
    await runSession(
      mockModel([
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "p" },
          { type: "text-delta", id: "p", delta: "Here is my plan — I won't change any files yet.\n" },
          { type: "text-end", id: "p" },
          { type: "tool-call", toolCallId: "t3", toolName: "present_plan", input: JSON.stringify({ plan: planText }) },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ],
      ]),
      new Toolset().all(),
      { mode: "plan", modelString: "anthropic/claude-opus-4-8", prompt: "Plan a usage/cost footer for the status bar" },
    ),
  );

  // D — execute mode with a live task list (real update_tasks tool call).
  const taskList = [
    { title: "Track cumulative usage from step-finished events", status: "completed" },
    { title: "Resolve per-token pricing from the models.dev catalog", status: "in_progress" },
    { title: "Render `tokens · $cost` in the status bar", status: "pending" },
    { title: "Add a test for the footer formatter", status: "pending" },
  ];
  const tasks = reduce(
    await runSession(
      mockModel([
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "d" },
          { type: "text-delta", id: "d", delta: "I'll implement this in steps and track progress as I go.\n" },
          { type: "text-end", id: "d" },
          { type: "tool-call", toolCallId: "t4", toolName: "update_tasks", input: JSON.stringify({ tasks: taskList }) },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ],
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "d2" },
          { type: "text-delta", id: "d2", delta: "Usage now accumulates on the session. Wiring the catalog pricing\nlookup next, then the status-bar render." },
          { type: "text-end", id: "d2" },
          { type: "finish", finishReason: "stop", usage: USAGE_CACHED },
        ],
      ]),
      new Toolset().all(),
      { mode: "execute", modelString: "anthropic/claude-opus-4-8", prompt: "Implement the usage/cost footer" },
    ),
  );

  // E — /models picker (rendered from the real formatter, incl. new providers).
  const sampleModels: ModelInfo[] = [
    { id: "claude-opus-4-8", providerId: "anthropic", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4-6", providerId: "anthropic", contextWindow: 1_000_000 },
    { id: "gpt-5.1-codex", providerId: "codex", contextWindow: 400_000 },
    { id: "gpt-5.1", providerId: "openai", contextWindow: 400_000 },
    { id: "MiniMax-M1", providerId: "minimax", contextWindow: 1_000_000 },
    { id: "grok-4", providerId: "xai", contextWindow: 256_000 },
    { id: "deepseek-chat", providerId: "deepseek", contextWindow: 128_000 },
    { id: "qwen2.5-coder-32b", providerId: "lmstudio", contextWindow: 32_000 },
  ];
  const modelLines: Line[] = [
    { kind: "user", text: "/models" },
    { kind: "notice", text: "Available models for configured providers:" },
    ...formatModelList(sampleModels).split("\n").map((t): Line => ({ kind: "plain", text: t })),
  ];

  // F — git tool: real git_status against a seeded temp repo.
  const gitDir = seedDir({});
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: gitDir });
  git(["init", "-q"]);
  git(["config", "user.email", "dev@vibecodr.sh"]);
  git(["config", "user.name", "vibecodr"]);
  writeFileSync(join(gitDir, "config.ts"), "export const port = 3000;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  writeFileSync(join(gitDir, "config.ts"), "export const port = 8080;\n");
  writeFileSync(join(gitDir, "README.md"), "# service\n");
  const gitScene = reduce(
    await runSession(
      mockModel([
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "g" },
          { type: "text-delta", id: "g", delta: "Let me check the working tree before committing.\n" },
          { type: "text-end", id: "g" },
          { type: "tool-call", toolCallId: "t5", toolName: "git_status", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ],
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "g2" },
          { type: "text-delta", id: "g2", delta: "One modified file and one new file. I'll stage and commit them with git_commit." },
          { type: "text-end", id: "g2" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ],
      ]),
      new Toolset().all(),
      { mode: "execute", modelString: "anthropic/claude-opus-4-8", prompt: "What changed in the repo?", cwd: gitDir, config: exec() },
    ),
  );

  // G — permission prompt (interactive approval). Built from real UIEvent shapes.
  const perm = reduce([
    { type: "user-message", sessionId: "s", text: "format the codebase" },
    { type: "assistant-text-delta", sessionId: "s", delta: "I'll run the formatter across the packages.\n" },
    { type: "permission-request", sessionId: "s", id: "p1", toolName: "bash", input: { command: "biome format --write packages" } },
  ]);

  // H — sessions browser: real SessionStore round-trip, formatted like the CLI.
  const sessDir = mkdtempSync(join(tmpdir(), "vibe-shot-sess-"));
  const store = new SessionStore(sessDir);
  const now = Date.now();
  await store.save(
    { id: "ses_k3p9qz", model: "anthropic/claude-opus-4-8", mode: "execute", goal: "ship the usage/cost footer", usage: { inputTokens: 18400, outputTokens: 5200, costUSD: 0.1342 }, createdAt: now - 9e6, updatedAt: now - 6e5 },
    [],
    [],
  );
  await store.save(
    { id: "ses_m1x7ab", model: "minimax/MiniMax-M1", mode: "plan", goal: "evaluate MiniMax for refactors", usage: { inputTokens: 9100, outputTokens: 2300, costUSD: 0.0211 }, createdAt: now - 2e7, updatedAt: now - 8e6 },
    [],
    [],
  );
  const metas = await store.list();
  const idW = Math.max(...metas.map((m) => m.id.length));
  const modelW = Math.max(...metas.map((m) => m.model.length));
  const sessLines: Line[] = [
    { kind: "user", text: "vibecodr sessions" },
    ...metas.map((m): Line => {
      const when = new Date(m.updatedAt).toISOString().replace("T", " ").slice(0, 16);
      const cost = m.usage?.costUSD ? `$${m.usage.costUSD.toFixed(4)}` : "";
      const goal = m.goal ? `  — ${m.goal}` : "";
      return {
        kind: "plain",
        text: `${m.id.padEnd(idW)}  ${when}  ${m.model.padEnd(modelW)}  ${cost.padEnd(9)}${goal}`.trimEnd(),
      };
    }),
  ];

  // Append a live "· ctx N%" indicator when context fill is meaningful (≥1%).
  const ctx = (r: Reduced): string => {
    if (!r.context || r.context.contextWindow <= 0) return "";
    const pct = Math.min(100, Math.round((r.context.usedTokens / r.context.contextWindow) * 100));
    return pct >= 1 ? ` · ctx ${pct}%` : "";
  };

  return [
    { name: "01-chat", status: `anthropic/claude-opus-4-8 · execute${ctx(a)}`, cwd: "~/vibe-codr", lines: a.lines, ...(a.usage ? { usage: a.usage } : {}), input: "" },
    { name: "02-diff", status: `anthropic/claude-opus-4-8 · execute${ctx(diff)}`, cwd: "~/app", lines: diff.lines, ...(diff.usage ? { usage: diff.usage } : {}), input: "" },
    { name: "03-plan", status: `anthropic/claude-opus-4-8 · plan${ctx(plan)}`, cwd: "~/vibe-codr", lines: plan.lines, ...(plan.plan ? { plan: plan.plan } : {}), input: "/execute" },
    { name: "04-tasks", status: `anthropic/claude-opus-4-8 · execute${ctx(tasks)}`, cwd: "~/vibe-codr", lines: tasks.lines, ...(tasks.tasks ? { tasks: tasks.tasks } : {}), ...(tasks.usage ? { usage: tasks.usage } : {}), input: "" },
    { name: "05-models", status: "minimax/MiniMax-M1 · execute", cwd: "~/vibe-codr", lines: modelLines, input: "/model codex/gpt-5.1-codex" },
    { name: "06-git", status: `anthropic/claude-opus-4-8 · execute${ctx(gitScene)}`, cwd: "~/service", lines: gitScene.lines, ...(gitScene.usage ? { usage: gitScene.usage } : {}), input: "" },
    { name: "07-permission", status: "anthropic/claude-opus-4-8 · execute · ask", cwd: "~/vibe-codr", lines: perm.lines, input: "y", inputHint: "approve once" },
    { name: "08-sessions", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/vibe-codr", lines: sessLines, input: "vibecodr --resume ses_k3p9qz" },
  ];
}

// ── HTML rendering ──────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineColor(kind: LineKind): string {
  switch (kind) {
    case "user":
      return COLORS.blue;
    case "tool":
      return COLORS.cyan;
    case "toolresult":
      return COLORS.dim;
    case "notice":
      return COLORS.yellow;
    case "subagent":
      return COLORS.magenta;
    case "add":
      return COLORS.green;
    case "del":
      return COLORS.red;
    case "ctx":
      return COLORS.dim;
    case "plain":
      return COLORS.fg;
    default:
      return COLORS.fg;
  }
}

function renderLines(scene: Scene): string {
  const rows: string[] = [];
  for (const line of scene.lines) {
    const prefix = line.kind === "user" ? "› " : "";
    rows.push(
      `<div class="row" style="color:${lineColor(line.kind)}">${esc(prefix + line.text) || "&nbsp;"}</div>`,
    );
  }
  if (scene.plan) {
    rows.push(`<div class="planbox">`);
    rows.push(`<div class="row" style="color:${COLORS.magenta};font-weight:700">${esc(scene.plan.title)}</div>`);
    for (const b of scene.plan.body) {
      rows.push(`<div class="row" style="color:${COLORS.fg}">${esc(b) || "&nbsp;"}</div>`);
    }
    rows.push(`<div class="row" style="color:${COLORS.dim}">${esc(scene.plan.hint)}</div>`);
    rows.push(`</div>`);
  }
  if (scene.tasks?.length) {
    const done = scene.tasks.filter((t) => t.status === "completed").length;
    rows.push(`<div class="tasksbox">`);
    rows.push(`<div class="row" style="color:${COLORS.dim};font-weight:700">Tasks · ${done}/${scene.tasks.length}</div>`);
    for (const t of scene.tasks) {
      const glyph = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "○";
      const color = t.status === "completed" ? COLORS.dim : t.status === "in_progress" ? COLORS.cyan : COLORS.fg;
      const deco = t.status === "completed" ? "text-decoration:line-through" : "";
      rows.push(`<div class="row" style="color:${color};${deco}">${glyph} ${esc(t.title)}</div>`);
    }
    rows.push(`</div>`);
  }
  if (scene.queued?.length) {
    rows.push(
      `<div class="row" style="color:${COLORS.dim}">↳ ${scene.queued.length} queued: ${esc(scene.queued.map((q) => q.label).join(", "))}</div>`,
    );
  }
  return rows.join("\n");
}

/**
 * Project a scene's `status` ("model · mode[ · approvals][ · ctx N%]") into the
 * header pieces the app shows — mirrors `deriveUiMode` in packages/tui/modes.ts.
 */
function headerFromStatus(scene: Scene): {
  model: string;
  uiMode: "plan" | "execute" | "yolo";
  detail: string;
} {
  const segs = scene.status.split(" · ").map((s) => s.trim());
  const model = segs[0] ?? "";
  const mode = segs[1] ?? "execute";
  const approvals = segs.includes("auto") ? "auto" : "ask";
  const uiMode = mode === "plan" ? "plan" : approvals === "auto" ? "yolo" : "execute";
  const detail = segs.find((s) => s.startsWith("ctx ")) ?? "";
  return { model, uiMode, detail };
}
const ssModeLabel = (m: string) =>
  m === "plan" ? "◑ PLAN" : m === "execute" ? "▶ EXECUTE" : "⚡ YOLO";
const ssModeColor = (m: string) =>
  m === "plan" ? COLORS.cyan : m === "yolo" ? COLORS.red : "#8b5cf6";

function renderFrame(scene: Scene): string {
  const { model, uiMode, detail } = headerFromStatus(scene);
  const label = ssModeLabel(uiMode);
  const mc = ssModeColor(uiMode);
  const usageStr = scene.usage ? esc(formatUsage(scene.usage)) : "";
  const info = [detail && esc(detail), usageStr].filter(Boolean).join(" · ");
  const headRight = info ? `${esc(model)}&nbsp;&nbsp;·&nbsp;&nbsp;${info}` : esc(model);
  const footer = "shift+tab mode · @file attach · /help commands · ctrl-c quit";
  const placeholder =
    "Ask vibe-codr…  @file to attach · /help · /model &lt;id&gt; · /undo";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0d12; padding: 28px; }
  .term {
    width: 880px; background: ${COLORS.bg};
    border-radius: 10px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
    font-family: "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;
    font-size: 14px; line-height: 1.55; color: ${COLORS.fg};
  }
  .titlebar { display:flex; align-items:center; gap:8px; background:${COLORS.bgDim}; padding:10px 14px; border-bottom:1px solid #292e42; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .title { color:${COLORS.dim}; margin-left:8px; font-size:12px; }
  .body { padding:16px 18px 14px; min-height: 380px; display:flex; flex-direction:column; }
  .appheader { border:1px solid #3b4261; border-radius:6px; padding:7px 12px; margin-bottom:12px; }
  .hrow { display:flex; justify-content:space-between; align-items:center; }
  .hrow + .hrow { margin-top:2px; }
  .brand { color:${COLORS.blue}; font-weight:700; }
  .dim { color:${COLORS.dim}; font-size:12px; }
  .transcript { flex:1; }
  .row { white-space:pre-wrap; word-break:break-word; }
  .planbox { border:1px solid ${COLORS.magenta}; border-radius:6px; padding:8px 12px; margin:8px 0; }
  .tasksbox { border:1px solid ${COLORS.cyan}; border-radius:6px; padding:8px 12px; margin:8px 0; }
  .inputwrap { margin-top:14px; border:1px solid ${mc}; border-radius:6px; padding:8px 12px; position:relative; }
  .inputwrap .label { position:absolute; top:-9px; left:10px; background:${COLORS.bg}; padding:0 6px; font-size:11px; font-weight:700; color:${mc}; }
  .prompt { color:${COLORS.green}; }
  .placeholder { color:${COLORS.dim}; }
  .typed { color:${COLORS.fg}; }
  .cursor { background:${COLORS.fg}; color:${COLORS.bg}; }
  .footer { margin-top:8px; font-size:11px; color:${COLORS.dim}; }
  </style></head><body>
  <div class="term">
    <div class="titlebar">
      <div class="dot" style="background:#f7768e"></div>
      <div class="dot" style="background:#e0af68"></div>
      <div class="dot" style="background:#9ece6a"></div>
      <div class="title">vibe-codr — ${esc(scene.cwd)}</div>
    </div>
    <div class="body">
      <div class="appheader">
        <div class="hrow"><span class="brand">◆ vibe-codr</span><span class="dim">${esc(scene.cwd)}</span></div>
        <div class="hrow"><span style="color:${mc};font-weight:700">${label}</span><span class="dim">${headRight}</span></div>
      </div>
      <div class="transcript">
${renderLines(scene)}
      </div>
      <div class="inputwrap">
        <span class="label">${label}</span>
        <span class="prompt">› </span>${
          scene.input
            ? `<span class="typed">${esc(scene.input)}</span><span class="cursor">&nbsp;</span>`
            : `<span class="placeholder">${placeholder}</span>`
        }
      </div>
      <div class="footer">${footer}</div>
    </div>
  </div>
  </body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────
const outDir = process.argv[2] ?? "./screenshots";
const scenes = await buildScenes();

// Use the pinned CI Chromium when present; otherwise fall back to Playwright's
// own managed install (so the script also runs on dev machines / macOS).
const browser = await chromium.launch(
  existsSync(CHROME) ? { executablePath: CHROME } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const scene of scenes) {
  await page.setContent(renderFrame(scene), { waitUntil: "networkidle" });
  const el = await page.$(".term");
  const path = `${outDir}/${scene.name}.png`;
  await el!.screenshot({ path });
  console.log(`wrote ${path}`);
}
await browser.close();
