/**
 * Browser-preview mock of the `window.vibe` preload bridge.
 *
 * Lets the real renderer run in a plain Vite dev server (no Electron, no
 * engine host) so UI states can be exercised and screenshotted. Scenarios are
 * selected with `?scenario=<name>` and an optional `&theme=<name>`:
 *
 *   welcome     — no project open (WelcomeGate)
 *   splash      — project open, empty session (wordmark + centered composer + pill starters)
 *   chat        — a finished coding turn: tools, diff, markdown reply
 *   table       — finished turn whose reply is a wide GFM comparison table
 *   docs        — dense markdown: bold labels, nested lists, inline tokens
 *   sources     — assistant reply with a SourceList fence (cards + snippets)
 *   busy        — mid-turn: spinner, live tool, thinking, subagents, tasks
 *   permission  — pending permission card
 *   plan        — plan-approval card with sources + assumptions
 *   gate        — finished turn with verify gate RED banner
 *   mode        — mode dropdown open above the composer
 *   queue       — busy turn with queued follow-ups in the composer tray

 *   slash       — slash-command palette open
 *   catalog     — model catalog popover open
 *   catalog-draft — catalog open while composer draft owns the filter
 *   mention     — `@` file-mention popover open
 *   jobs        — background jobs view
 *   inspector   — session inspector rail open
 *   changes     — expanded master-detail changed-files review
 *   sessions    — cross-project session management board
 *   toast       — finished chat with a toast banner
 *   density-quiet / density-verbose — details density cue in composer
 *   ctx-hot     — high context % (topbar warn chip at laptop width)
 *   attachments — composer with dropped image + source file references
 *   cloud-progress / cloud-failure — supervised handoff progress and diagnostics
 *
 * This file never ships in the app bundle — it is dev tooling only.
 */
import type { UIEvent } from "../../src/shared/events";
import type { ProjectSummary } from "../../src/shared/protocol";
import type { EngineSnapshot, JobInfo, Task } from "../../src/shared/types";

type EventCb = (event: unknown) => void;

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "chat";
const themeOverride = params.get("theme");

const CWD = "/Users/rob/Code/acme-web";
const SID = "sess_9f2ka81c";
const now = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

/* ────────────────────────── canned data ────────────────────────── */

const PROJECTS: ProjectSummary[] = [
  {
    cwd: CWD,
    name: "acme-web",
    updatedAt: now - 2 * MIN,
    sessions: [
      { id: SID, title: "Dark mode for settings", model: "anthropic/claude-4.6-opus", mode: "execute", goal: null, createdAt: now - 3 * HOUR, updatedAt: now - 2 * MIN },
      { id: "sess_flaky01", title: "Fix flaky auth tests", model: "anthropic/claude-4.6-opus", mode: "execute", goal: null, createdAt: now - 26 * HOUR, updatedAt: now - 25 * HOUR },
      { id: "sess_billing", title: "Refactor billing webhooks", model: "openai/gpt-6.2-codex", mode: "plan", goal: null, createdAt: now - 4 * 24 * HOUR, updatedAt: now - 3 * 24 * HOUR },
    ],
  },
  {
    cwd: "/Users/rob/Code/vibe-codr",
    name: "vibe-codr",
    updatedAt: now - 8 * HOUR,
    sessions: [
      { id: "sess_tui4", title: "OpenTUI scroll anchoring", model: "anthropic/claude-4.6-opus", mode: "execute", goal: null, createdAt: now - 9 * HOUR, updatedAt: now - 8 * HOUR },
      { id: "sess_tui5", title: "Slash palette fuzzy match", model: "anthropic/claude-4.6-opus", mode: "execute", goal: null, createdAt: now - 2 * 24 * HOUR, updatedAt: now - 2 * 24 * HOUR },
    ],
  },
  {
    cwd: "/Users/rob/Code/dotfiles",
    name: "dotfiles",
    updatedAt: now - 6 * 24 * HOUR,
    sessions: [
      { id: "sess_dot1", title: "Ghostty + tmux keymaps", model: "anthropic/claude-4.5-sonnet", mode: "execute", goal: null, createdAt: now - 6 * 24 * HOUR, updatedAt: now - 6 * 24 * HOUR },
    ],
  },
];

const MODELS = [
  { id: "claude-4.6-opus", providerId: "anthropic", name: "Claude 4.6 Opus", contextWindow: 200_000 },
  { id: "claude-4.5-sonnet", providerId: "anthropic", name: "Claude 4.5 Sonnet", contextWindow: 200_000 },
  { id: "gpt-6.2-codex", providerId: "openai", name: "GPT-6.2 Codex", contextWindow: 400_000 },
  { id: "gpt-6-mini", providerId: "openai", name: "GPT-6 mini", contextWindow: 200_000 },
  { id: "gemini-3.5-pro", providerId: "google", name: "Gemini 3.5 Pro", contextWindow: 1_000_000 },
  { id: "glm-5.2", providerId: "zai", name: "GLM 5.2", contextWindow: 200_000 },
  { id: "qwen4-coder", providerId: "ollama", name: "Qwen4 Coder (local)", contextWindow: 128_000 },
];

const PROVIDERS = [
  { id: "anthropic", configured: true, keyless: false, env: ["ANTHROPIC_API_KEY"] },
  { id: "openai", configured: true, keyless: false, env: ["OPENAI_API_KEY"] },
  { id: "google", configured: false, keyless: false, env: ["GEMINI_API_KEY"] },
  { id: "zai", configured: false, keyless: false, env: ["ZAI_API_KEY"] },
  { id: "ollama", configured: true, keyless: true, env: [] },
];

const AGENTS = [
  { name: "reviewer", description: "Reviews diffs for correctness and style", model: null, mode: "plan" as const },
  { name: "test-writer", description: "Writes focused unit tests for changed code", model: "anthropic/claude-4.5-sonnet", mode: "execute" as const },
];

const SKILLS = [
  { name: "changelog", description: "Draft a changelog entry from recent commits" },
  { name: "release", description: "Cut a release: bump, tag, notes, publish" },
];

const MCP = [
  { name: "github", connected: true, configured: true, toolCount: 12, resourceCount: 2, promptCount: 0 },
  { name: "postgres", connected: false, configured: true, toolCount: 6, resourceCount: 0, promptCount: 0, error: "connection refused" },
];

