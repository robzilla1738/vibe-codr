/**
 * Dev-only: generate faithful PNG screenshots of the vibe-codr TUI.
 *
 * Drives the REAL engine/session with a scripted MockLanguageModelV2 to produce
 * genuine UIEvent streams (real tools run for real — edits in temp dirs, real
 * git in a temp repo), reduces them into display blocks (mirroring the OpenTUI
 * app in packages/tui/src/app.tsx), renders a terminal-styled HTML frame, and
 * screenshots it with the bundled Playwright Chromium.
 *
 * Keep this in lockstep with app.tsx: the block reducer, the markdown rendering,
 * the condensed/expandable tool output, the context rail, and the header all
 * mirror the live app.
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
  SessionUsage,
} from "@vibe/shared";
import { ProviderRegistry, type ModelInfo } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig, type Config } from "@vibe/config";
import { Session } from "../src/session.ts";
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
  // Block surfaces + diff tints (mirror packages/tui/src/themes.ts DEFAULT).
  panel: "#1a1c28",
  elevated: "#242736",
  primary: "#8b5cf6", // the single accent (execute mode); = mode color `mc` below
  border: "#2c3047",
  addBg: "#1b2b25",
  delBg: "#2d2030",
  // Slash-menu selection highlight (neutral bg; the accent is the text color).
  selBg: "#2e3346",
  selFg: "#c0caf5",
};

/**
 * Local copy of packages/tui/src/tool-icons.ts (core must not import @vibe/tui).
 * Keep the icons + summaries identical so the shots match the live app.
 */
const TOOL_ICONS: Record<string, string> = {
  bash: "$", shell: "$", read: "→", write: "←", edit: "←", multiedit: "←",
  apply_patch: "%", glob: "✱", grep: "✱", list: "☰", ls: "☰",
  webfetch: "%", web_fetch: "%", websearch: "◈", web_search: "◈",
  task: "✦", subagent: "✦", update_tasks: "☑", todowrite: "☑", todo_write: "☑",
  present_plan: "◑", recall: "⌕", memory: "❖",
};
function ssToolIcon(name: string): string {
  const k = name.toLowerCase();
  if (TOOL_ICONS[k]) return TOOL_ICONS[k] as string;
  if (k.startsWith("git")) return "±";
  if (k.startsWith("mcp")) return "⊕";
  return "⚒";
}
function ssToolLabel(name: string, input: unknown): string {
  const a: Record<string, unknown> =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : typeof input === "string" && input.trim().startsWith("{")
        ? JSON.parse(input)
        : {};
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const q = (v: unknown) => (s(v) ? `"${s(v)}"` : "");
  const path = s(a.path || a.file || a.filePath || a.file_path);
  const k = name.toLowerCase();
  let body: string;
  switch (k) {
    case "bash": case "shell": body = truncate(s(a.command || a.cmd), 72); break;
    case "read": body = `read ${path}`; break;
    case "write": body = `write ${path}`; break;
    case "edit": case "multiedit": body = `edit ${path}`; break;
    case "apply_patch": body = `patch ${path}`; break;
    case "list": case "ls": body = `list ${s(a.path) || "."}`; break;
    case "glob": body = `glob ${q(a.pattern || a.glob)}${a.path ? ` in ${s(a.path)}` : ""}`.trim(); break;
    case "grep": body = `grep ${q(a.pattern || a.query)}${a.path ? ` in ${s(a.path)}` : ""}`.trim(); break;
    case "webfetch": case "web_fetch": body = `fetch ${truncate(s(a.url), 64)}`; break;
    case "websearch": case "web_search": body = `search ${q(a.query || a.q)}`.trim(); break;
    case "task": case "subagent": body = `task ${truncate(s(a.prompt || a.description || a.title), 56)}`.trim(); break;
    case "update_tasks": case "todowrite": case "todo_write": body = "update tasks"; break;
    case "present_plan": body = "present plan"; break;
    default: {
      const kv = Object.entries(a)
        .filter(([, v]) => v != null && v !== "")
        .slice(0, k.startsWith("git") ? 2 : 3)
        .map(([kk, v]) => `${kk}=${truncate(s(v), 24)}`);
      body = `${name}${kv.length ? ` [${kv.join(", ")}]` : ""}`;
    }
  }
  return `${ssToolIcon(name)} ${body}`;
}

