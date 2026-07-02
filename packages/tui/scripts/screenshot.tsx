/**
 * Generate faithful PNG screenshots of the vibe-codr TUI for the README.
 *
 * Unlike a hand-maintained HTML mock (which drifts from app.tsx), this drives the
 * REAL OpenTUI `App` component with a mock engine, captures the actual rendered
 * cell grid via the test renderer's `captureSpans()` (exact colors + bold/italic/
 * underline per cell), and rasterizes THAT to an HTML terminal that Playwright
 * screenshots. So the shots are pixel-for-pixel what the live app paints — there is
 * nothing to keep "in lockstep." Run: `bun packages/tui/scripts/screenshot.ts <outDir>`
 * (the `.ts` entry registers OpenTUI's Solid transform first, like `smoke.ts`).
 */
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { testRender } from "@opentui/solid";
import type { EngineClient, EngineCommand, UIEvent } from "@vibe/shared";
import { App } from "../src/app.tsx";
import { displayWidth } from "../src/markdown-blocks.ts";

/** Resolve a Chromium: the pinned CI build if present, else Playwright's managed one. */
function resolveChrome(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    const dir = readdirSync(root).find((d) => d.startsWith("chromium-") && !d.includes("headless"));
    if (dir) {
      const p = join(root, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  } catch {
    /* fall through to Playwright's own install */
  }
  return undefined;
}

// ── Mock engine ──────────────────────────────────────────────────────────────
interface EngineOpts {
  model?: string;
  mode?: "plan" | "execute";
  approvalMode?: "ask" | "auto";
  goal?: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUSD: number; cachedInputTokens?: number };
  git?: { branch: string; dirty: number; ahead: number; behind: number; worktree: boolean };
  models?: { id: string; providerId: string; name?: string; contextWindow?: number }[];
  /** `/accent` override carried by the snapshot (e.g. "#fab283" for orange). */
  accent?: string;
  /** Palette name carried by the snapshot (e.g. "tokyonight"). */
  theme?: string;
}
function makeEngine(o: EngineOpts) {
  const queue: UIEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: UIEvent) => {
    queue.push(e);
    wake?.();
    wake = null;
  };
  const engine: EngineClient = {
    snapshot: () => ({
      sessionId: "shot",
      model: o.model ?? "anthropic/claude-opus-4-8",
      mode: o.mode ?? "execute",
      approvalMode: o.approvalMode ?? "ask",
      goal: o.goal ?? null,
      usage: o.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
      tasks: [],
      theme: o.theme ?? "default",
      accentColor: o.accent ?? "",
      commandNames: ["help", "cost", "model", "theme", "approvals"],
      git: o.git,
    }),
    send: (_cmd: EngineCommand) => {},
    async listModels() {
      return o.models ?? [];
    },
    listProviders() {
      return [];
    },
    listAgents() {
      return [];
    },
    async *events() {
      while (true) {
        if (queue.length) {
          const e = queue.shift();
          if (e) yield e;
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  } as unknown as EngineClient;
  return { engine, push };
}

// ── Scene definitions ────────────────────────────────────────────────────────
type Setup = (h: {
  push: (e: UIEvent) => void;
  type: (s: string) => Promise<void>;
  key: (k: "enter" | "escape" | "tab" | "up" | "down") => void;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  settle: () => Promise<void>;
  waitFor: (needle: string) => Promise<void>;
}) => Promise<void>;
interface SceneDef {
  name: string;
  width: number;
  height: number;
  cwd: string;
  engine: EngineOpts;
  setup: Setup;
}

const U = { inputTokens: 1240, outputTokens: 320, totalTokens: 1560, costUSD: 0.0234 };
const U_CACHED = { ...U, cachedInputTokens: 1100 };

const SCENES: SceneDef[] = [
  {
    name: "00-splash",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ settle }) {
      // The empty-state splash: wordmark, "Try asking" suggestion list, input.
      await settle();
    },
  },
  {
    name: "01-chat",
    width: 92,
    height: 26,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "Where are the package entry points and how is the CLI wired?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "I'll locate the package entry points, then read the root manifest." } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t1", toolName: "glob", input: { pattern: "packages/*/src/index.ts" } } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t1", toolName: "glob", output: "packages/shared/src/index.ts\npackages/config/src/index.ts\npackages/providers/src/index.ts\npackages/tools/src/index.ts\npackages/core/src/index.ts\npackages/plugins/src/index.ts\npackages/tui/src/index.ts\npackages/cli/src/index.ts", isError: false } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "\n\nFound **8 package entry points**. The CLI is wired in `packages/cli/bin/vibecodr.ts`: it loads config, builds the `Engine`, and hands off to the TUI (or the headless `-p` path). The agent loop itself lives in `packages/core/src/session.ts`." } as UIEvent);
      push({ type: "usage-updated", sessionId: "s", usage: U } as UIEvent);
      push({ type: "context-updated", sessionId: "s", usedTokens: 24000, contextWindow: 1000000 } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("entry points");
    },
  },
  {
    name: "02-diff",
    width: 92,
    height: 28,
    cwd: "~/app",
    engine: { usage: U_CACHED, git: { branch: "main", dirty: 1, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "Make the greeting friendlier" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "I'll make the greeting warmer and add a wave." } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t2", toolName: "edit", input: { path: "greeting.ts" } } as UIEvent);
      push({ type: "file-changed", sessionId: "s", toolCallId: "t2", path: "greeting.ts", action: "edit", added: 2, removed: 2, diff: " export function greet(name: string): string {\n-  return `Hello, ${name}`;\n+  return `Hey there, ${name}! 👋`;\n }\n \n-console.log(greet(\"world\"));\n+console.log(greet(\"vibecodr\"));" } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t2", toolName: "edit", output: "applied", isError: false } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "\n\nDone — both edits applied atomically, and the unified diff is shown above." } as UIEvent);
      push({ type: "usage-updated", sessionId: "s", usage: U_CACHED } as UIEvent);
      push({ type: "context-updated", sessionId: "s", usedTokens: 24000, contextWindow: 1000000 } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("atomically");
    },
  },
  {
    name: "03-plan",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: { mode: "plan", usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "Plan a usage/cost footer for the status bar" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Here's the plan — I won't touch any files yet." } as UIEvent);
      push({ type: "plan-presented", sessionId: "s", plan: "## Add a usage / cost footer\n\n1. Track cumulative token usage from `step-finished` events on the session.\n2. Resolve per-token pricing from the models.dev catalog (cached 24h).\n3. Render `tokens · $cost` in the under-input status, right of the model.\n4. Surface cached-input tokens when the provider reports them.\n\n> Prices come live from the catalog, so new models are covered automatically." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("cumulative token");
    },
  },
  {
    name: "04-tasks",
    width: 92,
    height: 32,
    cwd: "~/vibe-codr",
    engine: { usage: U_CACHED, goal: "ship the usage/cost footer", git: { branch: "main", dirty: 3, ahead: 1, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "Implement the usage/cost footer" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "I'll implement this in small steps and track progress as I go." } as UIEvent);
      push({ type: "tasks-updated", sessionId: "s", tasks: [
        { id: "1", title: "Track cumulative usage from step-finished events", status: "completed" },
        { id: "2", title: "Resolve per-token pricing from the models.dev catalog", status: "in_progress" },
        { id: "3", title: "Render tokens · $cost in the status bar", status: "pending" },
        { id: "4", title: "Add a test for the footer formatter", status: "pending" },
      ] } as UIEvent);
      push({ type: "subagent-started", sessionId: "s", subagentId: "sa1", prompt: "Audit how the catalog exposes per-model pricing and return the exact field path." } as UIEvent);
      push({ type: "usage-updated", sessionId: "s", usage: U_CACHED } as UIEvent);
      push({ type: "context-updated", sessionId: "s", usedTokens: 420000, contextWindow: 1000000 } as UIEvent);
      await waitFor("track progress");
    },
  },
  {
    name: "05-models",
    width: 92,
    height: 28,
    cwd: "~/vibe-codr",
    engine: {
      model: "anthropic/claude-opus-4-8",
      usage: U,
      git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false },
      models: [
        { id: "claude-opus-4-8", providerId: "anthropic", contextWindow: 1_000_000 },
        { id: "claude-sonnet-5", providerId: "anthropic", contextWindow: 1_000_000 },
        { id: "gpt-5.2-codex", providerId: "codex", contextWindow: 400_000 },
        { id: "gpt-5.2", providerId: "openai", contextWindow: 400_000 },
        { id: "MiniMax-M1", providerId: "minimax", contextWindow: 1_000_000 },
        { id: "grok-4", providerId: "xai", contextWindow: 256_000 },
        { id: "deepseek-v3.1", providerId: "deepseek", contextWindow: 128_000 },
        { id: "gpt-oss:120b", providerId: "ollama", contextWindow: 128_000 },
      ],
    },
    async setup({ push, type, settle, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "switch models" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Sure — pick one below." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await settle();
      await type("/model ");
      await settle();
      await waitFor("openai/gpt-5.2");
    },
  },
  {
    name: "06-git",
    width: 92,
    height: 26,
    cwd: "~/service",
    engine: { usage: U, git: { branch: "main", dirty: 2, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "What changed in the repo?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Let me check the working tree before committing." } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t5", toolName: "git_status", input: {} } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t5", toolName: "git_status", output: " M config.ts\n?? README.md", isError: false } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "\n\nOne modified file (`config.ts`) and one new file (`README.md`). I'll stage and commit them with `git_commit`." } as UIEvent);
      push({ type: "usage-updated", sessionId: "s", usage: U } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("stage and commit");
    },
  },
  {
    name: "07-permission",
    width: 92,
    height: 24,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 4, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "format the codebase" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "I'll run the formatter across the packages." } as UIEvent);
      push({ type: "permission-request", sessionId: "s", id: "p1", toolName: "bash", input: { command: "biome format --write packages" } } as UIEvent);
      await waitFor("permission required");
    },
  },
  {
    name: "08-table",
    width: 92,
    height: 34,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      // A pros/cons table with `<br>`-driven in-cell bullet lists — exercises the
      // box-drawing grid + the <br> → real line-break conversion.
      push({ type: "user-message", sessionId: "s", text: "make a table of btc vs ethereum pros and cons" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Here's the breakdown:\n\n| Aspect | **Bitcoin (BTC)** | **Ethereum (ETH)** |\n| :-- | :-- | :-- |\n| Purpose | Digital store of value / \"digital gold\" | Programmable smart-contract platform |\n| Pros | • Largest, most liquid market<br>• Strongest brand & security<br>• Fixed 21M cap → scarcity | • Powers DeFi, NFTs, L2s<br>• Smart contracts + huge dapp ecosystem<br>• Deflationary at high activity (EIP-1559) |\n| Cons | • No smart contracts<br>• ~7 tx/s; relies on L2s<br>• Energy-intensive PoW | • Larger attack surface<br>• Inflationary issuance<br>• Scaling fragments liquidity |" } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("EIP-1559");
    },
  },
  {
    name: "09-menu",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, type, settle, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "how do I switch to plan mode?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Press Shift+Tab to cycle modes, or use the command menu below." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await settle();
      await type("/");
      await settle();
      await waitFor("commands");
    },
  },
  {
    name: "10-thread",
    width: 92,
    height: 30,
    cwd: "~/Code/ck-dashboard",
    engine: { usage: U, git: { branch: "main", dirty: 1, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      // The turn thread: a ◆ node → condensed tool steps (memory + search, each with
      // a right-aligned meta) → the answer, all on one continuous git-graph rail.
      push({ type: "user-message", sessionId: "s", text: "bt price" } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t1", toolName: "recall_memory", input: { query: "bt price" } } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t1", toolName: "recall_memory", output: Array.from({ length: 15 }, (_, i) => `memory line ${i + 1}`).join("\n"), isError: false } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t2", toolName: "web_search", input: { query: "Bitcoin BTC price now USD" } } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t2", toolName: "web_search", output: "1. CoinDesk — BTC price index\n2. CoinMarketCap — Bitcoin USD\n3. Binance — BTC/USDT\n4. Kraken — Bitcoin price\n5. Coinbase — BTC spot", isError: false } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Bitcoin (BTC) is trading around **~$58,400–58,580 USD** right now.\n\n- CoinDesk: $58,403.15\n- CoinMarketCap: $58,581.98\n- Binance: $58,368.51\n\n24-hour volume is roughly $15B–34B depending on the source." } as UIEvent);
      push({ type: "usage-updated", sessionId: "s", usage: U } as UIEvent);
      push({ type: "context-updated", sessionId: "s", usedTokens: 24000, contextWindow: 1000000 } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("CoinDesk:");
    },
  },
  {
    name: "11-chart",
    width: 92,
    height: 28,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "chart the top crypto market caps" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Here are the current market caps:\n\n```chart\n# Market cap (USD)\nBitcoin: $1.2T\nEthereum: $190B\nBNB: $88B\nSolana: $62B\nXRP: $34B\n```\n\nBitcoin dominates — more than 6× Ethereum's cap." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("dominates");
    },
  },
  {
    name: "12-pie",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "what's the market-cap share?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Rough market-cap share right now:\n\n```pie\nBitcoin: 54\nEthereum: 17\nStablecoins: 12\nOthers: 17\n```" } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("Stablecoins");
    },
  },
  {
    name: "13-line",
    width: 92,
    height: 26,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "plot BTC's recent trend" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "BTC over the last 16 sessions (indexed):\n\n```line\n# BTC price index\n52 53 51 55 58 57 60 62 59 63 66 64 68 71 69 73\n```" } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("BTC price index");
    },
  },
  {
    name: "14-weather",
    width: 92,
    height: 28,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "weather in SF?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Here's the current outlook:\n\n```weather\nlocation: San Francisco, CA\ntemp: 62°F\ncondition: Partly Cloudy\nhigh: 68\nlow: 54\nhumidity: 71%\nwind: 12 mph\nforecast: Mon 68/54 Sunny; Tue 70/55 Clear; Wed 65/53 Cloudy; Thu 63/52 Rain\n```" } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("San Francisco");
    },
  },
  {
    name: "15-sources",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "cite sources on the Ethereum Merge" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Key references:\n\n```sources\nThe Merge | ethereum.org | Ethereum's 2022 move from proof-of-work to proof-of-stake, cutting energy use ~99.95%.\nWhat the Merge means for you | coindesk.com | Explainer on staking, validators, and issuance changes post-Merge.\nProof-of-Stake FAQ | ethereum.org | How validators replace miners and secure the network.\n```" } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("The Merge");
    },
  },
  {
    name: "16-copy",
    width: 92,
    height: 22,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, drag, settle, waitFor }) {
      push({ type: "user-message", sessionId: "s", text: "how do I copy output?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Select any text with a mouse drag and it's copied to your clipboard — a toast confirms it. Cmd-click a source link to open it in the browser." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("clipboard");
      // Drag across the answer to select it → copies + flashes the toast.
      await drag(10, 9, 60, 9);
      // Let the toast slide in to its hold position (eases in over ~4 frames).
      for (let i = 0; i < 5; i++) await settle();
    },
  },
  {
    name: "17-accent",
    width: 92,
    height: 26,
    cwd: "~/vibe-codr",
    engine: { usage: U, git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false } },
    async setup({ push, type, settle, waitFor }) {
      // The /accent swatch submenu: each preset name painted in the hue it sets.
      push({ type: "user-message", sessionId: "s", text: "can I change the accent color?" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Yes — pick a preset below, or give any hex." } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await settle();
      await type("/accent ");
      await settle();
      await waitFor("violet");
    },
  },
  {
    name: "18-orange",
    width: 92,
    height: 30,
    cwd: "~/vibe-codr",
    engine: {
      usage: U,
      accent: "#fab283",
      git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false },
    },
    async setup({ settle }) {
      // `/accent orange` in effect: the wordmark fade, markers, input rail, and
      // caret all follow the warm hue — one command recolors the whole chrome.
      await settle();
    },
  },
  {
    name: "19-tokyonight",
    width: 92,
    height: 26,
    cwd: "~/vibe-codr",
    engine: {
      usage: U,
      theme: "tokyonight",
      git: { branch: "main", dirty: 0, ahead: 0, behind: 0, worktree: false },
    },
    async setup({ push, waitFor }) {
      // A ported classic theme end-to-end: its own backdrop, surfaces, and hues.
      push({ type: "user-message", sessionId: "s", text: "switch the theme to tokyonight" } as UIEvent);
      push({ type: "assistant-text-delta", sessionId: "s", delta: "Done — **Tokyo Night** is active. The palette registry also ships catppuccin, gruvbox, nord, one-dark, dracula, rosepine, kanagawa, everforest, flexoki, and vesper." } as UIEvent);
      push({ type: "tool-call-started", sessionId: "s", toolCallId: "t1", toolName: "read", input: { path: "packages/tui/src/themes.ts" } } as UIEvent);
      push({ type: "tool-call-finished", sessionId: "s", toolCallId: "t1", toolName: "read", output: "const TOKYONIGHT: Palette = { … }", isError: false } as UIEvent);
      push({ type: "turn-finished", sessionId: "s" } as UIEvent);
      await waitFor("Tokyo Night");
    },
  },
];