const FILES = [
  "src/settings/Appearance.tsx",
  "src/settings/SettingsPage.tsx",
  "src/settings/index.ts",
  "src/app/App.tsx",
  "src/app/theme/ThemeProvider.tsx",
  "src/app/theme/tokens.css",
  "src/components/Button.tsx",
  "src/components/Switch.tsx",
  "package.json",
  "README.md",
];

const JOBS: JobInfo[] = [
  {
    id: "job_dev",
    command: "npm run dev",
    status: "running",
    exitCode: null,
    pid: 48123,
    servers: ["http://localhost:3000"],
    outputTail: "  VITE v6.3.5  ready in 412 ms\n\n  ➜  Local:   http://localhost:3000/\n  ➜  Network: use --host to expose\n  ➜  press h + enter to show help",
  },
  {
    id: "job_test",
    command: "npm run test:watch -- settings",
    status: "exited",
    exitCode: 0,
    pid: 48200,
    servers: [],
    outputTail: " ✓ src/settings/Appearance.test.tsx (9 tests) 214ms\n ✓ src/settings/SettingsPage.test.tsx (3 tests) 88ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  1.42s",
  },
];

const TASKS_DONE: Task[] = [
  { id: "t1", title: "Locate settings appearance panel", status: "completed" },
  { id: "t2", title: "Add theme toggle wired to ThemeProvider", status: "completed" },
  { id: "t3", title: "Persist preference and run tests", status: "completed" },
];

const TASKS_LIVE: Task[] = [
  { id: "t1", title: "Map current webhook handlers", status: "completed" },
  { id: "t2", title: "Introduce idempotency keys on ingest", status: "in_progress" },
  { id: "t3", title: "Backfill dedupe table migration", status: "pending" },
  { id: "t4", title: "Update retry policy + integration tests", status: "pending" },
];

const DIFF = [
  "@@ -12,7 +12,14 @@ export function Appearance() {",
  "   const { theme, setTheme } = useTheme();",
  "-  return (",
  "-    <section className=\"appearance\">",
  "-      <h2>Appearance</h2>",
  "+  const options = [\"system\", \"light\", \"dark\"] as const;",
  "+  return (",
  "+    <section className=\"appearance\">",
  "+      <h2>Appearance</h2>",
  "+      <SegmentedControl",
  "+        value={theme}",
  "+        options={options}",
  "+        onChange={setTheme}",
  "+      />",
  "     </section>",
  "   );",
].join("\n");

/* ────────────────────────── snapshot ────────────────────────── */

function baseSnapshot(): EngineSnapshot {
  return {
    sessionId: SID,
    model: "anthropic/claude-4.6-opus",
    mode: "execute",
    goal: null,
    history: [],
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
    busy: false,
    theme: themeOverride ?? "default",
    accentColor: "",
    details:
      scenario === "density-quiet"
        ? "quiet"
        : scenario === "density-verbose"
          ? "verbose"
          : "normal",
    mouse: false,
    approvalMode: "ask",
    commandNames: [
      "help", "model", "models", "providers", "agents", "skills", "mcp",
      "theme", "accent", "details", "reasoning", "approvals", "clear", "new",
      "resume", "jobs", "keys", "undo", "redo", "goal", "compact", "review", "exit",
    ],
    subagentModel: undefined,
    reasoning: "medium",
    git: { branch: "main", dirty: 3, ahead: 1, behind: 0, worktree: false },
  };
}

/* ────────────────────────── event bus ────────────────────────── */

const listeners = new Set<EventCb>();
const cloudStatusListeners = new Set<(event: import("../../src/shared/cloud").CloudStatusEvent) => void>();
let timelineStarted = false;

function emit(event: UIEvent): void {
  for (const cb of [...listeners]) cb(event);
}