/** One transcript block (mirrors the Block union in app.tsx). */
type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string; output: string[]; collapsed: boolean; isDiff: boolean }
  | { kind: "notice"; text: string }
  | { kind: "plain"; text: string };

interface Subagent {
  id: string;
  prompt: string;
  status: "running" | "done";
}

interface PlanBlock {
  body: string;
}

interface PermCard {
  toolName: string;
  input: unknown;
}

interface MenuBlock {
  title: string;
  rows: { active: boolean; text: string }[];
  more?: string;
}

interface Scene {
  name: string;
  status: string;
  cwd: string;
  blocks: Block[];
  tasks?: Task[];
  subagents?: Subagent[];
  usage?: SessionUsage;
  context?: { usedTokens: number; contextWindow: number };
  goal?: string;
  plan?: PlanBlock;
  perm?: PermCard;
  menu?: MenuBlock;
  /** A live "⠹ Working… 2.4s" indicator row, when the turn is in flight. */
  working?: string;
  input: string;
  inputHint?: string;
  /** Listing views (models, sessions) render without the live-TUI rail. */
  noRail?: boolean;
}

interface Reduced {
  blocks: Block[];
  tasks?: Task[];
  subagents?: Subagent[];
  usage?: SessionUsage;
  context?: { usedTokens: number; contextWindow: number };
  plan?: PlanBlock;
  perm?: PermCard;
}

// ── Event -> display-block reducer (mirrors app.tsx onMount handler) ─────────
function reduce(events: UIEvent[]): Reduced {
  const blocks: Block[] = [];
  let tasks: Task[] | undefined;
  const subagents: Subagent[] = [];
  let usage: SessionUsage | undefined;
  let context: { usedTokens: number; contextWindow: number } | undefined;
  let plan: PlanBlock | undefined;
  let perm: PermCard | undefined;
  let assistant: Extract<Block, { kind: "assistant" }> | null = null;
  const toolByCall = new Map<string, Extract<Block, { kind: "tool" }>>();
  // edit/write return their diff as text too; skip that echo (keyed by call id)
  // since the file-changed event already folded it into the diff block.
  const suppressCallIds = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "user-message":
        assistant = null;
        blocks.push({ kind: "user", text: e.text });
        break;
      case "assistant-text-delta":
        if (!assistant) {
          assistant = { kind: "assistant", text: "" };
          blocks.push(assistant);
        }
        assistant.text += e.delta;
        break;
      case "tool-call-started": {
        assistant = null;
        const b: Extract<Block, { kind: "tool" }> = {
          kind: "tool",
          label: ssToolLabel(e.toolName, e.input),
          output: [],
          collapsed: true,
          isDiff: false,
        };
        blocks.push(b);
        toolByCall.set(e.toolCallId, b);
        break;
      }
      case "tool-call-finished": {
        // Skip only the echo for the exact call whose diff we already folded.
        if (suppressCallIds.has(e.toolCallId)) {
          suppressCallIds.delete(e.toolCallId);
          break;
        }
        const b = toolByCall.get(e.toolCallId);
        if (b) {
          const out = typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 2);
          b.output = out.split("\n").filter((l, i, arr) => l.length || i < arr.length - 1);
        }
        break;
      }
      case "file-changed": {
        // Fold the diff into the EXACT tool block that produced it (by call id —
        // mirrors app.tsx). Diffs render expanded (the README highlight).
        suppressCallIds.add(e.toolCallId);
        assistant = null;
        const verb = e.action === "write" ? "wrote" : "edited";
        const header = `✎ ${verb} ${e.path}  +${e.added} -${e.removed}`;
        const lines = e.diff ? e.diff.split("\n") : [];
        const target = toolByCall.get(e.toolCallId);
        if (target && !target.isDiff) {
          target.label = header;
          target.output = lines;
          target.isDiff = true;
          target.collapsed = false;
        } else {
          blocks.push({ kind: "tool", label: header, output: lines, collapsed: false, isDiff: true });
        }
        break;
      }
      case "permission-request":
        perm = { toolName: e.toolName, input: e.input };
        break;
      case "subagent-started":
        subagents.push({ id: e.subagentId, prompt: e.prompt, status: "running" });
        break;
      case "subagent-finished": {
        const s = subagents.find((x) => x.id === e.subagentId);
        if (s) s.status = "done";
        break;
      }
      case "plan-presented":
        assistant = null;
        plan = { body: e.plan };
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
      case "notice":
        blocks.push({ kind: "notice", text: e.message });
        break;
      default:
        break;
    }
  }
  return {
    blocks,
    ...(tasks && tasks.length ? { tasks } : {}),
    ...(subagents.length ? { subagents } : {}),
    ...(usage ? { usage } : {}),
    ...(context ? { context } : {}),
    ...(plan ? { plan } : {}),
    ...(perm ? { perm } : {}),
  };
}

