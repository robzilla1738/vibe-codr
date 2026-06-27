/**
 * Dev-only: generate faithful PNG screenshots of the vibe-codr TUI.
 *
 * Drives the REAL engine/session with a scripted MockLanguageModelV2 to produce
 * genuine UIEvent streams, reduces them into display lines (mirroring the
 * OpenTUI app in packages/tui/src/app.tsx), renders a terminal-styled HTML
 * frame, and screenshots it with the bundled Playwright Chromium.
 *
 * Run: bun packages/core/scripts/screenshot.ts <outDir>
 */
import { chromium } from "playwright";
import type { LanguageModel } from "ai";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry, type ModelInfo } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { Session } from "../src/session.ts";
import { EventBus } from "../src/event-bus.ts";
import { formatModelList } from "../src/commands.ts";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

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
  input: string;
}

// ── Event -> display-line reducer (mirrors app.tsx onMount handler) ─────────
function reduce(events: UIEvent[]): { lines: Line[]; plan?: PlanBlock } {
  const lines: Line[] = [];
  let plan: PlanBlock | undefined;
  let assistant: Line | null = null;
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
        const out =
          typeof e.output === "string" ? e.output : JSON.stringify(e.output);
        lines.push({
          kind: "toolresult",
          text: `  ↳ ${truncate(firstLines(out, 1), 70)}`,
        });
        break;
      }
      case "subagent-started":
        lines.push({ kind: "subagent", text: `⤷ subagent: ${truncate(e.prompt, 60)}` });
        assistant = null;
        break;
      case "subagent-finished":
        lines.push({ kind: "subagent", text: `⤶ subagent done` });
        break;
      case "plan-presented":
        plan = {
          title: "── Plan ──",
          body: e.plan.split("\n"),
          hint: "Run /execute to proceed.",
        };
        assistant = null;
        break;
      case "notice":
        lines.push({ kind: "notice", text: e.message });
        break;
      default:
        break;
    }
  }
  // Expand multi-line assistant text into separate display lines.
  return { lines: lines.flatMap(splitMultiline), ...(plan ? { plan } : {}) };
}

function splitMultiline(line: Line): Line[] {
  if (!line.text.includes("\n")) return [line];
  return line.text.split("\n").map((t) => ({ kind: line.kind, text: t }));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function firstLines(s: string, n: number): string {
  return s.split("\n").slice(0, n).join(" ");
}

// ── Minimal inline LanguageModelV2 mock (avoids the ai/test -> vitest dep) ───
type Step = unknown[];
const USAGE = { inputTokens: 1240, outputTokens: 320, totalTokens: 1560 };

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

async function runSession(
  model: LanguageModel,
  tools: ToolDefinition[],
  opts: { mode: "plan" | "execute"; modelString: string; prompt: string },
): Promise<UIEvent[]> {
  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const ev of sub) events.push(ev);
  })();
  // Register the mock under the model string's provider id so resolution works
  // while the status bar still shows a realistic name (e.g. anthropic/...).
  const providerId = opts.modelString.split("/")[0]!;
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry([
      { id: providerId, auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
    ]),
    toolset: new Toolset(tools),
    bus,
    cwd: REPO_ROOT,
    model: opts.modelString,
    mode: opts.mode,
  });
  await session.run(opts.prompt);
  bus.close();
  await collector;
  return events;
}