function emitCloud(event: import("../../src/shared/cloud").CloudStatusEvent): void {
  for (const cb of [...cloudStatusListeners]) cb(event);
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function settle(): void {
  (window as unknown as { __previewSettled: boolean }).__previewSettled = true;
}

function setComposerDraft(value: string): void {
  const el = document.querySelector<HTMLTextAreaElement>(".composer-input");
  if (!el) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

function pressComposerEnter(): void {
  const el = document.querySelector<HTMLTextAreaElement>(".composer-input");
  el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function previewDropAttachments(): void {
  const composer = document.querySelector<HTMLElement>(".composer-wrap");
  if (!composer) return;
  const png = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
    (char) => char.charCodeAt(0),
  );
  const image = new File([png], "Reference frame.png", { type: "image/png" }) as File & { path?: string };
  const source = new File(["export function Panel() { return null; }\n"], "Panel.tsx", { type: "text/typescript" }) as File & { path?: string };
  Object.defineProperty(source, "path", { value: `${CWD}/src/components/Panel.tsx` });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(image);
  dataTransfer.items.add(source);
  for (const type of ["dragenter", "dragover"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    composer.dispatchEvent(event);
  }
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  composer.dispatchEvent(drop);
}

/* ────────────────────────── scenario timelines ────────────────────────── */

async function streamAssistant(text: string, chunk = 48): Promise<void> {
  for (let i = 0; i < text.length; i += chunk) {
    emit({ type: "assistant-text-delta", sessionId: SID, delta: text.slice(i, i + chunk) });
    await sleep(4);
  }
}

async function chatTurn(): Promise<void> {
  emit({ type: "user-message", sessionId: SID, text: "Add dark mode support to the settings page — respect the system preference and let users override it." });
  await sleep(40);

  emit({ type: "reasoning-delta", sessionId: SID, delta: "Scanning the settings tree for the appearance panel and the theme provider so the toggle lands in the right place." });
  await sleep(60);

  emit({ type: "tool-call-started", sessionId: SID, toolCallId: "tc_grep", toolName: "grep", input: { pattern: "ThemeProvider", path: "src" } });
  await sleep(90);
  emit({ type: "tool-call-finished", sessionId: SID, toolCallId: "tc_grep", toolName: "grep", isError: false, output: "src/app/theme/ThemeProvider.tsx:18\nsrc/app/App.tsx:9\nsrc/settings/Appearance.tsx:4" });

  emit({ type: "tool-call-started", sessionId: SID, toolCallId: "tc_read", toolName: "read", input: { path: "src/settings/Appearance.tsx" } });
  await sleep(80);
  emit({ type: "tool-call-finished", sessionId: SID, toolCallId: "tc_read", toolName: "read", isError: false, output: "export function Appearance() {\n  const { theme, setTheme } = useTheme();\n  return (\n    <section className=\"appearance\">\n      <h2>Appearance</h2>\n    </section>\n  );\n}" });

  emit({ type: "tool-call-started", sessionId: SID, toolCallId: "tc_edit", toolName: "edit", input: { path: "src/settings/Appearance.tsx" } });
  await sleep(70);
  emit({ type: "tool-call-finished", sessionId: SID, toolCallId: "tc_edit", toolName: "edit", isError: false, output: "edited src/settings/Appearance.tsx" });
  emit({ type: "file-changed", sessionId: SID, toolCallId: "tc_edit", path: "src/settings/Appearance.tsx", action: "edit", diff: DIFF, added: 11, removed: 4 });
  await sleep(30);

  emit({ type: "checkpoint-created", id: "cp_1", label: "before settings dark-mode edit" });

  emit({ type: "tool-call-started", sessionId: SID, toolCallId: "tc_test", toolName: "bash", input: { command: "npm run test -- settings" } });
  await sleep(1300);
  emit({ type: "tool-call-finished", sessionId: SID, toolCallId: "tc_test", toolName: "bash", isError: false, output: " ✓ src/settings/Appearance.test.tsx (9 tests) 214ms\n ✓ src/settings/SettingsPage.test.tsx (3 tests) 88ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)" });
  await sleep(40);

  await streamAssistant(
    [
      "Dark mode is wired up end to end. The settings page now offers **system / light / dark**, and the choice persists across launches.",
      "",
      "### What changed",
      "",
      "- `Appearance.tsx` renders a `SegmentedControl` bound to `useTheme()`",
      "- `ThemeProvider` resolves `system` against `prefers-color-scheme` and stores overrides in `localStorage`",
      "- Tokens in `tokens.css` gained a `[data-theme=\"dark\"]` block, so components pick the palette up for free",
      "",
      "```tsx",
      "const options = [\"system\", \"light\", \"dark\"] as const;",
      "<SegmentedControl value={theme} options={options} onChange={setTheme} />",
      "```",
      "",
      "All 12 settings tests pass. Want me to sweep the remaining hard-coded colors in `src/components` next?",
    ].join("\n"),
  );

  emit({ type: "tasks-updated", sessionId: SID, tasks: TASKS_DONE });
  emit({ type: "usage-updated", sessionId: SID, usage: { inputTokens: 48_200, outputTokens: 9_310, totalTokens: 57_510, costUSD: 0.4182, cachedInputTokens: 31_020 } });
  emit({ type: "context-updated", sessionId: SID, usedTokens: 57_510, contextWindow: 200_000 });
  emit({ type: "git-updated", sessionId: SID, git: { branch: "main", dirty: 4, ahead: 1, behind: 0, worktree: false } });
  await sleep(60);
  emit({ type: "turn-finished", sessionId: SID });
  emit({ type: "session-idle", sessionId: SID });
  emit({
    type: "engine-idle",
    sessionId: SID,
    gate: scenario === "gate" ? "red" : "green",
  });
}

/** Repro for GFM tables — wide prose cells must not clip on the left edge. */
async function tableTurn(): Promise<void> {
  emit({
    type: "user-message",
    sessionId: SID,
    text: "make a table of pros/cons of eth vs btc",
  });
  await sleep(40);

  await streamAssistant(
    [
      "Here is a comparison of the primary strengths and weaknesses of Bitcoin (BTC) and Ethereum (ETH).",
      "",
      "| Aspect | Bitcoin (BTC) | Ethereum (ETH) |",
      "| --- | --- | --- |",
      "| **Role** | Digital gold / store of value | Utility platform: a programmable blockchain for apps and contracts |",
      "| **Ecosystem** | Payments, custody, ETFs | Largest hub for DeFi, NFTs, and tokenized assets |",
      "| **Pros** | Scarcity, security, brand recognition | Staking yield, rapid upgrades, flexible design |",
      "| **Cons** | Limited scripting, energy debate (PoW history) | Fee volatility, complexity, staking centralization risk |",
      "| **Monetary policy** | Fixed supply, predictable issuance | Inflation/deflation mix; more complex policy |",
      "",
      "Use BTC when you want a long-horizon reserve asset; use ETH when you need programmable settlement and on-chain apps.",
    ].join("\n"),
    120,
  );

  emit({ type: "usage-updated", sessionId: SID, usage: { inputTokens: 2_400, outputTokens: 680, totalTokens: 3_080, costUSD: 0.012, cachedInputTokens: 0 } });
  emit({ type: "context-updated", sessionId: SID, usedTokens: 3_080, contextWindow: 200_000 });
  await sleep(40);
  emit({ type: "turn-finished", sessionId: SID });
  emit({ type: "session-idle", sessionId: SID });
  emit({ type: "engine-idle", sessionId: SID, gate: "green" });
}

/** Dense markdown — bold labels, nested detail, inline tokens (Streamdown attrs). */
async function docsTurn(): Promise<void> {
  emit({
    type: "user-message",
    sessionId: SID,
    text: "Summarize the design system primitives we just standardized.",
  });
  await sleep(40);

  await streamAssistant(
    [
      "**Primitives standardized:**",
      "",
      "- **Button**",
      "  - default: `h-8 px-3 text-[13px] rounded-lg gap-1.5`",
      "  - sm: `h-7 px-2.5 text-[12px]`",
      "  - lg: `h-9`",
      "  - icon: `h-8 w-8`",
      "- **Badge**: `rounded-full px-2 py-0 text-[11px] leading-5`",
      "- **Input**: `h-8 rounded-lg px-3 text-[13px]` · placeholder muted · focus ring",
      "- **Card**: `rounded-[16px]` hairline border + quiet shadow",
      "  - header `p-4 pb-3` · title 13 · description 12",
      "  - content `p-4 pt-0`",
      "- **Skeleton**: soft surface fill · `rounded-md` · `h-4`",
      "",
      "**Shell:** rail / transcript / composer share the Graphite token set — no zinc, no violet.",
    ].join("\n"),
    100,
  );

  emit({ type: "usage-updated", sessionId: SID, usage: { inputTokens: 1_800, outputTokens: 420, totalTokens: 2_220, costUSD: 0.008, cachedInputTokens: 0 } });
  emit({ type: "context-updated", sessionId: SID, usedTokens: 2_220, contextWindow: 200_000 });
  await sleep(40);
  emit({ type: "turn-finished", sessionId: SID });
  emit({ type: "session-idle", sessionId: SID });
  emit({ type: "engine-idle", sessionId: SID, gate: "green" });
}

/** Source cards — title / domain / snippet hierarchy for visual polish. */
async function sourcesTurn(): Promise<void> {
  emit({
    type: "user-message",
    sessionId: SID,
    text: "Pull the B&G rebrand sources and quote the navy decisions.",
  });
  await sleep(40);

  await streamAssistant(
    [
      "Sources: B&G media kit & 2024 logo rebrand navy deepening [2], Matchstic Going beyond the build [7], homepage [3], Pantone 281C #00205B [14][17].",
      "",
      "```sources",
      "Brasfield & Gorrie Unveils New Logo and Brand Identity | logos-world.net | Deepened navy, refined ampersand, General Contractors dropped, modern contemporary type.",
      "Brasfield & Gorrie | Matchstic | Going beyond the build — brand system, typography, and identity craft.",
      "Brasfield & Gorrie | www.brasfieldgorrie.com | Homepage — primary mark, navy field, construction leadership.",
      "Pantone 281 C | pantone.com | #00205B reference for the deepened navy used across the rebrand.",
      "```",
    ].join("\n"),
    100,
  );

  emit({ type: "usage-updated", sessionId: SID, usage: { inputTokens: 3_100, outputTokens: 540, totalTokens: 3_640, costUSD: 0.014, cachedInputTokens: 0 } });
  emit({ type: "context-updated", sessionId: SID, usedTokens: 3_640, contextWindow: 200_000 });
  await sleep(40);
  emit({ type: "turn-finished", sessionId: SID });
  emit({ type: "session-idle", sessionId: SID });
  emit({ type: "engine-idle", sessionId: SID, gate: "green" });
}

async function busyTurn(): Promise<void> {
  emit({ type: "user-message", sessionId: SID, text: "Refactor the billing webhook handlers to be idempotent, then prove it with the integration suite." });
  await sleep(50);
  emit({ type: "tasks-updated", sessionId: SID, tasks: TASKS_LIVE });
  emit({ type: "reasoning-delta", sessionId: SID, delta: "Stripe retries webhooks aggressively, so ingest must dedupe on event id before any side effect.\n" });
  await sleep(40);
  emit({ type: "reasoning-delta", sessionId: SID, delta: "Plan: wrap handlers in an idempotency guard keyed on event.id, back it with a unique index, replay the fixture stream twice and diff ledger rows." });
  await sleep(60);

  emit({ type: "subagent-started", sessionId: SID, subagentId: "sub_tests", prompt: "Write integration tests replaying duplicate webhook deliveries" });
  emit({ type: "subagent-activity", sessionId: SID, subagentId: "sub_tests", label: "$ vitest run billing --reporter=dot" });
  emit({ type: "subagent-started", sessionId: SID, subagentId: "sub_audit", prompt: "Audit handlers for non-idempotent side effects" });
  emit({ type: "subagent-activity", sessionId: SID, subagentId: "sub_audit", label: "read src/billing/handlers/invoice.ts" });
  await sleep(20);

  emit({ type: "orchestration-task", sessionId: SID, taskId: "dag_recon", objective: "Recon existing webhook handler structure", status: "completed", attempts: 1, durationMs: 4200 });
  emit({ type: "orchestration-task", sessionId: SID, taskId: "dag_impl", objective: "Add idempotency guard to invoice handler", status: "running" });
  emit({ type: "orchestration-task", sessionId: SID, taskId: "dag_skip", objective: "Migrate legacy Stripe events (already handled)", status: "skipped" });
  emit({ type: "orchestration-task", sessionId: SID, taskId: "dag_fail", objective: "Run chaos replay with corrupted payload", status: "failed", attempts: 3, durationMs: 8100 });
  await sleep(20);

  emit({ type: "tool-call-started", sessionId: SID, toolCallId: "tc_mig", toolName: "bash", input: { command: "npm run db:migrate -- --name add-webhook-dedupe" } });
  emit({ type: "tool-call-progress", sessionId: SID, toolCallId: "tc_mig", chunk: "Applying 20260710_add_webhook_dedupe…\n" });
  await sleep(80);
  emit({ type: "tool-call-progress", sessionId: SID, toolCallId: "tc_mig", chunk: "CREATE TABLE webhook_events (id text primary key, seen_at timestamptz)\n" });

  emit({ type: "usage-updated", sessionId: SID, usage: { inputTokens: 112_400, outputTokens: 18_240, totalTokens: 130_640, costUSD: 1.0466, cachedInputTokens: 88_100 } });
  emit({ type: "context-updated", sessionId: SID, usedTokens: 130_640, contextWindow: 200_000 });
  // stays busy — no idle events
}

async function permissionTurn(): Promise<void> {
  emit({ type: "user-message", sessionId: SID, text: "Clean the build artifacts and do a strict rebuild of every workspace." });
  await sleep(60);
  emit({
    type: "permission-request",
    sessionId: SID,
    id: "perm_1",
    toolName: "bash",
    input: { command: "rm -rf dist .turbo/cache && npm run build --workspaces && node scripts/verify-dist.mjs --strict" },
  });
}

async function planTurn(): Promise<void> {
  emit({ type: "user-message", sessionId: SID, text: "Plan a migration from Express to Fastify for the API gateway." });
  await sleep(60);
  emit({
    type: "plan-presented",
    sessionId: SID,
    plan: [
      "1. Inventory the surface — 41 routes, 9 middleware chains, 3 custom error handlers.",
      "2. Introduce a Fastify app behind the same port with @fastify/express as a bridge.",
      "3. Port middleware: auth → preHandler hook, rate-limit → @fastify/rate-limit, logging → pino (native).",
      "4. Migrate routes in three slices (public, authed, admin) with parity tests per slice.",
      "5. Remove the bridge, enable schema validation on hot paths, load-test against the Express baseline.",
    ].join("\n"),
    sources: [
      { url: "https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/", title: "Fastify migration guide" },
      { url: "https://github.com/fastify/fastify-express", title: "fastify-express bridge" },
      { url: "https://fastify.dev/docs/latest/Reference/Hooks/", title: "Fastify lifecycle hooks" },
    ],
    assumptions: [
      "No middleware mutates res after headers are sent",
      "Rate limits can move from per-process memory to Redis without behavior change",
    ],
    ungrounded: false,
  });
  // Plan waits for user decision — turn is idle (matches engine after plan-presented).
  emit({ type: "turn-finished", sessionId: SID });
  emit({ type: "session-idle", sessionId: SID });
  emit({ type: "engine-idle", sessionId: SID, gate: "green" });
}

async function inspectorExtras(): Promise<void> {
  emit({ type: "subagent-started", sessionId: SID, subagentId: "sub_tests", prompt: "Write integration tests replaying duplicate webhook deliveries" });
  await sleep(20);
  emit({ type: "subagent-finished", sessionId: SID, subagentId: "sub_tests", result: "Added billing/replay.int.test.ts — 6 cases covering duplicate, out-of-order, and gap deliveries. All green." });
  emit({ type: "checkpoint-created", id: "cp_2", label: "after idempotency guard" });
}

/* ────────────────────────── timeline dispatch ────────────────────────── */

async function runTimeline(): Promise<void> {
  if (timelineStarted) return;
  timelineStarted = true;
  await sleep(30);

  switch (scenario) {
    case "welcome":
    case "splash":
      break;
    case "chat":
    case "light":
    case "gate":
      await chatTurn();
      break;
    case "table":
      await tableTurn();
      break;
    case "docs":
      await docsTurn();
      break;
    case "sources":
      await sourcesTurn();
      break;
    case "busy":
      await busyTurn();
      break;
    case "queue":
      await busyTurn();
      emit({
        type: "queue-changed",
        active: { id: "q_active", label: "Refactor billing webhook handlers" },
        pending: [
          { id: "q1", label: "Tighten project menu layout and confirm actions" },
          { id: "q2", label: "Polish source cards spacing and hierarchy" },
          { id: "q3", label: "Use overlay scrollbars that hide when idle" },
          { id: "q4", label: "Refine hover copy chips so they never cover prose" },
          { id: "q5", label: "Ship the VC app icon for Dock and Finder" },
        ],
      });
      break;
    case "sessions":
      await busyTurn();
      emit({ type: "jobs-changed", sessionId: SID, jobs: JOBS });
      emit({
        type: "queue-changed",
        active: { id: "q_active", label: "Refactor billing webhook handlers" },
        pending: [
          { id: "q1", label: "Run the integration suite" },
          { id: "q2", label: "Review the final diff" },
        ],
      });
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_mig",
        path: "src/billing/webhook.ts",
        action: "edit",
        diff: "@@ -18,2 +18,3 @@\n+await claimWebhookEvent(event.id);\n handle(event);",
        added: 1,
        removed: 0,
      });
      break;
    case "permission":
      await permissionTurn();
      break;
    case "plan":
      await planTurn();
      break;
    case "mode":
      await sleep(160);
      document.querySelector<HTMLButtonElement>(".mode-trigger")?.click();
      break;
    case "onboarding":
      // Providers mocked unconfigured below — the setup modal renders.
      break;
    case "slash":
      await sleep(120);
      setComposerDraft("/");
      break;
    case "catalog":
      await sleep(120);
      setComposerDraft("/model");
      await sleep(600); // live-draft effect fetches models and opens the picker
      break;
    case "catalog-draft":
      await sleep(120);
      setComposerDraft("/model opus");
      await sleep(600);
      break;
    case "mention":
      await sleep(120);
      setComposerDraft("Refactor @set");
      break;
    case "jobs":
      emit({ type: "jobs-changed", sessionId: SID, jobs: JOBS });
      await sleep(120);
      setComposerDraft("/jobs");
      await sleep(80);
      pressComposerEnter();
      // Stream more output so the live terminal follow behavior is visible.
      await sleep(400);
      emit({
        type: "jobs-changed",
        sessionId: SID,
        jobs: [
          {
            ...JOBS[0]!,
            outputTail:
              JOBS[0]!.outputTail +
              "\n\n  12:04:18 AM [vite] hmr update /src/App.tsx\n  12:04:19 AM [vite] page reload index.html",
          },
          JOBS[1]!,
        ],
      });
      await sleep(500);
      emit({
        type: "jobs-changed",
        sessionId: SID,
        jobs: [
          {
            ...JOBS[0]!,
            outputTail:
              JOBS[0]!.outputTail +
              "\n\n  12:04:18 AM [vite] hmr update /src/App.tsx\n  12:04:19 AM [vite] page reload index.html\n  12:04:22 AM [vite] hmr update /src/styles.css",
          },
          JOBS[1]!,
        ],
      });
      break;
    case "inspector":
      await chatTurn();
      await inspectorExtras();
      await sleep(80);
      document.querySelector<HTMLButtonElement>('[aria-label="Show session panel"]')?.click();
      break;
    case "changes":
      await chatTurn();
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_theme_provider",
        path: "src/app/theme/ThemeProvider.tsx",
        action: "edit",
        diff: "@@ -8,3 +8,6 @@\n export function ThemeProvider() {\n+  const preferred = matchMedia(\"(prefers-color-scheme: dark)\");\n+  const resolved = theme === \"system\" ? preferred.matches : theme === \"dark\";\n   return <ThemeContext.Provider value={{ theme, setTheme }}>\n",
        added: 2,
        removed: 0,
      });
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_tokens",
        path: "src/app/theme/tokens.css",
        action: "edit",
        diff: "@@ -20,2 +20,7 @@\n :root { --surface: white; }\n+\n+[data-theme=\"dark\"] {\n+  --surface: #121212;\n+  --text: #f2f2f2;\n+}\n",
        added: 5,
        removed: 0,
      });
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_sidebar_layout",
        path: "src/renderer/layout/activity/ActivitySidebarHeader.tsx",
        action: "edit",
        diff: "@@ -14,5 +14,5 @@\n-export function PanelHeading({ title }: Props) {\n-  return <h2 className=\"panel-title\">{title}</h2>;\n+export function ActivitySidebarHeader({ title, subtitle }: Props) {\n+  return <header><h2>{title}</h2><p>{subtitle}</p></header>;\n }\n",
        added: 2,
        removed: 2,
      });
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_diff_parser",
        path: "src/shared/review/diff/parseUnifiedDiff.ts",
        action: "edit",
        diff: "@@ -31,4 +31,5 @@\n export function parseUnifiedDiff(value: string) {\n-  return value.split(\"\\n\");\n+  const lines = value.split(\"\\n\");\n+  return lines.map(classifyLine);\n }\n",
        added: 2,
        removed: 1,
      });
      emit({
        type: "file-changed",
        sessionId: SID,
        toolCallId: "tc_root_docs",
        path: "README.md",
        action: "edit",
        diff: "@@ -1,3 +1,4 @@\n # Vibe Codr\n-A terminal coding harness.\n+A focused desktop coding workspace.\n+Review every change without leaving the conversation.\n",
        added: 2,
        removed: 1,
      });
      await sleep(80);
      window.dispatchEvent(new CustomEvent("vibe-preview-open-panel", { detail: "changes" }));
      break;
    case "toast":
      await chatTurn();
      window.dispatchEvent(
        new CustomEvent("vibe-preview-toast", { detail: "Session archived" }),
      );
      break;
    case "density-quiet":
    case "density-verbose":
      await chatTurn();
      break;
    case "ctx-hot":
      await chatTurn();
      emit({
        type: "context-updated",
        sessionId: SID,
        usedTokens: 188_000,
        contextWindow: 200_000,
      });
      break;
    case "attachments":
      await sleep(240);
      previewDropAttachments();
      break;
    case "cloud-progress":
    case "cloud-failure":
      window.dispatchEvent(new CustomEvent("vibe-preview-open-panel", { detail: "cloud" }));
      await sleep(180);
      document.querySelector<HTMLButtonElement>(".cloud-handoff-footer .primary")?.click();
      await sleep(650);
      break;
    default:
      await chatTurn();
  }

  await sleep(400);
  settle();
}