/** Identical to app.tsx's truncate so README widths match the live app. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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

/** Rail context line "12% · 24k/200k" (mirror app.tsx ctxSummary). */
function ctxSummary(ctx: { usedTokens: number; contextWindow: number } | undefined): string {
  if (!ctx || ctx.contextWindow <= 0) return "";
  const pct = Math.min(100, Math.round((ctx.usedTokens / ctx.contextWindow) * 100));
  if (pct < 1) return "";
  return `${pct}% · ${ktok(ctx.usedTokens)}/${ktok(ctx.contextWindow)}`;
}
function ktok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
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
          { type: "text-delta", id: "b", delta: "Found **8 package entry points**. The CLI is wired in\n`packages/cli/bin/vibecodr.ts`: it loads config, builds the Engine,\nand hands off to the TUI (or headless `-p`). The agent loop lives in\n`packages/core/src/session.ts`." },
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
  const modelBlocks: Block[] = [
    { kind: "user", text: "/models" },
    { kind: "notice", text: "Available models for configured providers:" },
    ...formatModelList(sampleModels).split("\n").map((t): Block => ({ kind: "plain", text: t })),
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
          { type: "text-delta", id: "g2", delta: "One modified file and one new file. I'll stage and commit them with `git_commit`." },
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
  const sessBlocks: Block[] = [
    { kind: "user", text: "vibecodr sessions" },
    ...metas.map((m): Block => {
      const when = new Date(m.updatedAt).toISOString().replace("T", " ").slice(0, 16);
      const cost = m.usage?.costUSD ? `$${m.usage.costUSD.toFixed(4)}` : "";
      const goal = m.goal ? `  — ${m.goal}` : "";
      return {
        kind: "plain",
        text: `${m.id.padEnd(idW)}  ${when}  ${m.model.padEnd(modelW)}  ${cost.padEnd(9)}${goal}`.trimEnd(),
      };
    }),
  ];

  // I — the slash-command menu open (mirrors menuView in packages/tui/app.tsx).
  const menuCmds: [string, string][] = [
    ["help", "Show available commands"],
    ["status", "Model, mode, cwd, tokens, cost"],
    ["cost", "Token usage and estimated cost"],
    ["context", "Context-window usage"],
    ["clear", "Clear the conversation (alias /new)"],
    ["compact", "Compact the conversation to free context"],
    ["resume", "List saved sessions to resume"],
    ["recall", "Search past sessions <text>"],
  ];
  const menuNameW = Math.min(14, Math.max(...menuCmds.map(([n]) => n.length + 1)));
  const menuBlock: MenuBlock = {
    title: "commands",
    rows: menuCmds.map(([n, d], i) => ({
      active: i === 0,
      text: `${`/${n}`.padEnd(menuNameW + 1)}  ${d}`,
    })),
    more: "+27 more · type to filter",
  };

  return [
    { name: "01-chat", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/vibe-codr", blocks: a.blocks, ...(a.usage ? { usage: a.usage } : {}), ...(a.context ? { context: a.context } : {}), input: "" },
    { name: "02-diff", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/app", blocks: diff.blocks, ...(diff.usage ? { usage: diff.usage } : {}), ...(diff.context ? { context: diff.context } : {}), input: "" },
    { name: "03-plan", status: "anthropic/claude-opus-4-8 · plan", cwd: "~/vibe-codr", blocks: plan.blocks, ...(plan.plan ? { plan: plan.plan } : {}), input: "/execute" },
    { name: "04-tasks", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/vibe-codr", blocks: tasks.blocks, ...(tasks.tasks ? { tasks: tasks.tasks } : {}), ...(tasks.usage ? { usage: tasks.usage } : {}), ...(tasks.context ? { context: tasks.context } : {}), subagents: [{ id: "sa1", prompt: "audit catalog pricing", status: "running" }], goal: "ship the usage/cost footer", working: "⠹ Working… 2.4s  ·  esc to interrupt", input: "" },
    { name: "05-models", status: "minimax/MiniMax-M1 · execute", cwd: "~/vibe-codr", blocks: modelBlocks, input: "/model codex/gpt-5.1-codex", noRail: true },
    { name: "06-git", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/service", blocks: gitScene.blocks, ...(gitScene.usage ? { usage: gitScene.usage } : {}), ...(gitScene.context ? { context: gitScene.context } : {}), input: "" },
    { name: "07-permission", status: "anthropic/claude-opus-4-8 · execute · ask", cwd: "~/vibe-codr", blocks: perm.blocks, ...(perm.perm ? { perm: perm.perm } : {}), input: "y", inputHint: "approve once" },
    { name: "08-sessions", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/vibe-codr", blocks: sessBlocks, input: "vibecodr --resume ses_k3p9qz", noRail: true },
    { name: "09-menu", status: "anthropic/claude-opus-4-8 · execute", cwd: "~/vibe-codr", blocks: a.blocks, menu: menuBlock, input: "/" },
  ];
}

// ── HTML rendering ──────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markdown spans (escape first, then apply markup). */
function mdInline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, (_, c: string) => `<span class="code">${c}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c: string) => `<b>${c}</b>`)
    .replace(/__([^_]+)__/g, (_, c: string) => `<b>${c}</b>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, p: string, c: string) => `${p}<i>${c}</i>`);
}

/** A focused subset of Markdown -> HTML (mirrors the native <markdown> render). */
function mdToHtml(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fence: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fence = [];
      } else {
        inFence = false;
        out.push(`<pre class="codeblk">${esc(fence.join("\n"))}</pre>`);
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<div class="mdh">${mdInline(h[2] as string)}</div>`);
      continue;
    }
    const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (b) {
      out.push(`<div class="mdli">${b[1]}<span class="bullet">•</span> ${mdInline(b[2] as string)}</div>`);
      continue;
    }
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (n) {
      out.push(`<div class="mdli">${n[1]}${n[2]}. ${mdInline(n[3] as string)}</div>`);
      continue;
    }
    if (line.trim() === "") {
      out.push(`<div class="row">&nbsp;</div>`);
      continue;
    }
    out.push(`<div class="row">${mdInline(line)}</div>`);
  }
  if (inFence) out.push(`<pre class="codeblk">${esc(fence.join("\n"))}</pre>`);
  return out.join("\n");
}

/** Green additions / red deletions / dim context on a diff line. */
function diffColor(line: string): string {
  if (line.startsWith("+")) return COLORS.green;
  if (line.startsWith("-")) return COLORS.red;
  return COLORS.dim;
}
function diffBgFor(line: string): string {
  if (line.startsWith("+")) return `background:${COLORS.addBg};`;
  if (line.startsWith("-")) return `background:${COLORS.delBg};`;
  return "";
}

function renderTool(b: Extract<Block, { kind: "tool" }>): string {
  const expandable = b.output.length > 0;
  if (b.collapsed) {
    const chevron = expandable ? "▸ " : "&nbsp;&nbsp;";
    const hint = expandable
      ? b.isDiff
        ? "  ·  diff"
        : `  ·  ${b.output.length} line${b.output.length === 1 ? "" : "s"}`
      : "";
    return `<div class="toolrow">${chevron}${esc(b.label)}${esc(hint)}</div>`;
  }
  const rows = [`<div class="toolrow">▾ ${esc(b.label)}</div>`];
  if (b.isDiff) {
    for (const line of b.output) {
      rows.push(
        `<div class="row diffline" style="color:${diffColor(line)};${diffBgFor(line)}">${esc(line) || "&nbsp;"}</div>`,
      );
    }
  } else {
    for (const line of b.output) {
      rows.push(`<div class="row" style="color:${COLORS.dim}">&nbsp;&nbsp;${esc(line) || "&nbsp;"}</div>`);
    }
  }
  return rows.join("\n");
}

function renderBlocks(scene: Scene, mc: string): string {
  const rows: string[] = [];
  for (const block of scene.blocks) {
    switch (block.kind) {
      case "user":
        rows.push(
          `<div class="userblock" style="border-left:3px solid ${mc}"><div class="row" style="color:${COLORS.fg};font-weight:700">${esc(block.text) || "&nbsp;"}</div></div>`,
        );
        break;
      case "assistant":
        rows.push(`<div class="assistant">${mdToHtml(block.text)}</div>`);
        break;
      case "tool":
        rows.push(renderTool(block));
        break;
      case "notice":
        rows.push(`<div class="row notice">${esc(block.text) || "&nbsp;"}</div>`);
        break;
      case "plain":
        rows.push(`<div class="row plain">${esc(block.text) || "&nbsp;"}</div>`);
        break;
    }
  }
  return rows.join("\n");
}

/** The context rail — main tasks, live subagents, and session info. */
function renderRail(scene: Scene, mc: string): string {
  const { model } = headerFromStatus(scene);
  const out: string[] = [`<div class="rail">`];
  if (scene.tasks?.length) {
    const done = scene.tasks.filter((t) => t.status === "completed").length;
    out.push(`<div class="railhead" style="color:${mc}">TASKS  ${done}/${scene.tasks.length}</div>`);
    for (const t of scene.tasks) {
      const glyph = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "○";
      const color = t.status === "completed" ? COLORS.dim : t.status === "in_progress" ? mc : COLORS.fg;
      out.push(`<div class="railitem" style="color:${color}">${glyph} ${esc(truncate(t.title, 26))}</div>`);
    }
  }
  if (scene.subagents?.length) {
    out.push(`<div class="railhead" style="color:${COLORS.dim}">SUBAGENTS</div>`);
    for (const s of scene.subagents) {
      const glyph = s.status === "running" ? "⠹" : "✔";
      const color = s.status === "running" ? mc : COLORS.dim;
      out.push(`<div class="railitem" style="color:${color}">${glyph} ${esc(truncate(s.prompt, 26))}</div>`);
    }
  }
  out.push(`<div class="railhead" style="color:${COLORS.dim}">SESSION</div>`);
  out.push(`<div class="railitem" style="color:${COLORS.fg}">${esc(truncate(model, 28))}</div>`);
  const ctx = ctxSummary(scene.context);
  if (ctx) out.push(`<div class="railitem" style="color:${COLORS.dim}">ctx ${esc(ctx)}</div>`);
  if (scene.usage) out.push(`<div class="railitem" style="color:${COLORS.dim}">${esc(formatUsage(scene.usage))}</div>`);
  if (scene.goal) out.push(`<div class="railitem" style="color:${COLORS.dim}">★ ${esc(truncate(scene.goal, 24))}</div>`);
  out.push(`</div>`);
  return out.join("\n");
}

/**
 * Project a scene's `status` ("model · mode[ · approvals]") into the header
 * pieces the app shows — mirrors `deriveUiMode` in packages/tui/modes.ts.
 */
function headerFromStatus(scene: Scene): {
  model: string;
  uiMode: "plan" | "execute" | "yolo";
} {
  const segs = scene.status.split(" · ").map((s) => s.trim());
  const model = segs[0] ?? "";
  const mode = segs[1] ?? "execute";
  const approvals = segs.includes("auto") ? "auto" : "ask";
  const uiMode = mode === "plan" ? "plan" : approvals === "auto" ? "yolo" : "execute";
  return { model, uiMode };
}
const ssModeLabel = (m: string) =>
  m === "plan" ? "◑ PLAN" : m === "execute" ? "▶ EXECUTE" : "⚡ YOLO";
const ssModeColor = (m: string) =>
  m === "plan" ? COLORS.cyan : m === "yolo" ? COLORS.red : COLORS.primary;

function renderFrame(scene: Scene): string {
  const { model, uiMode } = headerFromStatus(scene);
  const label = ssModeLabel(uiMode);
  const mc = ssModeColor(uiMode);
  const usageStr = scene.usage ? esc(formatUsage(scene.usage)) : "";
  const showRail = !scene.noRail;
  // Narrow / listing layouts keep the model + usage in a second header row.
  const headSecond = !showRail
    ? `<div class="hrow"><span style="color:${COLORS.fg}">${esc(model)}</span><span class="dim">${usageStr}</span></div>`
    : "";
  const footer = "shift+tab mode · / commands · @file attach · click ▸ to expand · esc interrupt";
  const placeholder = "Ask vibe-codr…   @file · /help · /model &lt;id&gt; · /undo";
  const body = showRail
    ? `<div class="bodyrow">
        <div class="transcript">
${renderBlocks(scene, mc)}
        </div>
${renderRail(scene, mc)}
      </div>`
    : `<div class="transcript">
${renderBlocks(scene, mc)}
      </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0d12; padding: 28px; }
  .term {
    width: 940px; background: ${COLORS.bg};
    border-radius: 10px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
    font-family: "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;
    font-size: 14px; line-height: 1.55; color: ${COLORS.fg};
  }
  .titlebar { display:flex; align-items:center; gap:8px; background:${COLORS.bgDim}; padding:10px 14px; border-bottom:1px solid ${COLORS.border}; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .title { color:${COLORS.dim}; margin-left:8px; font-size:12px; }
  .body { padding:16px 18px 14px; min-height: 400px; display:flex; flex-direction:column; }
  .appheader { border-bottom:1px solid ${COLORS.border}; padding:2px 2px 12px; margin-bottom:14px; }
  .hrow { display:flex; justify-content:space-between; align-items:center; }
  .hrow + .hrow { margin-top:4px; }
  .brandwrap { display:flex; align-items:center; }
  .brand { color:${mc}; font-weight:700; }
  .pill { background:${COLORS.elevated}; color:${mc}; font-weight:700; font-size:12px; padding:1px 9px; border-radius:5px; margin-left:12px; }
  .dim { color:${COLORS.dim}; font-size:12px; }
  .cwd { color:${COLORS.dim}; font-size:12px; }
  .bodyrow { display:flex; flex:1; }
  .transcript { flex:1; min-width:0; }
  .rail { width:240px; flex-shrink:0; margin-left:16px; padding-left:16px; border-left:1px solid ${COLORS.border}; }
  .railhead { font-weight:700; font-size:11px; letter-spacing:0.08em; margin-top:14px; }
  .railhead:first-child { margin-top:0; }
  .railitem { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row { white-space:pre-wrap; word-break:break-word; }
  .assistant { margin-top:10px; }
  .mdh { font-weight:700; white-space:pre-wrap; }
  .mdli { white-space:pre-wrap; word-break:break-word; }
  .bullet { color:${COLORS.dim}; }
  .code { color:${COLORS.cyan}; }
  .codeblk { color:${COLORS.cyan}; background:${COLORS.bgDim}; padding:6px 10px; border-radius:6px; white-space:pre-wrap; margin:6px 0; font-size:13px; }
  .notice { color:${COLORS.yellow}; }
  .plain { color:${COLORS.fg}; }
  .toolrow { color:${COLORS.dim}; white-space:pre-wrap; margin-top:9px; }
  .diffline { white-space:pre-wrap; word-break:break-word; }
  .userblock { background:${COLORS.panel}; padding:5px 10px; margin:10px 0 2px; }
  .working { color:${mc}; margin:8px 0 2px; }
  .planbox { border:1px solid ${mc}; border-radius:6px; padding:8px 12px; margin:10px 0; }
  .permcard { border-left:3px solid ${COLORS.yellow}; background:${COLORS.panel}; padding:8px 12px; margin:10px 0; }
  .menubox { border:1px solid ${mc}; border-radius:6px; background:${COLORS.panel}; padding:6px 10px; margin:10px 0; position:relative; }
  .menubox .label { position:absolute; top:-9px; left:10px; background:${COLORS.bg}; padding:0 6px; font-size:11px; font-weight:700; color:${mc}; }
  .menurow { color:${COLORS.dim}; padding:0 6px; }
  .menurow.active { color:${mc}; background:${COLORS.selBg}; font-weight:700; }
  .menumore { color:${COLORS.dim}; padding:2px 6px 0; }
  .inputwrap { margin-top:14px; border-left:3px solid ${mc}; background:${COLORS.elevated}; border-radius:0 6px 6px 0; padding:10px 12px; position:relative; display:flex; align-items:center; }
  .prompt { color:${mc}; font-weight:700; }
  .placeholder { color:${COLORS.dim}; }
  .typed { color:${COLORS.fg}; }
  .cursor { background:${mc}; color:${COLORS.bg}; }
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
        <div class="hrow">
          <span class="brandwrap"><span class="brand">◆ vibe-codr</span><span class="pill">${label}</span></span>
          <span class="cwd">${esc(scene.cwd)}</span>
        </div>
        ${headSecond}
      </div>
      ${body}${
        scene.working
          ? `\n      <div class="working">${esc(scene.working)}</div>`
          : ""
      }${
        scene.plan
          ? `\n      <div class="planbox" style="border-color:${mc}">
        <div class="assistant" style="margin-top:0">${mdToHtml(scene.plan.body)}</div>
        <div class="row" style="color:${COLORS.dim};margin-top:6px">Shift+Tab to execute, or /execute to proceed.</div>
      </div>`
          : ""
      }${
        scene.perm
          ? `\n      <div class="permcard">
        <div class="row" style="color:${COLORS.yellow};font-weight:700">⚠ permission required · ${esc(scene.perm.toolName)}</div>
        <div class="row" style="color:${COLORS.fg}">  ${esc(ssToolLabel(scene.perm.toolName, scene.perm.input))}</div>
        <div class="row" style="color:${COLORS.dim}">  [y]es once  ·  [a]lways  ·  [n]o</div>
      </div>`
          : ""
      }${
        scene.menu
          ? `\n      <div class="menubox">
        <span class="label">${esc(scene.menu.title)}</span>
${scene.menu.rows
  .map(
    (r) =>
      `        <div class="menurow${r.active ? " active" : ""}">${r.active ? "❯ " : "&nbsp;&nbsp;"}${esc(r.text)}</div>`,
  )
  .join("\n")}${scene.menu.more ? `\n        <div class="menumore">&nbsp;&nbsp;${esc(scene.menu.more)}</div>` : ""}
      </div>`
          : ""
      }
      <div class="inputwrap">
        <span class="prompt">❯ </span>${
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