async function buildScenes(): Promise<Scene[]> {
  // A — chat with a real glob tool call against this repo.
  const ts = new Toolset(); // built-in tools (glob/read/etc.)
  const aEvents = await runSession(
    mockModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" },
        {
          type: "text-delta",
          id: "a",
          delta:
            "I'll locate the package entry points and read the manifest.\n",
        },
        { type: "text-end", id: "a" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "glob",
          input: JSON.stringify({ pattern: "packages/*/src/index.ts" }),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "b" },
        {
          type: "text-delta",
          id: "b",
          delta:
            "Found 7 package entry points. The CLI is wired in\n`packages/cli/bin/vibe.ts`: it loads config, builds the Engine,\nand hands off to the TUI (or headless `-p`). The agent loop lives in\n`packages/core/src/session.ts`.",
        },
        { type: "text-end", id: "b" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ],
    ]),
    ts.all(),
    { mode: "execute", modelString: "anthropic/claude-opus-4-8", prompt: "Where are the package entry points and how is the CLI wired?" },
  );
  const a = reduce(aEvents);

  // B — plan mode with a present_plan call.
  const planText =
    "Add a usage/cost footer to the TUI:\n1. Track cumulative usage on the session from step-finished events.\n2. Resolve per-token pricing from the models.dev catalog.\n3. Render `tokens · $cost` in the status bar, right-aligned.";
  const bEvents = await runSession(
    mockModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        {
          type: "text-delta",
          id: "p",
          delta: "Here is my plan — I won't change any files yet.\n",
        },
        { type: "text-end", id: "p" },
        {
          type: "tool-call",
          toolCallId: "t2",
          toolName: "present_plan",
          input: JSON.stringify({ plan: planText }),
        },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ],
    ]),
    new Toolset().all(),
    { mode: "plan", modelString: "anthropic/claude-opus-4-8", prompt: "Plan a usage/cost footer for the status bar" },
  );
  const b = reduce(bEvents);

  // C — /models picker (rendered from the real formatter).
  const sampleModels: ModelInfo[] = [
    { id: "claude-opus-4-8", providerId: "anthropic", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4-6", providerId: "anthropic", contextWindow: 1_000_000 },
    { id: "gpt-5.1", providerId: "openai", contextWindow: 400_000 },
    { id: "deepseek-chat", providerId: "deepseek", contextWindow: 128_000 },
    { id: "grok-4", providerId: "xai", contextWindow: 256_000 },
    { id: "qwen2.5-coder-32b", providerId: "lmstudio", contextWindow: 32_000 },
  ];
  const cLines: Line[] = [
    { kind: "user", text: "/models" },
    { kind: "notice", text: "Available models for configured providers:" },
    ...formatModelList(sampleModels)
      .split("\n")
      .map((t): Line => ({ kind: "plain", text: t })),
  ];

  return [
    {
      name: "01-chat",
      status: "anthropic/claude-opus-4-8 · execute",
      cwd: "~/vibe-codr",
      lines: a.lines,
      ...(a.plan ? { plan: a.plan } : {}),
      input: "",
    },
    {
      name: "02-plan",
      status: "anthropic/claude-opus-4-8 · plan",
      cwd: "~/vibe-codr",
      lines: b.lines,
      ...(b.plan ? { plan: b.plan } : {}),
      input: "/execute",
    },
    {
      name: "03-models",
      status: "anthropic/claude-opus-4-8 · execute",
      cwd: "~/vibe-codr",
      lines: cLines,
      input: "",
    },
  ];
}

// ── HTML rendering ──────────────────────────────────────────────────────────
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  return rows.join("\n");
}

function renderFrame(scene: Scene): string {
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
  .titlebar {
    display:flex; align-items:center; gap:8px;
    background:${COLORS.bgDim}; padding:10px 14px;
    border-bottom:1px solid #292e42;
  }
  .dot { width:12px; height:12px; border-radius:50%; }
  .title { color:${COLORS.dim}; margin-left:8px; font-size:12px; }
  .body { padding:16px 18px 14px; min-height: 380px; display:flex; flex-direction:column; }
  .transcript { flex:1; }
  .row { white-space:pre-wrap; word-break:break-word; }
  .planbox {
    border:1px solid ${COLORS.magenta}; border-radius:6px;
    padding:8px 12px; margin:8px 0;
  }
  .inputwrap {
    margin-top:14px; border:1px solid #3b4261; border-radius:6px;
    padding:8px 12px; position:relative;
  }
  .inputwrap .label {
    position:absolute; top:-9px; left:10px; background:${COLORS.bg};
    padding:0 6px; font-size:11px; color:${COLORS.dim};
  }
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
      <div class="transcript">
${renderLines(scene)}
      </div>
      <div class="inputwrap">
        <span class="label">${esc(scene.status)}</span>
        <span class="prompt">› </span>${
          scene.input
            ? `<span class="typed">${esc(scene.input)}</span><span class="cursor">&nbsp;</span>`
            : `<span class="placeholder">Ask vibe-codr…  (/plan, /execute, /model &lt;id&gt;, /goal &lt;text&gt;)</span>`
        }
      </div>
      <div class="footer">/help for commands · /plan to plan · ctrl-c to quit</div>
    </div>
  </div>
  </body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────
const outDir = process.argv[2] ?? "./screenshots";
const scenes = await buildScenes();

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const scene of scenes) {
  await page.setContent(renderFrame(scene), { waitUntil: "networkidle" });
  const el = await page.$(".term");
  const path = `${outDir}/${scene.name}.png`;
  await el!.screenshot({ path });
  console.log(`wrote ${path}`);
}
await browser.close();