/* ────────────────────────── window.vibe ────────────────────────── */

if (scenario === "welcome") {
  window.localStorage.removeItem("vibe.lastCwd");
  // No project → no bootstrap/snapshot ever fires; settle on a timer instead.
  window.setTimeout(() => void runTimeline(), 300);
} else {
  window.localStorage.setItem("vibe.lastCwd", CWD);
}

if (scenario === "sessions") {
  window.localStorage.setItem("vibe.session-board.v1", JSON.stringify({
    view: "board",
    status: "all",
    project: "all",
    mode: "all",
    sort: "updated",
    statuses: {
      [`${CWD}\u0000sess_billing`]: "review",
      "/Users/rob/Code/vibe-codr\u0000sess_tui5": "review",
      "/Users/rob/Code/dotfiles\u0000sess_dot1": "done",
    },
  }));
}

// Auto-open full workspace/panel preview scenarios.
if (scenario === "settings" || scenario === "git" || scenario === "sessions") {
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("vibe-preview-open-panel", { detail: scenario }),
    );
  }, 400);
}

const rpcHandlers: Record<string, (params?: Record<string, unknown>) => unknown> = {
  snapshot: () => {
    void runTimeline();
    return baseSnapshot();
  },
  listProjects: () => PROJECTS,
  listModels: () => MODELS,
  listProviders: () =>
    scenario === "onboarding"
      ? PROVIDERS.map((p) => ({ ...p, configured: false, keyless: false }))
      : PROVIDERS,
  listAgents: () => AGENTS,
  listSkills: () => SKILLS,
  listMcp: () => MCP,
  listSessions: () => PROJECTS[0]!.sessions,
  finalize: () => null,
  renameSession: () => true,
  deleteSession: () => true,
  archiveSession: () => true,
  providerAuthStatus: (params) => ({ providerId: params?.providerId, state: "disconnected" }),
  beginProviderAuth: (params) => ({
    sessionId: "preview-auth",
    providerId: params?.providerId,
    method: params?.authMethod,
    url: "https://example.com/connect",
    expiresAt: Date.now() + 300_000,
  }),
  cancelProviderAuth: () => null,
  logoutProviderAuth: () => null,
};