// ── Rasterize captureSpans() → an HTML terminal ──────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
type Span = { text: string; fg: { buffer: Record<number, number> }; bg: { buffer: Record<number, number> }; attributes: number; width?: number };
function rgb(c: { buffer: Record<number, number> }): [number, number, number] {
  return [c.buffer[0] ?? 0, c.buffer[1] ?? 0, c.buffer[2] ?? 0];
}
function spanHtml(s: Span): string {
  const [r, g, b] = rgb(s.fg);
  const [br, bg, bb] = rgb(s.bg);
  // Pin each span to its reported terminal cell width — so double-width glyphs
  // (emoji, CJK) occupy exactly their cells and never overflow the row (which would
  // ripple a filled card's right edge). Mirrors how a real terminal grid works.
  const cells = s.width ?? [...s.text].length;
  const st: string[] = [`color:rgb(${r},${g},${b})`, `width:${cells}ch`, "overflow:hidden"];
  if (br || bg || bb) st.push(`background-color:rgb(${br},${bg},${bb})`);
  const a = s.attributes | 0;
  if (a & 1) st.push("font-weight:700");
  if (a & 2) st.push("opacity:.55");
  if (a & 4) st.push("font-style:italic");
  if (a & 8) st.push("text-decoration:underline");
  // ASCII flows at exactly 1ch per char, so one pinned span suffices. Any other
  // glyph (⎇ ● ★ ▸ emoji …) may render wider/narrower than its terminal cell
  // count in the browser font — which would shift every following character and
  // clip the span's tail. Pin EACH such character to its own cell box instead,
  // so the line stays on the terminal grid no matter how the font draws a glyph.
  if (!/^[\x20-\x7e]*$/.test(s.text)) {
    const chars = [...s.text]
      .map((ch) => {
        // Block elements: terminals draw U+2580–259F procedurally, filling the
        // ENTIRE cell (including any line-spacing) — a font glyph only covers the
        // em box, which would leave gaps between rows (a rail of ▎ turns into
        // dashes). Paint them as fractional cell fills instead, like a terminal.
        const grad = blockFill(ch);
        if (grad) return `<span style="width:1ch;background-image:${grad(`rgb(${r},${g},${b})`)}"> </span>`;
        return `<span style="width:${displayWidth(ch)}ch">${esc(ch) || " "}</span>`;
      })
      .join("");
    return `<span style="${st.join(";")}">${chars}</span>`;
  }
  return `<span style="${st.join(";")}">${esc(s.text) || " "}</span>`;
}