const mock = {
  bootstrap: async () => ({ ok: true as const, sessionId: SID, launch: "mock" }),
  send: async () => ({ ok: true as const }),
  rpc: async (method: string, params?: Record<string, unknown>) => {
    const handler = rpcHandlers[method];
    if (!handler) return { ok: false as const, error: `mock rpc: ${method} not implemented` };
    return { ok: true as const, value: handler(params) };
  },
  listProjects: async () => ({ ok: true as const, value: PROJECTS }),
  renameProject: async () => ({ ok: true as const }),
  archiveProject: async () => ({ ok: true as const }),
  deleteProject: async () => ({ ok: true as const }),
  renameSession: async () => ({ ok: true as const }),
  deleteSession: async () => ({ ok: true as const }),
  archiveSession: async () => ({ ok: true as const }),
  stop: async () => ({ ok: true as const }),
  quit: () => undefined,
  onEvent: (cb: EventCb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  onReady: () => () => undefined,
  onFatal: () => () => undefined,
  onMenuAction: () => () => undefined,
  cloudSettings: async () => ({ ok: true as const, value: {
    experimentalEnabled: true,
    transferModelCredentials: true,
    lastProvider: "e2b" as const,
    autoPauseMinutes: 10,
    deleteOnReturn: true,
    providers: { e2b: { configured: true }, vercel: { configured: false } },
    credentialBindings: [], allowedDomains: [], additionalExclusions: [],
  } }),
  updateCloudSettings: async () => mock.cloudSettings(),
  connectCloudProvider: async () => mock.cloudSettings(),
  disconnectCloudProvider: async () => mock.cloudSettings(),
  testCloudProvider: async () => ({ ok: true as const, value: { ok: true } }),
  saveCloudCredentialBinding: async () => mock.cloudSettings(),
  removeCloudCredentialBinding: async () => mock.cloudSettings(),
  listCloudSessions: async () => ({
    ok: true as const,
    value: scenario === "mode" || scenario === "sessions"
      ? [{
          sessionId: "sess_flaky01",
          model: "anthropic/claude-4.6-opus",
          workspaceId: "preview-acme-web",
          sourceRoot: CWD,
          provider: "e2b" as const,
          sandboxId: "preview-cloud-sandbox",
          sandboxName: "vibe-preview-cloud",
          ownershipGeneration: 1,
          status: "running" as const,
          baseFingerprint: "preview",
          updatedAt: Date.now() - 25 * HOUR,
        }]
      : [],
  }),
  deleteCloudSessionCopy: async () => ({ ok: true as const }),
  recoverLostCloudSession: async () => ({ ok: false as const, error: "No missing cloud session" }),
  handoffToCloud: async () => {
    const startedAt = Date.now() - 8_000;
    emitCloud({ sessionId: SID, status: "starting", message: "Starting the cloud agent", progress: 0.72, stage: "starting-agent", startedAt });
    await sleep(180);
    if (scenario === "cloud-failure") {
      const details = { code: "daemon-exited" as const, stage: "starting-agent" as const, retryable: true, diagnostic: "Error: Cannot find module 'node-pty'" };
      emitCloud({ sessionId: SID, status: "recoverable-error", message: "Cloud agent exited before it became healthy", progress: 0.72, stage: "starting-agent", startedAt });
      return { ok: false as const, error: "Cloud agent exited before it became healthy", details };
    }
    emitCloud({ sessionId: SID, status: "starting", message: "Checking the authenticated cloud agent", progress: 0.82, stage: "checking-health", startedAt });
    return await new Promise<never>(() => undefined);
  },
  reconnectCloudSession: async () => ({ ok: false as const, error: "No cloud session" }),
  resumeCloudSessionLocally: async () => ({ ok: false as const, error: "No cloud session" }),
  onCloudStatus: (cb: (event: import("../../src/shared/cloud").CloudStatusEvent) => void) => {
    cloudStatusListeners.add(cb);
    return () => cloudStatusListeners.delete(cb);
  },
  setSettingsDirty: () => undefined,
  openProject: async () => CWD,
  ensureChatsDir: async () => "/Users/rob/.vibe/chats",
  openExternal: async () => undefined,
  showItem: async () => undefined,
  readTextFile: async ({ path }: { cwd: string; path: string }) => ({
    ok: true as const,
    text: `// preview of ${path}\nexport function demo() {\n  return true;\n}\n`,
    truncated: false,
  }),
  composeInEditor: async () => ({ ok: false, reason: "no-editor" as const }),
  getPath: async () => "/Users/rob",
  getPathForFile: (file: File & { path?: string }) => file.path ?? `${CWD}/${file.name}`,
  listFiles: async ({ query }: { query: string }) => {
    const q = query.toLowerCase();
    return FILES.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  },
  pasteClipboard: async () => ({ kind: "none" as const }),
  writeClipboardText: async (text: string) => {
    await navigator.clipboard.writeText(text);
    return { ok: true as const };
  },
  globalConfigPath: async () => "/Users/rob/.config/vibe-codr/config.json",

  // Config mocks
  readConfig: async (opts: { scope: "global" | "project" }) => {
    if (opts.scope === "project") {
      return {
        ok: true as const,
        config: {
          model: "anthropic/claude-opus-4-8",
          mode: "execute",
          approvalMode: "ask",
          details: "normal",
          mcp: { servers: { "filesystem": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } } },
        },
        path: "/Users/rob/Code/acme-web/.vibe/config.json",
        raw: "{}",
      };
    }
    return {
      ok: true as const,
      config: {
        model: "anthropic/claude-opus-4-8",
        planModel: "openai/o3",
        mode: "execute",
        approvalMode: "ask",
        theme: "default",
        details: "normal",
        mouse: true,
        maxSteps: 64,
        subagent: { maxDepth: 3, maxParallel: 8, timeoutMs: 300000, model: "openai/gpt-5.5" },
        memory: { semantic: { enabled: true, model: "local" }, proactiveRecall: true, sessionDigest: true },
        search: { enabled: true },
        build: { enabled: true, gate: { enabled: true, maxRounds: 5, checks: ["typecheck", "test", "build"] } },
        providers: {
          openai: { apiKey: "sk-…", baseURL: "https://api.openai.com/v1" },
          anthropic: { apiKey: "sk-ant-…" },
          ollama: { baseURL: "http://localhost:11434" },
        },
        permissions: [{ tool: "bash", match: "git push*", action: "ask" }],
        caching: { enabled: true, cacheTools: true, cacheConversation: true },
      },
      path: "/Users/rob/.config/vibe-codr/config.json",
      raw: "{}",
    };
  },
  writeConfig: async () => ({ ok: true as const, path: "/Users/rob/.config/vibe-codr/config.json" }),
  projectConfigPath: async () => "/Users/rob/Code/acme-web/.vibe/config.json",
  readMemory: async (opts: { scope: "global" | "project" }) => ({
    ok: true as const,
    path: opts.scope === "global" ? "/Users/rob/.config/vibe-codr/VIBE.md" : "/Users/rob/Code/acme-web/VIBE.md",
    content: opts.scope === "global" ? "# Global instructions\n\n- Use TypeScript strict mode\n- Prefer functional components" : "# ACME Web\n\n- Next.js 15 app router\n- Tailwind for styling",
    exists: true,
  }),
  writeMemory: async () => ({ ok: true as const, path: "/Users/rob/.config/vibe-codr/VIBE.md" }),

  // Git mocks
  gitStatus: async () => ({
    ok: true as const,
    status: {
      branch: "feature/settings-panel",
      upstream: "origin/feature/settings-panel",
      ahead: 2,
      behind: 1,
      clean: false,
      entries: [
        { index: "M", working: " ", path: "src/renderer/App.tsx" },
        { index: "M", working: "M", path: "src/renderer/styles.css" },
        { index: "A", working: " ", path: "src/renderer/settings/SettingsPanel.tsx" },
        { index: " ", working: "M", path: "src/preload/index.ts" },
        { index: "?", working: "?", path: "src/renderer/git/GitPanel.tsx" },
      ],
      stagedCount: 3,
      unstagedCount: 2,
      untrackedCount: 1,
      remotes: [
        { name: "origin", url: "git@github.com:robzilla1738/vibe-codr.git", host: "github.com", owner: "robzilla1738", repo: "vibe-codr" },
      ],
      branches: [
        { name: "main", current: false, remote: false, upstream: "origin/main", ahead: 0, behind: 2, lastSubject: "Prevent session spinner action overlap", lastDate: Date.now() - 2 * 3600_000 },
        { name: "feature/settings-panel", current: true, remote: false, upstream: "origin/feature/settings-panel", ahead: 2, behind: 1, lastSubject: "Add settings panel", lastDate: Date.now() - 30 * 60_000 },
        { name: "ui/design-system-polish", current: false, remote: false, lastSubject: "Polish shell UI", lastDate: Date.now() - 3 * 24 * 3600_000 },
        { name: "origin/main", current: false, remote: true, lastSubject: "Prevent session spinner action overlap", lastDate: Date.now() - 2 * 3600_000 },
        { name: "origin/feature/settings-panel", current: false, remote: true, lastSubject: "Add settings panel", lastDate: Date.now() - 30 * 60_000 },
      ],
      recentCommits: [
        { hash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", shortHash: "a1b2c3d", author: "Robert", date: Date.now() - 30 * 60_000, subject: "Add settings panel with full config management" },
        { hash: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1", shortHash: "b2c3d4e", author: "Robert", date: Date.now() - 2 * 3600_000, subject: "Add git integration panel" },
        { hash: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2", shortHash: "c3d4e5f", author: "Robert", date: Date.now() - 5 * 3600_000, subject: "Prevent session spinner action overlap" },
        { hash: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3", shortHash: "d4e5f6a", author: "Robert", date: Date.now() - 26 * 3600_000, subject: "Polish transcript disclosures" },
        { hash: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4", shortHash: "e5f6a7b", author: "Robert", date: Date.now() - 2 * 24 * 3600_000, subject: "Logic audit and hardening" },
      ],
    },
  }),
  gitFileDiff: async () => ({
    ok: true as const,
    available: true as const,
    diff: "diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n--- a/src/renderer/App.tsx\n+++ b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n",
    added: 1,
    removed: 1,
  }),
  gitCreateBranch: async () => ({ ok: true, message: "Created branch" }),
  gitCheckout: async () => ({ ok: true, message: "Switched" }),
  gitDeleteBranch: async () => ({ ok: true, message: "Deleted" }),
  gitStage: async () => ({ ok: true, message: "Staged" }),
  gitUnstage: async () => ({ ok: true, message: "Unstaged" }),
  gitCommit: async () => ({ ok: true, message: "Committed" }),
  gitMerge: async () => ({ ok: true, message: "Merged" }),
  gitPush: async () => ({ ok: true, message: "Pushed" }),
  gitPull: async () => ({ ok: true, message: "Pulled" }),
  gitFetch: async () => ({ ok: true, message: "Fetched" }),
  ghCheckAvailable: async () => ({ available: true }),
  ghPrList: async () => ({
    ok: true as const,
    prs: [
      { number: 42, title: "Add settings and git panels", state: "OPEN", head: "feature/settings-panel", url: "https://github.com/robzilla1738/vibe-codr/pull/42" },
      { number: 38, title: "Polish shell UI and harden host resolution", state: "MERGED", head: "ui/design-system-polish", url: "https://github.com/robzilla1738/vibe-codr/pull/38" },
    ],
  }),
  ghPrCreate: async () => ({ ok: true as const, url: "https://github.com/robzilla1738/vibe-codr/pull/43", message: "PR created" }),
  getShellInfo: async () => ({ version: "0.1.0-preview", lastLaunch: "mock host" }),
  terminalOpen: async ({ cwd }: { cwd: string; cols: number; rows: number }) => ({
    ok: true as const,
    id: "preview-terminal",
    cwd,
    shell: "/bin/zsh",
    reused: false,
    replay: "",
    sequence: 0,
  }),
  terminalWrite: async () => ({ ok: true as const }),
  terminalResize: async () => ({ ok: true as const }),
  onTerminalEvent: () => () => undefined,
};

// Structural contract: mock must implement every preload VibeApi method name.
// Canonical list lives in src/shared/vibe-api-keys.ts — kept inlined here so the
// browser preview bundle does not need a separate resolve path for Node tests.
const REQUIRED_VIBE_KEYS = [
  "bootstrap", "send", "rpc", "listProjects", "renameProject", "archiveProject",
  "deleteProject", "renameSession", "deleteSession", "archiveSession", "stop",
  "quit", "onEvent", "onReady", "onFatal", "onMenuAction", "cloudSettings",
  "updateCloudSettings", "connectCloudProvider", "disconnectCloudProvider", "testCloudProvider", "saveCloudCredentialBinding", "removeCloudCredentialBinding",
  "listCloudSessions", "deleteCloudSessionCopy", "recoverLostCloudSession", "handoffToCloud", "reconnectCloudSession", "resumeCloudSessionLocally", "onCloudStatus",
  "setSettingsDirty", "openProject",
  "ensureChatsDir", "openExternal", "showItem", "readTextFile", "composeInEditor",
  "getPath", "getPathForFile", "listFiles", "pasteClipboard", "writeClipboardText", "globalConfigPath",
  "readConfig", "writeConfig", "projectConfigPath", "readMemory", "writeMemory",
  "gitStatus", "gitFileDiff", "gitCreateBranch", "gitCheckout", "gitDeleteBranch", "gitStage",
  "gitUnstage", "gitCommit", "gitMerge", "gitPush", "gitPull", "gitFetch",
  "ghCheckAvailable", "ghPrList", "ghPrCreate", "getShellInfo", "terminalOpen",
  "terminalWrite", "terminalResize", "onTerminalEvent",
] as const;
for (const key of REQUIRED_VIBE_KEYS) {
  if (!(key in mock)) {
    throw new Error(`ui-preview mock-vibe missing window.vibe.${key}`);
  }
}

(window as unknown as { vibe: typeof mock }).vibe = mock;
(window as unknown as { __previewSettled: boolean }).__previewSettled = false;