/** CSS gradient painter for a block-element glyph (left/bottom/top fractional
 * fills + full block), or null for any other character. */
function blockFill(ch: string): ((color: string) => string) | null {
  const LEFT: Record<string, number> = { "▏": 12.5, "▎": 25, "▍": 37.5, "▌": 50, "▋": 62.5, "▊": 75, "▉": 87.5 };
  const BOTTOM: Record<string, number> = { "▁": 12.5, "▂": 25, "▃": 37.5, "▄": 50, "▅": 62.5, "▆": 75, "▇": 87.5 };
  if (ch === "█") return (c) => `linear-gradient(${c},${c})`;
  if (ch === "▀") return (c) => `linear-gradient(to bottom, ${c} 0 50%, transparent 50%)`;
  if (ch in LEFT) return (c) => `linear-gradient(to right, ${c} 0 ${LEFT[ch]}%, transparent ${LEFT[ch]}%)`;
  if (ch in BOTTOM) return (c) => `linear-gradient(to top, ${c} 0 ${BOTTOM[ch]}%, transparent ${BOTTOM[ch]}%)`;
  return null;
}
function frameHtml(spans: { lines: { spans: Span[] }[] }, cwd: string): string {
  const rows = spans.lines
    .map((l) => `<div class="row">${l.spans.map(spanHtml).join("") || "&nbsp;"}</div>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{background:#0d0d12;padding:26px}
  .term{display:inline-block;background:#000;border-radius:10px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.55)}
  .bar{display:flex;align-items:center;gap:8px;background:#0a0a0c;padding:10px 14px;border-bottom:1px solid #1c1c22}
  .dot{width:12px;height:12px;border-radius:50%}
  .barttl{color:#8a8a92;margin-left:8px;font-size:12px;font-family:Menlo,monospace}
  .grid{padding:14px 16px;font-family:Menlo,"DejaVu Sans Mono","Liberation Mono",Consolas,monospace;font-size:14px;line-height:1.5;letter-spacing:0}
  /* Each row is a fixed 1.5em box and every cell-span is an inline-block that fills
     that full height — so a background-colored cell (rail, panel, table band, pie)
     paints its ENTIRE cell rect and adjacent rows touch seamlessly, exactly like a
     real terminal (where the cell bg fills any line-spacing). Without this the CSS
     leading would leave gaps between filled rows. */
  .row{white-space:pre;font-variant-ligatures:none;height:1.5em}
  .row span{display:inline-block;height:1.5em;vertical-align:top}
  /* Per-character cell boxes (non-ASCII glyphs): keep each glyph inside its own
     terminal cell — a font-fallback glyph with a wider advance is centered and
     clipped to the cell instead of shifting the rest of the line off-grid. */
  .row span span{overflow:hidden;text-align:center}
  </style></head><body>
  <div class="term">
    <div class="bar">
      <div class="dot" style="background:#f7768e"></div>
      <div class="dot" style="background:#e0af68"></div>
      <div class="dot" style="background:#9ece6a"></div>
      <div class="barttl">vibe-codr — ${esc(cwd)}</div>
    </div>
    <div class="grid">
${rows}
    </div>
  </div>
  </body></html>`;
}

// ── Drive each scene through the real App, capture, rasterize, screenshot ─────
const outDir = process.argv[2] ?? "./docs/screenshots";
const chrome = resolveChrome();
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const page = await browser.newPage({ deviceScaleFactor: 2 });

for (const scene of SCENES) {
  const { engine, push } = makeEngine(scene.engine);
  const t = await testRender(() => <App engine={engine} />, { width: scene.width, height: scene.height });
  await t.renderOnce();
  const settle = async () => {
    await t.flush();
    await new Promise((r) => setTimeout(r, 70));
    await t.waitForVisualIdle().catch(() => {});
    await t.flush();
  };
  const waitFor = async (needle: string, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!t.captureCharFrame().includes(needle) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      await t.flush();
    }
  };
  await scene.setup({
    push,
    type: (s: string) => t.mockInput.typeText(s),
    key: (k) => {
      if (k === "enter") t.mockInput.pressEnter();
      else if (k === "escape") t.mockInput.pressEscape();
      else if (k === "tab") t.mockInput.pressTab();
      else t.mockInput.pressArrow(k);
    },
    drag: (x1: number, y1: number, x2: number, y2: number) => t.mockMouse.drag(x1, y1, x2, y2),
    settle,
    waitFor,
  });
  await settle();
  const spans = t.captureSpans() as unknown as { lines: { spans: Span[] }[] };
  await page.setContent(frameHtml(spans, scene.cwd), { waitUntil: "networkidle" });
  const el = await page.$(".term");
  const path = `${outDir}/${scene.name}.png`;
  await el!.screenshot({ path });
  console.log(`wrote ${path}`);
  await t.destroy?.().catch?.(() => {});
}
await browser.close();
process.exit(0);
