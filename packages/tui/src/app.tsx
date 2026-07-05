/**
 * OpenTUI (Solid) interactive app — the primary, polished UI.
 *
 * This file is excluded from `tsc` typecheck (see tsconfig.json) because it
 * depends on `@opentui/core` / `@opentui/solid` / `solid-js`, which are
 * optional native peer deps. It is dynamically imported by `startTui`; if the
 * import fails, the readline REPL in `tui.ts` takes over. Because it can't be
 * typechecked, only use OpenTUI props/events confirmed to exist in the installed
 * version. The README screenshots render THIS component and rasterize its real
 * cell grid (`packages/tui/scripts/screenshot.ts`), so there is no parallel render
 * to keep in sync — just re-run that script after a visible change.
 *
 * Layout: a single, centered, capped-width chat column (ChatGPT-style) on a
 * black background, with a muted TOP-LEFT context line (cwd · git · goal).
 * On a WIDE terminal (≥ SIDEBAR_MIN_TERM) with live work (tasks / a subagent
 * fan-out / a running turn), a fixed-width RIGHT SIDEBAR takes the Tasks panel,
 * the Subagents fan-out (each child with its live activity line), and the live
 * thinking stream out of the chat column, so the transcript keeps its vertical
 * space; on narrow panes all fall back inline exactly as before. The sidebar
 * spans the SAME height as the chat column — Tasks then Subagents hug the top,
 * the Thinking block grows to fill the rest, and the thought trail persists
 * until the next message is sent.
 *
 * DESIGN LANGUAGE — flat chrome, filled content. Structural chrome (status
 * sections, the input, cards) is drawn FLAT: accent-colored titles + spacing on the
 * uniform black, never line-drawn boxes or grey fills. This is deliberate: many
 * terminals add line/letter spacing, which turns box-drawing borders (│─┼) into
 * broken dashes and makes multi-row background fills read as messy floating
 * rectangles. Flat text stays uniform on ANY terminal. The ONLY filled/bar elements
 * are: (a) the RAIL — a solid 1-col bg bar (git-graph style, see `Rail`) down the
 * left of every block card (turns, input, plan, permission, toast, quotes); (b)
 * DATA VIZ — bar/line/pie charts, whose colored fills ARE the content. A filled
 * cell fills its whole rect, so these bars/fills stay solid everywhere. NEVER use
 * `border={[…]}` for chrome: border glyphs gap into dashes and can ghost when a
 * block reflows or scrolls (the Rail docstring has the full story).
 *
 * A fresh screen shows a centered VIBE CODR wordmark. Once you start: the scrolling
 * transcript renders as connected TURN THREADS (a `◆` node carries your prompt, a
 * continuous rail runs down through its tool steps + answer); below it sit the live
 * status sections (working · plan · tasks · subagents · queue · permission); then
 * the input — its OWN filled block (elevated surface, mode-hued left accent) holding
 * a `MODE ❯` prompt with the command menu as rows inside the same block; then a
 * justified status line (model ·
 * changed · ctx · cost left; key hints right). Assistant prose renders through
 * OpenTUI's native <markdown>; headings/quotes/code/tables + rich data views
 * (chart/line/pie/weather/sources — see rich-blocks.ts) render from our own
 * primitives. Tool/diff output is condensed to one line and expands on click;
 * tapping your own message folds the whole turn under it.
 */

import { SyntaxStyle, TextAttributes } from "@opentui/core";
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import type {
  EngineClient,
  AgentInfo,
  GitInfo,
  GoalRunInfo,
  JobInfo,
  ModelSummary,
  ProviderInfo,
  SessionUsage,
  SkillInfo,
  Task,
  UIEvent,
} from "@vibe/shared";
import { batch, createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { copyToClipboard } from "./clipboard.ts";
import { applyPalette, isExactCommand, paletteState, skillsPickerFilter } from "./commands-catalog.ts";
import { createMarkdownSplitter, displayWidth, renderTable, tableFits, tailWidth, truncateWidth, type MdBlock } from "./markdown-blocks.ts";
import {
  barChartLayout,
  barGlyphs,
  brailleChart,
  compactNum,
  parseChart,
  parseSeries,
  parseSearchResults,
  parseSources,
  parseWeather,
  pieGrid,
  pieLayout,
  resamplePoints,
  richKind,
  type Source as SourceItem,
  sharePercents,
  sparkLayout,
  sparkRange,
  sparkline,
  weatherIcon,
} from "./rich-blocks.ts";
import { GLYPH } from "./glyphs.ts";
import { formatUsage, TASK_GLYPH, windowTasks } from "./headless.ts";
import { commandsForUiMode, deriveUiMode, modeColor, nextUiMode } from "./modes.ts";
import { cleanupClipboardTempDir, readClipboardImage } from "./clipboard-image.ts";
import { composeInEditor, type EditorSpawn } from "./editor-compose.ts";
import { brandSpans, rainbow } from "./gradient.ts";
import { lineToCommands, routePendingPermLine } from "./slash.ts";
import { spinnerFrame, workingLabel } from "./spinner.ts";
import { ACCENT_PRESETS, accentNameOf, getTheme, type Palette } from "./themes.ts";
import { permissionPreview, toolLabel } from "./tool-icons.ts";
import { Trail, turnWindowStart, windowStartIndex } from "./trail.ts";
import {
  initialTranscript,
  reduceTranscript,
  groupIntoTurns,
  collapsedHint,
  dropSettledPerms,
  firstLine,
  toolDurationLabel,
  truncate,
  type Block,
  type Subagent,
  type ChangedFile,
  type PendingPerm,
  type TranscriptAction,
} from "./reducer.ts";
import { WORDMARK, WORDMARK_COLS } from "./wordmark.ts";

/** The chat column's maximum width. At or below this the column fills the
 * terminal; above it the column stays centered with quiet side gutters
 * (ChatGPT-style — a readable, bounded conversation measure). 130 (up from
 * 100, originally 84) trades line-length purity for information density —
 * code, diffs, tables and tool output show meaningfully more per row on a
 * full-screen terminal while narrow panes still just fill the window. */
const CONTENT_MAX = 130;
/** Cap how many output lines an expanded tool/diff block renders. */
const MAX_OUTPUT_LINES = 160;
/** The right sidebar's fixed column width (Tasks + live thinking on wide panes). */
const SIDEBAR_W = 42;
/** Min terminal width for the sidebar: below this the chat column would be
 * squeezed under ~96 cols, so Tasks/thinking stay inline instead. */
const SIDEBAR_MIN_TERM = 140;
/** Max visible rows the input box grows to before it scrolls internally. */
const INPUT_MAX_ROWS = 10;
/** Prompt-field keybinding overrides (merged over the textarea defaults):
 * Enter submits the draft (chat-prompt semantics, not the textarea's default
 * newline) and Shift+Enter inserts a real newline for multi-line prompts. */
const PROMPT_KEYS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
];
/** Max rows a live status panel (Tasks / Subagents / Queued) renders before it
 * collapses the overflow to a "+N more" line. These panels are flexShrink={0}, so
 * an uncapped list (a wide 20–40 subagent fan-out) would push the input + status
 * bar off the bottom of the screen. Bounding the row count keeps the input usable
 * mid-turn. Matches the menu window cap (MENU_WINDOW_MAX). */
const PANEL_MAX_ROWS = 8;
/** Newest turns kept in the transcript's layout tree; older ones fold behind a
 * "▸ N earlier turns" row (render windowing — the reducer keeps full history).
 * Generous: 40 turns is far more than fits on screen, so the fold is only ever
 * seen while deliberately scrolling back. */
const WINDOW_TURNS = 40;
/** In-turn item window: turn windowing bounds relayout ACROSS turns, but one turn
 * with hundreds of tool blocks still grows the yoga tree without bound. Cap a
 * turn's rendered items, advancing the start in whole STEP jumps so the <Index>
 * reshuffles at most once every STEP appends (per-append would re-key every row
 * on the hot streaming path). See `turnWindowStart`. */
const TURN_ITEMS_MAX = 120;
const TURN_ITEMS_STEP = 24;
/** Turns each tap of the fold row reveals. */
const REVEAL_PAGE = 20;
/** The wordmark is rendered with OpenTUI's native ASCII-font renderable
 * (`<ascii_font font="slick">`) in the brand color — see the empty-state splash. */
/** Min column width to show the big wordmark (else a compact brand line). */
const LOGO_MIN_COLS = 56;

// The transcript Block model + its pure reducer live in reducer.ts (headless,
// unit-tested). This file owns the Solid signals and the per-frame flush timer,
// and delegates every transcript state transition to reduceTranscript.

export function App(props: { engine: EngineClient }) {
  const snap = props.engine.snapshot();
  const [blocks, setBlocks] = createSignal<Block[]>([]);
  const [draft, setDraft] = createSignal("");
  // Every invocable slash name (built-ins + custom commands + skills),
  // lowercased — drives the input's "registered command" cue: a slash draft
  // whose command word is real renders in the heading hue. Refreshed alongside
  // the other status projections in refreshStatus().
  const [cmdNames, setCmdNames] = createSignal<ReadonlySet<string>>(
    new Set((snap.commandNames ?? []).map((s) => s.toLowerCase())),
  );
  const draftIsCommand = createMemo(() => isExactCommand(draft(), cmdNames()));
  const [tasks, setTasks] = createSignal<Task[]>(snap.tasks);
  const [subagents, setSubagents] = createSignal<Subagent[]>([]);
  // Working-tree git state for the header's git context (undefined outside a repo).
  const [git, setGit] = createSignal<GitInfo | undefined>(snap.git);
  // Background shell jobs (+ detected localhost servers); the `/jobs` sub-view
  // toggles `showJobs` to display them.
  const [jobs, setJobs] = createSignal<JobInfo[]>([]);
  const [showJobs, setShowJobs] = createSignal(false);
  // Turns (keyed by the user message that starts them) whose work is folded away
  // — tap your message to collapse the whole exchange under it (assistant reply +
  // tool work), or Ctrl+O to fold/unfold every turn at once.
  const [collapsedTurns, setCollapsedTurns] = createSignal<Set<number>>(new Set());
  const toggleTurn = (turn: number) =>
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      next.has(turn) ? next.delete(turn) : next.add(turn);
      return next;
    });
  // The transcript is rendered as connected TURN THREADS: each user message plus
  // the blocks that follow it (until the next user message) is one turn, drawn with
  // a continuous left rail (git-graph style) from the user node at the top down
  // through its tool steps and answer. `turns()` is the pure grouping.
  const turns = createMemo(() => groupIntoTurns(blocks()));
  // RENDER WINDOWING — the layout tree holds only the newest WINDOW_TURNS turns
  // (plus any the user revealed); older turns leave the tree entirely behind a
  // tappable "▸ N earlier turns" fold row. This is the structural half of the
  // freeze fix: yoga re-measures EVERY child in the scrollbox on each relayout
  // (viewportCulling only skips paint), so an unbounded transcript made each
  // commit's relayout cost grow without limit until the shared engine+UI thread
  // starved stdin. Windowing is a RENDER concern only — the reducer's
  // `ts.blocks` keeps full history for /export, expansion, and resume.
  // `turns().length` grows only on a new USER block, so the window is stable
  // for the whole of a streaming turn: no <Index> reshuffle on the hot path.
  const [revealTurns, setRevealTurns] = createSignal(0);
  const windowStart = createMemo(() => windowStartIndex(turns().length, WINDOW_TURNS, revealTurns()));
  const windowedTurns = createMemo(() => turns().slice(windowStart()));
  // Ctrl+O: fold every turn that has a node + work, or unfold all if any is folded.
  const toggleAllTurns = () =>
    setCollapsedTurns((prev) =>
      prev.size > 0
        ? new Set()
        : new Set(turns().filter((t) => t.user && t.items.length > 0).map((t) => t.key)),
    );
  // Subagent rows the user has expanded (one truncated line each by default, so a
  // big fan-out stays tidy unless you open a row).
  const [expandedSubs, setExpandedSubs] = createSignal<Set<string>>(new Set());
  const toggleSub = (id: string) =>
    setExpandedSubs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Files touched this session (path → cumulative line delta), summarized in the footer.
  const [changedFiles, setChangedFiles] = createSignal<ChangedFile[]>([]);
  const [plan, setPlan] = createSignal<{
    text: string;
    sources?: { url: string; title?: string }[];
    assumptions?: string[];
    ungrounded?: boolean;
  } | null>(null);
  // The full queue of prompts waiting behind the running turn (id + label), so we
  // can show the stack and offer per-item steer/remove — not just a count.
  const [pendingQ, setPendingQ] = createSignal<{ id: string; label: string }[]>([]);
  const queued = () => pendingQ().length;
  // Pending permission requests, oldest first; the head is shown as a card and
  // answered by y/a/n or a typed reply.
  const [perms, setPerms] = createSignal<PendingPerm[]>([]);
  // Live working indicator: true between a submitted prompt and turn end. `tick`
  // is bumped by an interval only while working, so the spinner animates and the
  // elapsed time updates without re-rendering an idle screen.
  const [working, setWorking] = createSignal(false);
  const [tick, setTick] = createSignal(0);
  // The model's live reasoning as a small streaming STACK (the last few lines,
  // newest brightest) under the working spinner — watching the model think,
  // not one flickering line. Cleared when the burst lands as its `✻ thought`
  // transcript row (the moment the model acts) and at turn end. Headless
  // parity: `-p` prints reasoning with --show-reasoning.
  const [reasoningLines, setReasoningLines] = createSignal<string[]>([]);
  // The sidebar's TRAIL: the whole turn's reasoning AND tool activity as one
  // continuous, persistent stream. Unlike `reasoningLines` (the transient
  // inline preview, cleared every time a burst lands as its `✻ thought` row),
  // this accumulates across bursts and survives past turn end — so the sidebar
  // shows the thought process, not a line that vanishes as each action starts.
  // Reset only when the NEXT turn begins. Activity lines (tool icon + action)
  // interleave chronologically, so a non-reasoning model still shows a live
  // trail instead of an empty panel; `trailKind` picks the panel header
  // ("Thinking" once any reasoning exists this turn, "Activity" otherwise).
  const [thoughtLog, setThoughtLog] = createSignal<string[]>([]);
  const [trailKind, setTrailKind] = createSignal<"none" | "activity" | "reasoning">("none");
  // Trail backing state — component scope (not the event-loop closure) so the
  // /clear reset path can wipe it along with the signals. `Trail` (trail.ts)
  // owns the line state and appends incrementally — only NEW bytes are ever
  // split, never the whole log (the per-token 64 KB re-split was a
  // main-thread hot spot).
  const trail = new Trail();
  let trailDirty = false;
  /** Unflushed reasoning bytes — landed once per frame, not per token. */
  let pendingReasoning = "";
  // The transcript `✻ thought` row's burst buffers (head-capped full text +
  // rolling tail for the inline preview).
  let reasoningBuf = "";
  let reasoningTailBuf = "";
  let thinkingStartedAt = 0;
  let turnStartedAt = 0;
  let model = snap.model;
  let mode = snap.mode;
  let approvals = snap.approvalMode;
  let goal = snap.goal;
  let usage: SessionUsage = snap.usage;
  let ctx: { usedTokens: number; contextWindow: number } | null = null;
  // A handle to the prompt textarea so we can restore focus after a mouse click
  // (a click on any renderable blurs it, which would otherwise leave the user
  // unable to type until they click the field again) and push programmatic
  // draft writes (Tab completion, Esc clear) into its edit buffer.
  let inputEl:
    | {
        focus: () => void;
        editBuffer: {
          getText: () => string;
          setText: (t: string) => void;
          setCursorByOffset: (o: number) => void;
          insertText: (t: string) => void;
        };
      }
    | undefined;
  // Defer past the renderer's own post-click focus handling (which would
  // otherwise blur the input right after our synchronous focus() call).
  const refocusInput = () => queueMicrotask(() => inputEl?.focus());
  // Programmatic draft writes (Tab completion, Esc/Ctrl+C clear, menu prefills)
  // flow INTO the textarea's edit buffer; user typing flows out via
  // onContentChange. The equality guard breaks the two-way echo, and the cursor
  // jumps to the end so a completion keeps the caret where typing resumes.
  createEffect(() => {
    const v = draft();
    const el = inputEl;
    if (el && el.editBuffer.getText() !== v) {
      el.editBuffer.setText(v);
      el.editBuffer.setCursorByOffset(v.length);
    }
  });
  // The transcript scrollbox, captured so expand/collapse can hold the clicked
  // row in place instead of letting sticky-scroll snap to the bottom.
  let scrollEl: { scrollTop: number; scrollHeight: number; stickyScroll: boolean } | undefined;
  // Expand/collapse a row while keeping the clicked line visually fixed. When the
  // turn is idle, clicking is "I'm reading now": disengage auto-follow (otherwise
  // the taller content snaps to the bottom and reads as a jump) and freeze
  // scrollTop across the re-layout — auto-follow re-engages on the next turn (see
  // `runText`). While a turn is still streaming, leave sticky alone so new output
  // keeps following.
  const anchoredToggle = (mutate: () => void) => {
    if (working()) {
      mutate();
      refocusInput();
      return;
    }
    const top = scrollEl?.scrollTop ?? 0;
    if (scrollEl) scrollEl.stickyScroll = false;
    mutate();
    queueMicrotask(() => {
      if (scrollEl) scrollEl.scrollTop = top;
    });
    refocusInput();
  };
  // Reveal a page of older turns above the render window, keeping the fold row
  // (and whatever the user was reading) visually fixed: the height the new
  // turns add ABOVE the viewport is added back into scrollTop after relayout —
  // the same anchoring idea as `anchoredToggle`, computed from the scrollHeight
  // delta because content grew above rather than at the click point.
  const revealOlder = () => {
    const el = scrollEl;
    const oldTop = el?.scrollTop ?? 0;
    const oldHeight = el?.scrollHeight ?? 0;
    if (el) el.stickyScroll = false; // reading history — don't snap to bottom
    setRevealTurns((r) => r + REVEAL_PAGE);
    queueMicrotask(() => {
      if (el) el.scrollTop = oldTop + (el.scrollHeight - oldHeight);
    });
    refocusInput();
  };
  const [palette, setPalette] = createSignal<Palette>(getTheme(snap.theme));
  const [uiMode, setUiMode] = createSignal(deriveUiMode(mode, approvals));
  const [headModel, setHeadModel] = createSignal(model);
  // Live "ctx N% · tokens · $cost · N queued" — shown in the footer when relevant.
  const [metrics, setMetrics] = createSignal(metricsLine(0, usage, ctx));
  // The goal (★) shown in the header's second row; updated via /goal.
  const [goalInfo, setGoalInfo] = createSignal<string | null>(goal);
  // Live goal-run state (phase/round/paused/met) — the ★ line's suffix, so an
  // autonomous run is visibly progressing (or visibly paused) at a glance.
  const [goalRunState, setGoalRunState] = createSignal<GoalRunInfo | null>(snap.goalRun ?? null);
  const goalSuffix = () => {
    const r = goalRunState();
    if (!r || !goalInfo()) return "";
    if (r.active) return r.phase === "plan" ? " · planning" : ` · ${r.round}/${r.max}`;
    if (r.met) return " · met";
    if (r.pausedReason) return " · paused";
    return "";
  };
  const cwd = shortCwd();
  // The chrome accent: opencode peach by default (the DEFAULT palette's primary),
  // overridable to any hue via `/accent <hex>`. Reserved for titles + markers —
  // panel titles, the `❯` user marker + gutter, the active task/step, the selected
  // menu row, and the caret — plus the wordmark sweep and the spinner. Box borders
  // stay neutral grey (`palette().border`).
  const [accentColor, setAccentColor] = createSignal(snap.accentColor || "");
  const brand = () => accentColor() || palette().primary;
  // The mode chip + input rail hue — the one mode-driven color in the UI. ASK
  // (execute, the everyday state) FOLLOWS the brand accent so `/accent orange`
  // recolors the whole input control coherently (a fixed hue chip would clash
  // with a warm accent); PLAN green and YOLO red stay fixed alert hues.
  const accent = () => (uiMode() === "execute" ? brand() : modeColor(uiMode()));
  // The mode word shown on the input's top border. "execute" means "every action
  // is gated by an approval prompt", so it reads as ASK (vs YOLO = no prompts).
  const modeWord = () => (uiMode() === "execute" ? "ASK" : uiMode().toUpperCase());

  // ── Interactive submenu state ──────────────────────────────────────────────
  // The live model list for the `/model` picker (fetched lazily on first open,
  // then cached for the session). `null` = not fetched yet → show "Fetching…".
  const [models, setModels] = createSignal<ModelSummary[] | null>(null);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  // The provider list for the `/providers` menu (fetched lazily on first open).
  const [providers, setProviders] = createSignal<ProviderInfo[] | null>(null);
  const [providersLoading, setProvidersLoading] = createSignal(false);
  // The named-agents list for the `/agents` menu (re-fetched when it opens so a
  // freshly created/edited agent shows up).
  const [agents, setAgents] = createSignal<AgentInfo[] | null>(null);
  const [agentsLoading, setAgentsLoading] = createSignal(false);
  const [skillsList, setSkillsList] = createSignal<SkillInfo[] | null>(null);
  const [skillsLoading, setSkillsLoading] = createSignal(false);
  // Current settings tracked reactively so the value submenus can mark the active
  // choice (theme/accent come back as events; subagent-model + reasoning have no
  // event, so we also update them optimistically when chosen here).
  const [themeName, setThemeName] = createSignal(snap.theme);
  const [subagentModelSig, setSubagentModelSig] = createSignal(snap.subagentModel);
  const [reasoningSig, setReasoningSig] = createSignal<string | undefined>(snap.reasoning);
  // Which agent the `/model` picker is configuring — flipped with Tab while the
  // picker is open. Resets to "main" whenever the picker closes.
  const [modelTarget, setModelTarget] = createSignal<"main" | "sub">("main");
  // The current value of an enum command, for marking the active row in its
  // submenu (approvals is derived from the live UI mode; the rest from snapshot/
  // event-tracked signals above).
  const currentValueFor = (name: string): string | undefined => {
    if (name === "theme") return themeName();
    if (name === "approvals") return uiMode() === "yolo" ? "auto" : "ask";
    if (name === "reasoning") return reasoningSig() ?? "off";
    // The live accent maps back to its preset name (custom hexes match nothing).
    if (name === "accent") return accentNameOf(accentColor() || palette().primary);
    return undefined;
  };
  // Detect when the draft opens the unified `/model` picker and WHICH agent it
  // configures. The main/subagent target is a Tab-toggle (`modelTarget()`); a
  // specific named agent is addressed by `/model agent <name>` (the `/agents` menu
  // prefills this). Returns null when it's NOT a picker: `/model key …` (set a
  // provider key) and `/model refresh` (re-pull the catalog) are text subcommands.
  // `/models` is a legacy alias.
  type ModelPick = { query: string; target: "main" | "sub" | { agent: string } };
  const modelPicker = (): ModelPick | null => {
    const d = draft();
    const am = /^\/model\s+agent\s+(\S+)\s*(.*)$/is.exec(d);
    if (am) return { query: (am[2] ?? "").trim(), target: { agent: am[1]! } };
    const m = /^\/models?(?:\s+(.*))?$/is.exec(d);
    if (!m) return null;
    const q = (m[1] ?? "").trim();
    const first = q.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first === "key" || first === "refresh" || first === "agent") return null;
    return { query: q, target: modelTarget() };
  };
  // The main/sub toggle resets to "main" whenever the picker closes, so it always
  // opens configuring the main agent.
  createEffect(() => {
    if (modelPicker() === null) setModelTarget("main");
  });
  // `/providers [filter]` → the provider list menu (configured status + key entry).
  const providersPickerQuery = (): string | null => {
    const m = /^\/providers?(?:\s+(.*))?$/is.exec(draft());
    return m ? (m[1] ?? "").trim() : null;
  };
  // `/agents [filter]` → the named-agents menu. `/agents new <name>` is a create
  // command (routed to the engine), NOT the picker.
  const agentsPickerQuery = (): string | null => {
    const m = /^\/agents?(?:\s+(.*))?$/is.exec(draft());
    if (!m) return null;
    const rest = (m[1] ?? "").trim();
    if (/^new(\s|$)/i.test(rest)) return null;
    return rest;
  };
  // `/skills [filter]` → the searchable skills menu (Enter prefills
  // `/skill <name> `). See skillsPickerFilter for why it is plural-only.
  const skillsPickerQuery = (): string | null => skillsPickerFilter(draft());

  // Native markdown rendering needs a SyntaxStyle (for fenced code highlighting).
  // Created once; if the native lib can't build one we fall back to plain text.
  let mdStyle: SyntaxStyle | undefined;
  try {
    mdStyle = SyntaxStyle.create();
  } catch {
    mdStyle = undefined;
  }

  // The chat column is centered with a capped width (ChatGPT-style): it fills a
  // narrow terminal and gets quiet side gutters on a wide one. Reads the live
  // terminal width so the column reflows on resize.
  const dims = useTerminalDimensions();
  // The Tasks panel is worth showing while any task is unfinished (a fully
  // completed list hides so it doesn't linger) — shared by the inline panel
  // and the sidebar so exactly one of them ever renders it.
  const tasksVisible = () => tasks().length > 0 && tasks().some((t) => t.status !== "completed");
  // The right sidebar mounts on a wide terminal whenever there is work to host:
  // ANY task list (completed ones included — it must not vanish, reflowing the
  // whole transcript, the moment the last task finishes), a running turn, or a
  // lingering thought log from the turn that just ended. In practice that means
  // it appears when a turn starts and stays for the session; the next /clear or
  // a narrow resize are the only things that remove it.
  const sidebarOn = () =>
    dims().width >= SIDEBAR_MIN_TERM &&
    (tasks().length > 0 || subagents().length > 0 || working() || thoughtLog().length > 0);
  const contentWidth = () =>
    Math.min(CONTENT_MAX, Math.max(1, dims().width - 2 - (sidebarOn() ? SIDEBAR_W : 0)));
  // How many task rows the sidebar shows before windowing kicks in — taller
  // than the inline PANEL_MAX_ROWS (vertical space is what the sidebar is for),
  // budgeted by terminal height with slack for wrapped titles (÷4 ≈ header +
  // 2-line wraps) so a long list can't push the thinking section off-screen.
  // When BOTH rigid panels are up (Tasks + Subagents) they split that budget,
  // keeping the growing Thinking block on-screen even on a short pane.
  // (−16: chrome rows + the always-on session card, which is rigid ~5-7 rows.)
  const sidePanelBudget = () =>
    Math.max(PANEL_MAX_ROWS, Math.min(16, Math.floor((dims().height - 16) / 4)));
  const sideTaskCap = () =>
    subagents().length > 0 ? Math.max(3, Math.floor(sidePanelBudget() / 2)) : sidePanelBudget();
  // Subagent rows can take up to FOUR lines each (a two-line wrapped prompt +
  // a two-line wrapped activity/result), so the cap counts its half of the
  // budget in ~3-line rows (most rows use 2-3) — a big fan-out windows into
  // "+N more" instead of pushing the thinking block off-screen.
  const sideSubCap = () => Math.max(3, Math.floor(sidePanelBudget() / 3));
  // The thought-log block GROWS to fill every row left under the Tasks block,
  // so the sidebar spans the same height as the chat column — its top block
  // sits level with the first transcript block and its bottom lands level with
  // the input, one continuous column instead of a short box floating over
  // empty space. The scrollbox inside inherits that height; content shorter
  // than the box top-aligns, longer content scrolls (sticky-bottom).

  // The live "Working… Ns" elapsed label. It reads `tick()` so Solid re-renders it
  // on every spinner frame — without a signal dependency the clock would render
  // once and freeze (the bug where the timer stuck while the turn kept running).
  const elapsedLabel = () => {
    void tick();
    return workingLabel(Date.now() - turnStartedAt);
  };

  // Copy-toast: a brief "Copied to clipboard" card that slides in at the TOP-RIGHT
  // corner when a selection is copied, holds, then slides back out. `toastFrame`
  // (−1 = hidden, else 0..TOAST_FRAMES) drives the slide-in / hold / slide-out via a
  // short-lived timer — a small, self-contained animation independent of the spinner.
  const [toastFrame, setToastFrame] = createSignal(-1);
  const TOAST_FRAMES = 32;
  let toastTimer: ReturnType<typeof setInterval> | null = null;
  const flashCopied = () => {
    setToastFrame(0);
    if (toastTimer) clearInterval(toastTimer);
    toastTimer = setInterval(() => {
      setToastFrame((f) => {
        const next = f + 1;
        if (next >= TOAST_FRAMES) {
          if (toastTimer) clearInterval(toastTimer);
          toastTimer = null;
          return -1;
        }
        return next;
      });
    }, 55);
  };
  onCleanup(() => {
    if (toastTimer) clearInterval(toastTimer);
  });
  // Vertical offset for the slide animation: rises from off-screen (−4, the full
  // 3-row card + a row of slack) to row 1, holds, then slides back up on exit.
  // A 4-frame ease at each end.
  const toastTop = () => {
    const f = toastFrame();
    const HOLD = 1;
    const HIDDEN = -4;
    if (f < 0) return HIDDEN;
    if (f < 4) return HIDDEN + Math.round(((HOLD - HIDDEN) * f) / 4);
    if (f < TOAST_FRAMES - 4) return HOLD;
    return HOLD + Math.round(((HIDDEN - HOLD) * (f - (TOAST_FRAMES - 4))) / 4);
  };

  // Copy-on-selection: when a mouse drag-selection FINISHES, copy the highlighted
  // text to the clipboard and flash the toast. OSC52 (via the renderer) covers
  // tmux/SSH; the platform command (pbcopy/clip/wl-copy…) covers local terminals
  // that ignore OSC52. Copy is best-effort — a failure must never break the render.
  const renderer = useRenderer();
  useSelectionHandler((selection: { isDragging: boolean; getSelectedText?: () => string }) => {
    if (selection.isDragging) return; // still dragging → wait for the release
    const text = selection.getSelectedText?.() ?? "";
    if (!text.trim()) return;
    try {
      copyToClipboard(text, { osc52: (t) => renderer.copyToClipboardOSC52?.(t) ?? false });
      flashCopied();
    } catch {
      // best-effort — ignore clipboard failures
    }
  });

  // ESTIMATE of the input's current row count, used only to budget the menu
  // window height (`menuWindow`). The prompt textarea sizes ITSELF (it wraps
  // natively and auto-grows between minHeight 1 and maxHeight INPUT_MAX_ROWS,
  // then scrolls internally) — the render path no longer consumes this, so an
  // off-by-one here costs a menu row, not a clipped draft.
  const inputRows = () => {
    const inner = Math.max(8, contentWidth() - 5 - (modeWord().length + 3));
    const lines = draft().split("\n");
    const rows = lines.reduce(
      (sum, line, i) =>
        sum + Math.max(1, Math.ceil((displayWidth(line) + (i === lines.length - 1 ? 1 : 0)) / inner)),
      0,
    );
    return Math.min(INPUT_MAX_ROWS, Math.max(1, rows));
  };

  // The presented-plan card is bounded so its (often long) content scrolls
  // INSIDE the card instead of pushing the input + approval hint off-screen —
  // AND so the transcript above keeps ~8 usable rows: the user must still be
  // able to scroll up and re-read their own message while deciding on the plan
  // (a dims−12 cap let a long plan squeeze the transcript to a sliver). If the
  // plan is short, the card shrinks to fit it (rough wrap estimate — the
  // scrollbox handles the exact overflow). The card's chrome is 5 rows:
  // padding (2) + title + the meta line + the hint box (its marginTop=1 row).
  // The card's scrollable body: the plan markdown plus a compact sources list
  // (the pages the plan is grounded in), so evidence is reviewable in place.
  const planDisplayText = () => {
    const p = plan();
    if (!p) return "";
    const sources = p.sources?.length
      ? `\n\nSources:\n${p.sources.map((s, i) => `${i + 1}. ${s.url}${s.title ? ` — ${s.title}` : ""}`).join("\n")}`
      : "";
    const assumptions = p.assumptions?.length
      ? `\n\nAssumptions (unverified):\n${p.assumptions.map((a) => `- ${a}`).join("\n")}`
      : "";
    return `${p.text}${sources}${assumptions}`;
  };
  const planContentRows = () => {
    const inner = Math.max(20, contentWidth() - 7);
    return planDisplayText()
      .split("\n")
      .reduce((n, l) => n + Math.max(1, Math.ceil(displayWidth(l) / inner)), 0);
  };
  // Extra fixed chrome rows the grounding metadata adds above the scrollbox
  // (the ⚠ ungrounded banner and/or the "Grounded in N sources" line).
  const planMetaRows = () =>
    (plan()?.ungrounded ? 1 : 0) +
    (plan()?.sources?.length || plan()?.assumptions?.length ? 1 : 0);
  // ~8 rows of app chrome (context line, input, status, padding) + ~8 rows of
  // transcript stay reserved; the floor keeps the card usable on tiny panes.
  const planPanelCap = () => Math.max(9, dims().height - 20);
  const planPanelRows = () => Math.min(planPanelCap(), planContentRows() + 5 + planMetaRows());
  // Whether the plan overflows its card (→ show the scroll affordance in the hint).
  const planOverflows = () => planContentRows() + 5 + planMetaRows() > planPanelCap();

  const [selIdx, setSelIdx] = createSignal(0);
  // The menu window's scroll offset (top visible row). Kept SEPARATE from the
  // highlight so hovering a row only moves the highlight — it never scrolls. Only
  // arrow keys (and the initial current-value highlight) scroll, via
  // `ensureMenuVisible`. This kills the runaway "mouse moves → window re-centers →
  // rows shift under the cursor → hover fires again" fast-scroll loop.
  const MENU_WINDOW_MAX = 8;
  // The menu now lives INSIDE the input frame (rigid, flexShrink=0), so an
  // unbounded row count would push the input line + caret off the bottom on a
  // short pane (or when Tasks/Subagents panels are also up). Adapt the window to
  // the terminal height — reserving rows for the top-left line, the frame border,
  // the menu title/hint/more/divider, the input line, and the under-input status —
  // so the prompt you're typing at always stays visible (the rest scrolls with a
  // "+N more" affordance). Mirrors `planPanelRows()`'s height cap.
  const menuWindow = () =>
    Math.max(3, Math.min(MENU_WINDOW_MAX, dims().height - inputRows() - 11));
  const [menuStart, setMenuStart] = createSignal(0);
  /** Scroll the window the minimum needed to keep row `sel` of `count` visible. */
  const ensureMenuVisible = (sel: number, count: number) => {
    const win = menuWindow();
    const maxStart = Math.max(0, count - win);
    setMenuStart((s) => {
      const cur = Math.min(Math.max(0, s), maxStart);
      if (sel < cur) return sel;
      if (sel > cur + win - 1) return Math.min(sel - win + 1, maxStart);
      return cur;
    });
  };

  // One normalized menu row — its `choose` carries the row's own action, so the
  // keyboard handler, click handler, and renderer share a single path regardless
  // of which kind of menu produced it. `label` is the primary token (aligned into
  // a column); `desc` is the muted explanation beside it.
  // `fg` paints the label in its own hue — the accent submenu uses it to render
  // each preset name as a live swatch of the color it would set.
  type MenuRow = { label: string; desc?: string; current?: boolean; fg?: string; choose: (run: boolean) => void };

  // The unified slash menu — three shapes, one row list:
  //   • command — the flat `/command` list (filters as you type)
  //   • value   — an enum submenu (theme/approvals/reasoning), current value marked
  //   • models  — the live, searchable model picker (main or subagent), current
  //               marked; choosing dispatches the typed set-(subagent-)model
  const menuModel = createMemo(() => {
    const pick = modelPicker();
    if (pick !== null) {
      const t = pick.target;
      const isAgent = typeof t === "object";
      const agentName = isAgent ? t.agent : "";
      const curAgent = isAgent ? (agents()?.find((a) => a.name === agentName)?.model ?? null) : null;
      const curSub = subagentModelSig();
      const curMain = headModel();
      // Title: named-agent targets show the agent; main/sub carry the Tab toggle.
      const title = isAgent
        ? `model · agent: ${agentName}`
        : t === "sub"
          ? "model · Tab: Subagents ◂ Main"
          : "model · Tab: Main ▸ Subagents";
      const hint = isAgent
        ? `setting agent "${agentName}"  ·  now: ${curAgent ?? "inherits"}`
        : t === "sub"
          ? `setting SUBAGENTS  ·  now: ${curSub ?? "inherits main"}`
          : `setting MAIN agent  ·  now: ${curMain}`;
      const all = models();
      if (all === null)
        return { open: true, loading: true, kind: "models" as const, isAgent, title, hint, rows: [] as MenuRow[] };
      const q = pick.query.toLowerCase();
      const cur = isAgent ? curAgent : t === "sub" ? curSub : curMain;
      const rows: MenuRow[] = all
        .filter((mdl) => {
          const full = `${mdl.providerId}/${mdl.id}`.toLowerCase();
          return !q || full.includes(q) || (mdl.name ?? "").toLowerCase().includes(q);
        })
        .map((mdl) => {
          const full = `${mdl.providerId}/${mdl.id}`;
          return {
            label: full,
            desc: mdl.contextWindow ? fmtContext(mdl.contextWindow) : "",
            current: cur === full,
            choose: () => {
              if (isAgent) {
                props.engine.send({ type: "set-agent-model", name: agentName, model: full });
                setAgents(null); // force a re-fetch so the menu reflects the change
              } else if (t === "sub") {
                setSubagentModelSig(full);
                props.engine.send({ type: "set-subagent-model", model: full });
              } else {
                props.engine.send({ type: "set-model", model: full });
              }
              setDraft("");
            },
          } satisfies MenuRow;
        });
      // Zero matches must keep the menu OPEN with a placeholder — otherwise the
      // menu silently closes (looks like "still loading") and a stray Enter
      // submits the literal `/model <typo>` line, persisting an unresolvable id
      // as the main model. Choosing the placeholder is a no-op.
      if (rows.length === 0) {
        rows.push({
          label: "No matching models",
          desc: "backspace to widen the filter, or type a full provider/id",
          choose: () => {},
        } satisfies MenuRow);
      }
      return { open: true, loading: false, kind: "models" as const, isAgent, title, hint, rows };
    }
    const provQuery = providersPickerQuery();
    if (provQuery !== null) {
      const title = "providers · Enter to configure";
      const hint = "✓ configured   ○ needs a key";
      const all = providers();
      if (all === null) return { open: true, loading: true, kind: "providers" as const, title, hint, rows: [] as MenuRow[] };
      const q = provQuery.toLowerCase();
      const rows: MenuRow[] = all
        .filter((p) => !q || p.id.includes(q))
        .map((p) => {
          const status = p.keyless
            ? "keyless · local"
            : p.configured
              ? `key set · ${p.env[0] ?? ""}`
              : `no key — set ${p.env[0] ?? "key"}`;
          return {
            // The ✓/○ in the label conveys status; no ● (that marks a "current" pick).
            label: `${p.configured ? "✓" : "○"} ${p.id}`,
            desc: status,
            // Configured/keyless → browse its models; unconfigured → prefill the key
            // entry (reuses the existing `/model key <provider> …` engine path).
            choose: () => setDraft(p.configured ? `/model ${p.id}/` : `/model key ${p.id} `),
          } satisfies MenuRow;
        });
      return { open: rows.length > 0, loading: false, kind: "providers" as const, title, hint, rows };
    }
    const agentsQuery = agentsPickerQuery();
    if (agentsQuery !== null) {
      const title = "agents · Enter to set model";
      const hint = "Enter → pick its model  ·  /agents new <name> to create one";
      const all = agents();
      if (all === null) return { open: true, loading: true, kind: "agents" as const, title, hint, rows: [] as MenuRow[] };
      const q = agentsQuery.toLowerCase();
      const rows: MenuRow[] = all
        .filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
        .map((a) => ({
          label: a.name,
          desc: `${a.model ?? "inherits"} · ${a.mode}`,
          // Selecting an agent opens the model picker targeting it.
          choose: () => setDraft(`/model agent ${a.name} `),
        }));
      // A trailing affordance to scaffold a new agent.
      rows.push({ label: "＋ new agent…", choose: () => setDraft("/agents new ") });
      return { open: rows.length > 0, loading: false, kind: "agents" as const, title, hint, rows };
    }
    const skillsQuery = skillsPickerQuery();
    if (skillsQuery !== null) {
      const title = "skills";
      const hint = "Enter → prefill /skill <name>  ·  the model can also load them itself";
      const all = skillsList();
      if (all === null)
        return { open: true, loading: true, kind: "skills" as const, title, hint, rows: [] as MenuRow[] };
      const q = skillsQuery.toLowerCase();
      const rows: MenuRow[] = all
        .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
        .map((s) => ({
          label: s.name,
          // Frontmatter descriptions can span lines — the menu row shows ONE
          // clean line (the renderer ellipsizes at the column edge).
          desc: s.description.replace(/\s+/g, " ").trim(),
          // Prefill the explicit `/skill <name> ` spelling: the bare `/<name>`
          // is shadowed by any same-named built-in or custom command (a skill
          // called `review` or `init` would silently run the wrong thing).
          choose: () => setDraft(`/skill ${s.name} `),
        }));
      // Zero rows must still render a menu: a silent blank looks broken, and a
      // stray Enter would submit the literal `/skills xyz` line instead. The
      // placeholder row explains the empty state; choosing it is a no-op.
      if (rows.length === 0) {
        rows.push({
          label: all.length === 0 ? "No skills defined" : "No matching skills",
          desc:
            all.length === 0
              ? "add .vibe/skills/<name>/SKILL.md to define one"
              : "backspace to widen the filter",
          choose: () => {},
        });
      }
      return { open: true, loading: false, kind: "skills" as const, title, hint, rows };
    }
    const st = paletteState(draft());
    if (!st.open) return { open: false, loading: false, kind: "command" as const, title: "", hint: "", rows: [] as MenuRow[] };
    if (st.mode === "command") {
      const rows: MenuRow[] = st.items.map((c, idx) => {
        const hint = c.values ? ` (${c.values.join("|")})` : c.arg ? ` ${c.arg}` : "";
        return {
          label: `/${c.name}`,
          desc: `${c.description}${hint}`,
          choose: (run: boolean) => {
            const res = applyPalette(st, idx);
            if (!res) return;
            setDraft(res.draft);
            if (run && res.done) runText(res.draft);
          },
        };
      });
      return {
        open: true,
        loading: false,
        kind: "command" as const,
        title: "commands",
        hint: "↑↓ move · Tab complete · Enter run",
        rows,
      };
    }
    const cur = currentValueFor(st.command.name);
    const rows: MenuRow[] = st.items.map((v) => ({
      label: v,
      current: cur === v,
      // Accent rows render as live swatches — each preset name in its own hue.
      ...(st.command.name === "accent" && ACCENT_PRESETS[v] ? { fg: ACCENT_PRESETS[v] } : {}),
      choose: (run: boolean) => {
        const line = `/${st.command.name} ${v}`;
        setDraft(line);
        if (st.command.name === "reasoning") setReasoningSig(v === "off" ? undefined : v);
        if (run) runText(line);
      },
    }));
    const hint = st.command.name === "accent" ? "or type a hex — /accent #8b5cf6" : "";
    return { open: true, loading: false, kind: "value" as const, title: `/${st.command.name}`, hint, rows };
  });

  // Pre-highlight the current value (if any), else the first row, whenever the
  // menu contents change (new query / picker target / freshly-loaded models).
  createEffect(() => {
    const m = menuModel();
    void `${m.title}:${m.rows.length}:${m.loading}:${modelTarget()}`;
    const cur = m.rows.findIndex((r) => r.current);
    const sel = cur >= 0 ? cur : 0;
    setSelIdx(sel);
    ensureMenuVisible(sel, m.rows.length); // scroll so the pre-highlight is on-screen
  });

  // Lazily fetch the model list the first time a `/model` picker opens (cached
  // for the session); the picker shows "Fetching…" until it lands.
  createEffect(() => {
    if (modelPicker() !== null && models() === null && !modelsLoading()) {
      setModelsLoading(true);
      void Promise.resolve(props.engine.listModels?.() ?? [])
        .then((list) => setModels(list ?? []))
        .catch(() => setModels([]))
        .finally(() => setModelsLoading(false));
    }
  });

  // Lazily fetch the provider list the first time the `/providers` menu opens.
  createEffect(() => {
    if (providersPickerQuery() !== null && providers() === null && !providersLoading()) {
      setProvidersLoading(true);
      void Promise.resolve(props.engine.listProviders?.() ?? [])
        .then((list) => setProviders(list ?? []))
        .catch(() => setProviders([]))
        .finally(() => setProvidersLoading(false));
    }
  });

  // Fetch the named-agents list whenever the `/agents` menu (or an agent-targeted
  // model picker) is open and the cache was invalidated — so edits show at once.
  createEffect(() => {
    const needsAgents = agentsPickerQuery() !== null || typeof modelPicker()?.target === "object";
    if (needsAgents && agents() === null && !agentsLoading()) {
      setAgentsLoading(true);
      void Promise.resolve(props.engine.listAgents?.() ?? [])
        .then((list) => setAgents(list ?? []))
        .catch(() => setAgents([]))
        .finally(() => setAgentsLoading(false));
    }
  });

  // Lazily fetch the skills list the first time the `/skills` menu opens
  // (cached for the session — the skill set only changes on engine restart).
  createEffect(() => {
    if (skillsPickerQuery() !== null && skillsList() === null && !skillsLoading()) {
      setSkillsLoading(true);
      void Promise.resolve(props.engine.listSkills?.() ?? [])
        .then((list) => setSkillsList(list ?? []))
        .catch(() => setSkillsList([]))
        .finally(() => setSkillsLoading(false));
    }
  });

  // Apply the row at absolute index `i` (keyboard highlight or a click).
  const chooseAt = (i: number, run: boolean) => menuModel().rows[i]?.choose(run);

  // Windowed rows for rendering (≤ menuWindow() visible, scrolled to keep the
  // highlight in view). The window scroll (`menuStart`) is arrow-driven, NOT derived
  // from the highlight — so hovering never scrolls. Each view row carries its
  // absolute index so a click selects + runs it. Labels are padded into one
  // aligned column (across ALL rows, not just the visible window, so the column
  // doesn't shift as you scroll); the `●` current-marker column renders only for
  // menus that HAVE a current value (value/models), keeping the others tight.
  const menuView = () => {
    const m = menuModel();
    if (!m.open) return null;
    const win = menuWindow();
    const rows = m.rows;
    const sel = Math.min(Math.max(0, selIdx()), Math.max(0, rows.length - 1));
    const start = Math.min(Math.max(0, menuStart()), Math.max(0, rows.length - win));
    // Cap the label column so one very long name can't push every description
    // into the far distance. 32 keeps real-world model ids
    // (`anthropic/claude-opus-4-8`) in one aligned column; an outlier past the
    // cap still gets a 2-space gap before its description — the gap must never
    // collapse to zero (labels used to run straight into the desc: "…-4-81M").
    const labelW = Math.min(32, Math.max(0, ...rows.map((r) => (r.desc ? displayWidth(r.label) : 0))));
    const marker = m.kind === "value" || m.kind === "models";
    // Ellipsize a description that would clip at the column edge (wrapMode="none"
    // hard-cuts mid-word with no affordance): prefix `❯ ` (2) + optional marker
    // column (2) + the padded label are already spent; the desc gets the rest.
    const descW = (labelLen: number) =>
      Math.max(8, contentWidth() - 7 - 2 - (marker ? 2 : 0) - labelLen);
    const view = rows.slice(start, start + win).map((r, i) => {
      // padRight pads by display CELLS — `.padEnd` counts UTF-16 units, so a
      // label holding CJK/emoji used to shift every description out of column.
      const label = r.desc ? `${padRight(r.label, labelW)}  ` : r.label;
      return {
        active: start + i === sel,
        current: !!r.current,
        label,
        desc: r.desc ? truncate(r.desc, descW(displayWidth(label))) : "",
        fg: r.fg,
        idx: start + i,
      };
    });
    const more = rows.length > win ? `+${rows.length - win} more · type to filter` : "";
    return { rows: view, title: m.title, hint: m.hint, more, marker, loading: m.loading };
  };

  // ── Transcript state ────────────────────────────────────────────────────────
  // The pure reducer (reducer.ts) owns blocks/changedFiles + the streaming/tool
  // cursors; this file mirrors its output into Solid signals for rendering.
  let ts = initialTranscript();
  const commit = () => {
    // One batched write: without batch(), the two signal writes trigger two
    // separate downstream recomputes (turns() + full yoga relayout each).
    batch(() => {
      setBlocks(ts.blocks);
      setChangedFiles(ts.changedFiles);
    });
  };
  const resetTranscript = () => {
    ts = initialTranscript();
    commit();
  };

  // Streamed deltas are COALESCED: tokens accumulate in a buffer and flush on a
  // short timer (~40fps) instead of one reduce + <markdown> re-parse per token.
  // Re-parsing growing text on every token is O(n²) and was the source of the
  // streaming lag on long replies; flushing per frame keeps it smooth. Live
  // tool-output chunks (bash progress) coalesce on the same timer — a chatty
  // build would otherwise force a re-render per chunk.
  let pendingDelta = "";
  const pendingProgress = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const STREAM_FLUSH_MS = 24;
  const landPending = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Reasoning first: the trail + inline preview update in the same frame's
    // batch, and a thinking row landed by a later action sees the full burst.
    landReasoning();
    if (pendingProgress.size) {
      for (const [toolCallId, chunk] of pendingProgress) {
        ts = reduceTranscript(ts, { type: "tool-progress", toolCallId, chunk });
      }
      pendingProgress.clear();
    }
    if (!pendingDelta) return;
    ts = reduceTranscript(ts, { type: "delta", text: pendingDelta });
    pendingDelta = "";
  };
  const flushAssistant = () => {
    landPending();
    commit();
  };
  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flushAssistant, STREAM_FLUSH_MS);
  };

  // Two ways to apply a transcript action. Both land buffered stream text
  // first (so the action sees the up-to-date reply) and reduce IMMEDIATELY —
  // `ts` is always in exact event order. They differ only in when the state
  // is PAINTED:
  //
  // `enqueue` — the default for engine-event traffic — defers the commit to
  // the shared frame timer, so a burst of tool-start/finish/file-changed
  // events (a scaffold generator touching hundreds of files) costs at most
  // ONE transcript relayout per frame instead of one per event. Per-event
  // synchronous commits were the main-thread saturation that froze input:
  // relayout cost × event rate exceeded the loop budget and stdin starved.
  const enqueue = (action: TranscriptAction) => {
    if (action.type !== "delta") landPending();
    ts = reduceTranscript(ts, action);
    scheduleFlush();
  };
  // `apply` — the immediate path — commits this tick. For user-initiated
  // mutations (expand/collapse needs its scroll-anchor microtask to run
  // against a committed layout) and the few events where a frame of latency
  // is wrong: turn end, plan card, engine errors.
  const apply = (action: TranscriptAction) => {
    if (action.type !== "delta") landPending();
    ts = reduceTranscript(ts, action);
    commit();
  };

  // Finalize the streaming reply (land buffered text, flip `streaming` off).
  const finalizeAssistant = () => apply({ type: "finalize" });
  // Toggle a tool/diff block's collapsed state (the click-to-expand handler).
  const toggle = (id: number) => apply({ type: "toggle", id });

  // ── The sidebar trail + `✻ thought` burst plumbing ──────────────────────────
  /** A tool fired — record `{icon} {action}` in the trail so a model that
   * emits no reasoning still shows a live activity stream in the panel. */
  const pushActivity = (label: string) => {
    trail.pushLine(label);
    if (trailKind() === "none") setTrailKind("activity");
    trailDirty = true;
    scheduleFlush();
  };
  /** Buffer a reasoning token — O(1); the trail/preview land once per frame. */
  const pushReasoning = (delta: string) => {
    if (!reasoningBuf && !pendingReasoning) thinkingStartedAt = Date.now();
    pendingReasoning += delta;
    scheduleFlush();
  };
  /** Land buffered reasoning + any trail changes as AT MOST one signal write
   * each — called from landPending (every frame flush) and commitThinking. */
  const landReasoning = () => {
    if (pendingReasoning) {
      const chunk = pendingReasoning;
      pendingReasoning = "";
      // Bounded: keep the HEAD of a huge think (the framing) for the transcript
      // row rather than an arbitrary mid-sentence tail; the preview tracks the
      // newest lines via its own small rolling window.
      if (reasoningBuf.length < 20_000) reasoningBuf += chunk;
      reasoningTailBuf = (reasoningTailBuf + chunk).slice(-8000);
      trail.append(chunk);
      trailDirty = true;
      if (trailKind() !== "reasoning") setTrailKind("reasoning");
      setReasoningLines(
        reasoningTailBuf
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-24),
      );
    }
    if (trailDirty) {
      trailDirty = false;
      setThoughtLog(trail.snapshot());
    }
  };
  // Land the accumulated burst as a `✻ thought` transcript row and clear the
  // preview. Enqueued (frame-coalesced): this runs on every assistant text
  // token while a burst pends, and the row's paint can share the next frame.
  const commitThinking = () => {
    landReasoning();
    if (reasoningBuf.trim()) {
      enqueue({
        type: "thinking",
        text: reasoningBuf,
        seconds: Math.round((Date.now() - thinkingStartedAt) / 1000),
      });
    }
    reasoningBuf = "";
    reasoningTailBuf = "";
    // Only clear the preview when it has lines: an unconditional fresh-[]
    // write would force a re-render per token during a reply flood.
    if (reasoningLines().length > 0) setReasoningLines([]);
  };
  /** Per-turn / full reset of every trail + burst buffer (new turn, /clear). */
  const resetTrail = () => {
    trail.reset();
    trailDirty = false;
    pendingReasoning = "";
    reasoningBuf = "";
    reasoningTailBuf = "";
    if (thoughtLog().length > 0) setThoughtLog([]);
    if (trailKind() !== "none") setTrailKind("none");
  };

  // Refresh the header chrome + rail projections whenever live status changes.
  const refreshStatus = () => {
    setUiMode(deriveUiMode(mode, approvals));
    setHeadModel(model);
    setMetrics(metricsLine(queued(), usage, ctx));
    setGoalInfo(goal);
    setCmdNames(new Set((props.engine.snapshot().commandNames ?? []).map((s) => s.toLowerCase())));
  };
  // Resolve the oldest pending permission and drop it from the queue. Grants
  // leave a transcript notice — a single `a` keypress is a durable session-wide
  // grant, and an invisible one is how an accidental keystroke becomes silent
  // policy. Denials already surface via the engine's "Blocked …" warn notice
  // (which carries any typed feedback), so no local echo for those.
  const answerPerm = (
    decision: "once" | "always" | "always-project" | "deny",
    feedback?: string,
  ) => {
    const head = perms()[0];
    if (!head) return;
    props.engine.send({
      type: "resolve-permission",
      id: head.id,
      decision,
      ...(feedback ? { feedback } : {}),
    });
    if (decision !== "deny") {
      const scope =
        decision === "always-project"
          ? "always allowed (remembered for this project)"
          : decision === "always"
            ? "always allowed (this session)"
            : "allowed once";
      apply({
        type: "notice",
        text: `${scope} — ${toolLabel(head.toolName, head.input)}`,
        level: "info",
      });
    }
    setPerms((p) => p.slice(1));
  };
  // Resolve a presented plan from the approval card, then dismiss it.
  // `approvals:"auto"` (the Ctrl+Y shortcut) launches execution in yolo.
  const answerPlan = (
    decision: "accept" | "edit" | "keep-planning",
    edit?: string,
    approvals?: "auto",
  ) => {
    props.engine.send({
      type: "resolve-plan",
      decision,
      ...(edit ? { edit } : {}),
      ...(approvals ? { approvals } : {}),
    });
    setPlan(null);
  };

  // Shift+Tab cycles plan → execute → yolo. `useKeyboard` is a global handler,
  // so it fires even while the input is focused; Shift+Tab arrives as the key
  // name "tab" with `shift` set. The engine emits mode/approvals events back,
  // which refresh the header.
  const cycleMode = () => {
    const target = nextUiMode(deriveUiMode(mode, approvals));
    for (const cmd of commandsForUiMode(target)) props.engine.send(cmd);
  };
  // Graceful exit — the SAME teardown the `/exit` command runs (await finalize:
  // session digest, background-job reap, MCP close — then exit; OpenTUI's own
  // exit hook restores the terminal). Ctrl+C routes here now that the renderer's
  // exitOnCtrlC is off (its default handler exited WITHOUT finalize, leaking
  // jobs + dropping the digest). A second press while finalize is in flight
  // hard-exits so a hung teardown can't trap the user.
  let exiting = false;
  const gracefulExit = () => {
    if (exiting) process.exit(130);
    exiting = true;
    void (async () => {
      try {
        await props.engine.finalize?.();
        // Remove this session's pasted-clipboard PNGs — they can't be unlinked at
        // paste time (expandMentions reads them at submit). Best-effort + swallowed.
        await cleanupClipboardTempDir();
      } finally {
        process.exit(0);
      }
    })();
  };
  // Ctrl+V: paste an IMAGE off the OS clipboard. We only intercept when an image
  // is actually present — a text paste is delivered by the terminal as bracketed
  // paste straight into the textarea, untouched here. The decoded bytes land in a
  // session temp file and an `@<path>` mention is inserted at the cursor so the
  // existing mention pipeline (byte caps, media typing) handles the rest.
  let pastingImage = false;
  const pasteClipboardImage = async () => {
    if (pastingImage) return; // a slow probe can't stack presses
    pastingImage = true;
    try {
      const res = await readClipboardImage();
      if (res.kind === "unavailable") {
        apply({
          type: "notice",
          text: "No clipboard image tool found (install pngpaste on macOS, wl-clipboard/xclip on Linux).",
          level: "warn",
        });
        return;
      }
      if (res.kind === "none") return; // text/empty clipboard — nothing to paste as an image
      const mention = `@${res.path} `;
      const el = inputEl;
      if (el) {
        el.editBuffer.insertText(mention);
        setDraft(el.editBuffer.getText());
      } else {
        setDraft(`${draft()}${mention}`);
      }
    } catch (err) {
      apply({ type: "notice", text: `Clipboard paste failed: ${(err as Error).message}`, level: "warn" });
    } finally {
      pastingImage = false;
    }
  };
  // Ctrl+G: compose the draft in $VISUAL/$EDITOR. Suspend the renderer (releases
  // raw mode + stdin) so the editor owns the terminal, run it with stdio
  // inherited, then resume and adopt the edited text. Empty file → keep the prior
  // draft.
  const editorSpawn: EditorSpawn = (command, args) =>
    new Promise((resolve, reject) => {
      try {
        const proc = Bun.spawn([command, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        proc.exited.then(() => resolve()).catch(reject);
      } catch (err) {
        reject(err as Error);
      }
    });
  let composing = false;
  const composeDraftInEditor = async () => {
    if (composing) return;
    composing = true;
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
      apply({ type: "notice", text: "Set $VISUAL or $EDITOR to compose in an external editor.", level: "warn" });
      composing = false;
      return;
    }
    renderer.suspend();
    try {
      const result = await composeInEditor({ editor, draft: draft(), spawn: editorSpawn });
      if (result.kind === "replaced") {
        setDraft(result.draft);
        refocusInput();
      } else if (result.kind === "kept") {
        apply({ type: "notice", text: "Editor draft was empty — kept your prior text.", level: "info" });
      } else if (result.kind === "failed") {
        apply({ type: "notice", text: `Editor failed: ${result.reason}`, level: "warn" });
      }
    } catch (err) {
      // A throw (e.g. an unwritable $TMPDIR) must NOT leave the `composing` latch
      // stuck true — that would make Ctrl+G a permanent no-op for the session.
      apply({ type: "notice", text: `Editor failed: ${(err as Error)?.message ?? String(err)}`, level: "warn" });
    } finally {
      renderer.resume();
      composing = false;
    }
  };
  // Apply the highlighted menu row; `run` also submits a complete one.
  const choosePalette = (run: boolean) => chooseAt(selIdx(), run);
  useKeyboard(
    (key: { name?: string; shift?: boolean; ctrl?: boolean; preventDefault?: () => void }) => {
    // Shift+Tab cycles plan → execute → yolo, menu open or not.
    if (key.name === "tab" && key.shift) {
      key.preventDefault?.();
      cycleMode();
      return;
    }
    // Ctrl+C: clear a half-typed draft first (readline muscle memory); on an
    // empty draft it exits GRACEFULLY (finalize, then exit — the same path as
    // /exit). Pressing again mid-teardown hard-exits.
    if (key.ctrl && key.name === "c") {
      key.preventDefault?.();
      if (!exiting && draft().trim()) {
        setDraft("");
        return;
      }
      gracefulExit();
      return;
    }
    // Ctrl+O folds/unfolds every turn's tool work at once (just the prose left).
    if (key.ctrl && key.name === "o") {
      key.preventDefault?.();
      toggleAllTurns();
      return;
    }
    // Ctrl+T expands every `✻ thought` row at once (collapses them again if all
    // are open) — the keyboard route to the reasoning, beside click-per-row.
    if (key.ctrl && key.name === "t") {
      key.preventDefault?.();
      apply({ type: "toggle-thinking-all" });
      return;
    }
    // Ctrl+V: paste a clipboard IMAGE as an `@<tmpfile>` mention. Only fires when
    // an image is present; a text paste is bracketed-paste'd into the textarea and
    // never reaches here. preventDefault stops the textarea inserting a literal.
    if (key.ctrl && key.name === "v") {
      key.preventDefault?.();
      void pasteClipboardImage();
      return;
    }
    // Ctrl+G: open the draft in $VISUAL/$EDITOR (suspends the TUI for the editor).
    if (key.ctrl && key.name === "g") {
      key.preventDefault?.();
      void composeDraftInEditor();
      return;
    }
    // Esc closes the /jobs sub-view first (before it interrupts a turn).
    if (key.name === "escape" && showJobs()) {
      key.preventDefault?.();
      setShowJobs(false);
      return;
    }
    const m = menuModel();
    // Ctrl+P: grant AND remember for this project (durable config rule). Ctrl-chorded
    // — mirroring the ^Y plan-accept precedent — so the first keystroke of a typed
    // deny message ("please deny…", "prefer…") can never fire a persistent ALLOW.
    if (key.ctrl && key.name === "p" && perms().length > 0 && !m.open) {
      key.preventDefault?.();
      answerPerm("always-project");
      return;
    }
    // Permission shortcuts: while a request is pending and you're not mid-typing,
    // y/a/n answers it directly and Esc rejects it. `p` (always-project) is a
    // Ctrl+P chord above, NOT a bare letter, because it writes a durable rule.
    if (perms().length > 0 && !m.open && !draft().trim()) {
      // y once · a always (session) · n deny.
      if (key.name === "y" || key.name === "a" || key.name === "n") {
        key.preventDefault?.();
        answerPerm(
          key.name === "y" ? "once" : key.name === "a" ? "always" : "deny",
        );
        return;
      }
      if (key.name === "escape") {
        key.preventDefault?.();
        answerPerm("deny");
        return;
      }
    }
    // Plan-approval shortcuts: while a plan card is up and the input is empty,
    // Enter accepts (execute) and Esc keeps planning (dismiss). Typing a message
    // instead revises the plan (handled in runText) — so letters never collide.
    if (plan() && !m.open && perms().length === 0 && !draft().trim()) {
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault?.();
        answerPlan("accept");
        return;
      }
      // Ctrl+Y: accept AND run unattended (yolo approvals). Ctrl-chorded so a
      // typed revision starting with "y"/"Y" can never fire it by accident.
      if (key.ctrl && key.name === "y") {
        key.preventDefault?.();
        answerPlan("accept", undefined, "auto");
        return;
      }
      if (key.name === "escape") {
        key.preventDefault?.();
        answerPlan("keep-planning");
        return;
      }
    }
    // While a plan card is up, Esc discards a half-typed REVISION (so the input
    // returns to empty and the plan-approval shortcuts take over) rather than
    // aborting — the plan turn already ended, and the draft-clear branch below is
    // otherwise shadowed because working() stays true while the card is shown.
    if (key.name === "escape" && !m.open && plan() && draft().trim() && perms().length === 0) {
      key.preventDefault?.();
      setDraft("");
      return;
    }
    // Esc interrupts an in-flight turn when nothing else claims the key.
    if (key.name === "escape" && !m.open && working() && perms().length === 0) {
      key.preventDefault?.();
      props.engine.send({ type: "abort" });
      return;
    }
    // Otherwise Esc clears a half-typed draft (e.g. a prefilled `/model key …` from
    // the providers menu) so the input returns to empty in one keystroke.
    if (key.name === "escape" && !m.open && !working() && draft().trim()) {
      key.preventDefault?.();
      setDraft("");
      return;
    }
    if (!m.open) return; // menu closed → let the input handle keys normally
    const n = m.rows.length; // 0 while the model picker is still fetching
    switch (key.name) {
      case "up":
        key.preventDefault?.();
        if (n) {
          const ni = (selIdx() - 1 + n) % n;
          setSelIdx(ni);
          ensureMenuVisible(ni, n);
        }
        break;
      case "down":
        key.preventDefault?.();
        if (n) {
          const ni = (selIdx() + 1) % n;
          setSelIdx(ni);
          ensureMenuVisible(ni, n);
        }
        break;
      case "tab":
        key.preventDefault?.();
        // In the main/subagent model picker, Tab flips the target; for an
        // agent-targeted picker (or any other menu) it completes the highlight.
        if (m.kind === "models" && !m.isAgent) setModelTarget((t) => (t === "main" ? "sub" : "main"));
        else if (n) choosePalette(false);
        break;
      case "return":
      case "enter": // run the highlighted entry (preventDefault stops onSubmit)
        key.preventDefault?.();
        if (n) choosePalette(true);
        break;
      case "escape":
        key.preventDefault?.();
        setDraft("");
        break;
      default:
        break;
    }
  });

  onMount(() => {
    // Animate the working spinner / elapsed clock while a turn runs — and also
    // while the /jobs sub-view is open, so its per-job running spinners actually
    // spin (otherwise `tick` never advances at idle and they freeze).
    const timer = setInterval(() => {
      if (working() || showJobs()) setTick((t) => t + 1);
    }, 90);
    onCleanup(() => {
      clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
    });

    void (async () => {
      // Reasoning plumbing (pushReasoning / landReasoning / commitThinking /
      // the sidebar trail) lives at component scope, above — shared with
      // landPending's frame flush and the /clear reset.
      // The reducer owns per-turn call maps; endTurn lands any dangling
      // thinking, finalizes the reply, drops the maps, and stops the spinner.
      const endTurn = () => {
        commitThinking();
        apply({ type: "clear-turn" });
        setWorking(false);
      };
      for await (const event of props.engine.events() as AsyncIterable<UIEvent>) {
        // A throwing handler must not kill this loop: the keyboard hook lives
        // outside it, so an uncaught throw here used to leave a half-alive UI
        // (typing works, nothing updates) with no visible cause. Surface the
        // error as a transcript notice and keep consuming.
        try {
        switch (event.type) {
          case "user-message":
            // Subagents are per-turn activity (tasks persist, they don't) — start
            // each turn with a clean SUBAGENTS section. The plan box is transient
            // too: a new turn means it was acted on or abandoned.
            setSubagents([]);
            setPlan(null);
            // The sidebar's trail spans ONE turn — the previous turn's stream
            // clears here (not at turn end, so it stays readable while you
            // review the finished work).
            resetTrail();
            apply({ type: "user", text: event.text });
            // A new turn begins: start the working clock/spinner.
            turnStartedAt = Date.now();
            setTick(0);
            setWorking(true);
            break;
          case "assistant-text-delta":
            // Subagent deltas (they carry a subagentId) are summarized in the
            // Subagents panel, not streamed into the parent transcript; empty
            // deltas are no-ops.
            if (event.subagentId || !event.delta) break;
            // Real answer text is streaming — the model acted, so the thinking
            // burst lands as its transcript row (and the live preview clears).
            commitThinking();
            // Buffer the token and flush on the next frame — coalescing keeps long
            // streamed replies smooth.
            pendingDelta += event.delta;
            scheduleFlush();
            break;
          case "reasoning-delta":
            // The model's chain-of-thought: a one-line live preview under the
            // spinner while it thinks, landed as a collapsed transcript row when
            // it acts (subagent thinking stays in its panel row).
            if (event.subagentId || !event.delta) break;
            pushReasoning(event.delta);
            break;
          case "tool-call-started":
            if (event.subagentId) break; // subagent tools don't enter the transcript
            // The thinking that led to this call lands just above it.
            commitThinking();
            // And the action itself joins the sidebar trail, chronological with
            // the reasoning around it — a non-reasoning model's whole trail.
            pushActivity(toolLabel(event.toolName, event.input));
            enqueue({
              type: "tool-start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              at: Date.now(),
            });
            break;
          case "tool-call-progress":
            // Live streamed output (bash stdout/stderr) → the running row's tail
            // preview, so a long build/test is visibly alive line by line.
            // Coalesced onto the frame timer like text deltas.
            pendingProgress.set(
              event.toolCallId,
              (pendingProgress.get(event.toolCallId) ?? "") + event.chunk,
            );
            scheduleFlush();
            break;
          case "tool-call-finished":
            if (event.subagentId) break;
            enqueue({
              type: "tool-finish",
              toolCallId: event.toolCallId,
              output: event.output,
              isError: event.isError,
              at: Date.now(),
            });
            break;
          case "file-changed":
            // The reducer folds the diff into the EXACT tool block that produced it
            // (by call id), so an edit reads as one row with the hunk beneath it, and
            // accumulates the per-file delta for the footer summary.
            enqueue({
              type: "file-changed",
              toolCallId: event.toolCallId,
              path: event.path,
              action: event.action,
              added: event.added,
              removed: event.removed,
              ...(event.diff ? { diff: event.diff } : {}),
            });
            break;
          case "tasks-updated":
            setTasks(event.tasks);
            break;
          case "queue-changed":
            setPendingQ(event.pending);
            refreshStatus();
            break;
          case "usage-updated":
            usage = event.usage;
            refreshStatus();
            break;
          case "context-updated":
            ctx = { usedTokens: event.usedTokens, contextWindow: event.contextWindow };
            refreshStatus();
            break;
          case "permission-request":
            setPerms((p) => [...p, { id: event.id, toolName: event.toolName, input: event.input }]);
            break;
          case "permission-settled":
            // The engine auto-denied these prompts (abort / shutdown) with no user
            // answer — drop their cards so a stale prompt doesn't linger into the
            // next turn, block Esc/plan shortcuts, or let a later keypress write a
            // false "allowed" notice for a tool that never ran (answerPerm's
            // `if (!head) return` then makes the answer a silent no-op).
            setPerms((p) => dropSettledPerms(p, event.ids));
            break;
          case "plan-presented":
            finalizeAssistant();
            setPlan({
              text: event.plan,
              ...(event.sources?.length ? { sources: event.sources } : {}),
              ...(event.assumptions?.length ? { assumptions: event.assumptions } : {}),
              ...(event.ungrounded ? { ungrounded: true } : {}),
            });
            break;
          case "subagent-started":
            setSubagents((prev) => [
              ...prev,
              { id: event.subagentId, prompt: event.prompt, status: "running", startedAt: Date.now() },
            ]);
            break;
          case "subagent-activity":
            // Live "what is it doing now" line — attach only to the RUNNING child,
            // so a stray activity event arriving after it finished can't relight a
            // done row's label.
            setSubagents((prev) =>
              prev.map((s) =>
                s.id === event.subagentId && s.status === "running"
                  ? { ...s, activity: event.label }
                  : s,
              ),
            );
            break;
          case "subagent-finished":
            setSubagents((prev) =>
              prev.map((s) =>
                s.id === event.subagentId
                  ? {
                      ...s,
                      status: "done",
                      activity: undefined,
                      result: firstLine(event.result),
                      ...(s.startedAt ? { elapsedMs: Date.now() - s.startedAt } : {}),
                    }
                  : s,
              ),
            );
            break;
          case "mode-changed":
            mode = event.mode;
            // Leaving plan mode DISMISSES the plan card. Switching to
            // execute/yolo already approved the plan engine-side (deferred
            // handoff armed + "your next message starts implementation"
            // notice); if the card survived, the next typed message would be
            // captured as a plan REVISION (answerPlan "edit"), silently
            // revoking the armed handoff and re-planning — the opposite of
            // what the notice just promised. Its other affordances are stale
            // too: Enter is a no-op (#lastPlan already spent) and Ctrl+Y's
            // yolo intent is dropped by the double-accept guard.
            if (event.mode !== "plan") setPlan(null);
            refreshStatus();
            break;
          case "model-changed":
            model = event.model;
            refreshStatus();
            break;
          case "goal-changed":
            goal = event.goal;
            refreshStatus();
            break;
          case "goal-run":
            setGoalRunState(event.run);
            break;
          case "approvals-changed":
            approvals = event.mode;
            refreshStatus();
            break;
          case "theme-changed":
            setPalette(getTheme(event.theme));
            setThemeName(event.theme);
            break;
          case "accent-changed":
            setAccentColor(event.accent);
            break;
          case "git-updated":
            setGit(event.git);
            break;
          case "jobs-changed":
            setJobs(event.jobs);
            break;
          case "turn-finished":
          case "session-idle":
            // The turn ended — finalize the reply, drop per-turn maps, stop the
            // spinner.
            endTurn();
            break;
          case "notice":
            enqueue({ type: "notice", text: event.message, level: event.level });
            break;
          case "compacted":
            // Surface compaction in the transcript (the footer's ctx% also drops),
            // matching the headless printer — otherwise `/compact` looks like a no-op.
            enqueue({
              type: "notice",
              text: `Compacted history · freed ~${event.freedTokens} tokens`,
              level: "info",
            });
            break;
          case "loop-stopped":
            enqueue({ type: "notice", text: `Loop stopped — ${event.reason}`, level: "info" });
            break;
          case "loop-tick":
            // Mark each `/loop` iteration in the transcript (headless parity) so
            // recurring runs read as separate passes, not one endless turn.
            enqueue({ type: "notice", text: `${GLYPH.loopTick} loop iteration ${event.iteration}`, level: "info" });
            break;
          case "checkpoint-restored":
            // /undo landed — say so in the transcript (the headless printer
            // already did); otherwise a successful revert looked like a no-op.
            enqueue({ type: "notice", text: `${GLYPH.revert} reverted: ${event.label}`, level: "info" });
            break;
          case "verify-started":
            enqueue({ type: "notice", text: `verifying: ${event.command}`, level: "info" });
            break;
          case "verify-finished": {
            // Failures carry the check's first line so the reason is visible
            // without leaving the transcript (the payload was never shown anywhere).
            const detail =
              !event.ok && event.output ? ` — ${truncate(firstLine(event.output) ?? "", 120)}` : "";
            enqueue({
              type: "notice",
              text: event.ok ? "verification passed" : `verification failed${detail}`,
              level: event.ok ? "info" : "error",
            });
            break;
          }
          case "engine-error":
            endTurn();
            apply({ type: "notice", text: `error: ${event.message}`, level: "error" });
            break;
          default:
            break;
        }
        } catch (err) {
          apply({
            type: "notice",
            text: `ui error handling "${event.type}": ${err instanceof Error ? err.message : String(err)}`,
            level: "error",
          });
        }
      }
    })().catch((err) => {
      // The event iterator itself died (not a per-event throw) — say so in the
      // transcript instead of a silent half-alive UI. The process-level crash
      // handlers (crash.ts) still cover anything that escapes past here.
      apply({
        type: "notice",
        text: `event stream stopped: ${err instanceof Error ? err.message : String(err)}`,
        level: "error",
      });
      setWorking(false);
    });
  });

  const runText = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setDraft("");
    // A new turn: re-engage auto-follow so the streamed reply scrolls into view
    // (a prior expand/collapse may have disengaged it — see `anchoredToggle`).
    if (scrollEl) scrollEl.stickyScroll = true;
    if (text === "/exit" || text === "/quit") {
      // Await finalize (session digest + teardown) before the hard exit — the
      // shared gracefulExit path (also bound to Ctrl+C).
      gracefulExit();
      return;
    }
    // `/jobs` toggles the background-jobs sub-view (running shell commands +
    // detected localhost servers). Handled locally — no engine round-trip.
    if (text === "/jobs") {
      setShowJobs((v) => !v);
      return;
    }
    // While permission prompts are pending, a typed reply answers the oldest:
    // exact y/yes/a/always/n/no decide; free text denies WITH the text as feedback
    // (the model sees "denied by user — <text>" and can adjust). A SLASH line is
    // not an answer — it's a command (e.g. `/clear` to escape a stuck card),
    // routed to the command handling below (mirrors the plan card's exemption).
    if (perms().length > 0) {
      const routed = routePendingPermLine(text);
      if (routed.kind === "perm") {
        answerPerm(routed.decision, routed.feedback);
        return;
      }
      // passthrough → fall through to /clear + command handling below.
    }
    // A plan card is up: a non-slash message is revision feedback (re-plan), not a
    // fresh turn. Slash commands (/execute, /model, …) still route normally.
    if (plan() && !text.startsWith("/")) {
      answerPlan("edit", text);
      return;
    }
    // `/clear` (and `/new`) reset the conversation — wipe the visible transcript
    // AND every piece of live turn state so nothing dangles (a stale spinner,
    // an orphaned permission card, a half-streamed reply). Abort first if a turn
    // is in flight so the engine stops streaming into the cleared screen.
    if (text === "/clear" || text === "/new") {
      if (working()) props.engine.send({ type: "abort" });
      pendingDelta = "";
      pendingProgress.clear();
      resetTranscript();
      // The sidebar's trail outlives its turn by design, so the reset must
      // wipe it explicitly — otherwise a stale Thinking block keeps the
      // sidebar mounted over the freshly cleared screen.
      resetTrail();
      setPlan(null);
      setSubagents([]);
      setCollapsedTurns(new Set());
      setRevealTurns(0);
      setPerms([]);
      setPendingQ([]);
      setWorking(false);
    }
    // Adding a provider key or refreshing the catalog changes what the model /
    // provider pickers should show, so drop their session caches — the next open
    // re-fetches fresh (mirrors the setAgents(null) invalidation on agent edits).
    // Without this, a provider configured mid-session keeps showing as ○/stale.
    if (/^\/model\s+key\b/i.test(text) || /^\/models?\s+refresh\b/i.test(text)) {
      setModels(null);
      setProviders(null);
    }
    // Route through the shared mapper so `/model <id>`, `/goal <text>`, etc.
    // keep their arguments (the same logic the REPL uses). A line may expand to
    // more than one command (`/plan <text>` = switch mode + submit the text).
    for (const cmd of lineToCommands(text)) props.engine.send(cmd);
  };
  // OpenTUI's input passes the committed value on Enter; fall back to the
  // controlled draft. When the command menu is open the keyboard handler
  // intercepts Enter instead, so this runs only for prompts / typed commands.
  const submit = (value?: string) => runText(value ?? draft());

  // Status is split by location: cwd · git · goal go TOP-LEFT (`topLeftLine`),
  // while model · changed-files · ctx/usage/cost sit UNDER the input (`detailsRight`).
  const gitSummary = () => {
    const g = git();
    if (!g) return "";
    // "on <branch>" (starship-style) — the `⎇` branch glyph has spotty coverage
    // across terminal fonts (it falls back to a clipped placeholder), so plain
    // words keep the context line clean everywhere.
    let s = `on ${g.branch}`;
    if (g.dirty > 0) s += ` ${g.dirty}●`;
    if (g.ahead > 0 || g.behind > 0) s += ` ↑${g.ahead} ↓${g.behind}`;
    if (g.worktree) s += " ⌂";
    return s;
  };
  const changedSummary = () => {
    const fs = changedFiles();
    if (fs.length === 0) return "";
    const added = fs.reduce((s, f) => s + f.added, 0);
    const removed = fs.reduce((s, f) => s + f.removed, 0);
    const delta = [added > 0 ? `+${added}` : "", removed > 0 ? `-${removed}` : ""]
      .filter(Boolean)
      .join(" ");
    return `${GLYPH.file} ${fs.length} file${fs.length === 1 ? "" : "s"}${delta ? ` ${delta}` : ""}`;
  };
  // Show the block wordmark when the column is wide + tall enough to seat it
  // (it's 80 cols / 7 rows); otherwise the splash falls back to the compact
  // ascii-font logo, then a one-line glyph. The column padding eats 2 cols.
  const showWordmark = () =>
    contentWidth() - 2 >= WORDMARK_COLS && dims().height >= 16;
  // Fit `parts` into `width` columns: join with `  ·  `, dropping trailing parts
  // (least important last) until the line fits, then ellipsis-truncate as a last
  // resort — so a narrow terminal NEVER hard-clips a status line mid-word.
  const fitParts = (parts: string[], width: number): string => {
    const keep = parts.filter(Boolean);
    // Measured in display cells — a CJK path/branch counts its real columns.
    while (keep.length > 1 && displayWidth(keep.join("  ·  ")) > width) keep.pop();
    return truncate(keep.join("  ·  "), Math.max(8, width));
  };
  // The persistent "where am I" context — location · git · goal — sits at the
  // TOP-LEFT of the column (out of the way), not under the input. While the
  // sidebar's session card is up it OWNS these facts — the line goes blank
  // (the row itself stays, pinned to height 1, so nothing reflows) instead of
  // double-printing the same dir/git/goal a few columns from the card.
  const topLeftLine = () =>
    sidebarOn()
      ? ""
      : fitParts(
          [cwd, gitSummary(), goalInfo() ? `★ ${truncate(goalInfo() ?? "", 44)}${goalSuffix()}` : ""],
          contentWidth() - 2,
        );
  // Live status shown under the input: model · changed · ctx · cost. The metrics
  // string re-splits on the same separator so fitting can drop its least-important
  // tail pieces individually (queued/cost/tokens) instead of the whole group.
  // With the session card up, model + usage live THERE — the footer keeps only
  // what the card doesn't show (the changed-files delta).
  const detailsRight = () =>
    fitParts(
      sidebarOn()
        ? [changedSummary()]
        : [headModel(), changedSummary(), ...metrics().split(/\s+·\s+/)],
      contentWidth() - 2,
    );
  const runningJobs = () => jobs().filter((j) => j.status === "running").length;
  // The sidebar session card's value lines (no label words — the values are
  // self-evident). One line per row, pre-truncated to the card's inner width
  // (a `wrapMode:none` overflow would hard-clip mid-glyph, eating the `…`).
  // The dir keeps its TAIL — in a deep path the trailing segments are the
  // ones that identify where you are. `dim` mutes the secondary rows.
  const sessionRows = (): { value: string; dim?: boolean }[] => {
    // 42 (sidebar) − 2 (column padding) − 4 (panel padding), minus 2 more so
    // the `…` lands INSIDE the box (the render clips at the edge otherwise).
    const valW = SIDEBAR_W - 8;
    // Display-cell tail keep (the old `.slice(-(valW - 1))` counted UTF-16 units
    // and could open on half a surrogate pair in a CJK/emoji path).
    const tail = (s: string) => tailWidth(s, valW);
    const rows: { value: string; dim?: boolean }[] = [
      { value: tail(cwd) },
      { value: tail(headModel()) },
    ];
    const g = gitSummary();
    if (g) rows.push({ value: truncate(g, valW), dim: true });
    // metricsLine's separator is wide ("  ·  "); tighten it for the narrow
    // card. Its parts self-label (ctx % / tokens / cost / queued).
    const m = metrics().replaceAll("  ·  ", " · ");
    if (m) rows.push({ value: truncate(m, valW), dim: true });
    const goal = goalInfo();
    // The run suffix survives truncation — on a long goal it's the suffix
    // (planning / 7/25 / paused / met) that carries the information.
    if (goal) {
      const suffix = goalSuffix();
      rows.push({ value: `${truncate(`★ ${goal}`, valW - suffix.length)}${suffix}`, dim: true });
    }
    return rows;
  };
  // Key hints as coloured runs: the actionable tokens (keys, `/`, `click`) pop in
  // the bright foreground; descriptors + separators stay muted. Shown on the empty
  // splash (where discovery matters) and whenever a job is running; the working
  // footer otherwise stays a single status line. `/jobs` is advertised only while
  // background jobs are actually running.
  const hintSegs = (): Seg[] => {
    const dim = palette().muted;
    const lit = palette().assistant;
    const segs: Seg[] = [
      { t: "shift+tab", fg: lit },
      { t: " mode", fg: dim },
      { t: "  ·  ", fg: dim },
      { t: "/", fg: lit },
      { t: " commands", fg: dim },
      { t: "  ·  ", fg: dim },
      { t: "click", fg: lit },
      { t: " ▸ expand", fg: dim },
    ];
    const n = runningJobs();
    if (n > 0) {
      segs.push(
        { t: "  ·  ", fg: dim },
        { t: `${n} job${n === 1 ? "" : "s"}`, fg: palette().notice },
        { t: " running ", fg: dim },
        { t: "(/jobs)", fg: lit },
      );
    }
    return segs;
  };
  // Hints belong under the input on the empty splash, and any time a background
  // job is running (so the `/jobs` pointer is reachable) — otherwise the working
  // footer is just the one status line.
  const showHints = () => blocks().length === 0 || runningJobs() > 0;
  // The under-input status bar is justified (status left, hints right). Only keep
  // both on ONE row when they actually fit with a gap; otherwise the hints drop to
  // their own row so the two never collide / clip on a narrow terminal.
  const hintsWidth = () => hintSegs().reduce((n, s) => n + displayWidth(s.t), 0);
  const footerFits = () => contentWidth() - 2 >= displayWidth(detailsRight()) + hintsWidth() + 6;

  // Hover-vs-arrows: a menu row's onMouseOver would otherwise keep pinning the
  // selection to whatever row is under a RESTING mouse — so pressing ↑/↓ appeared
  // to do nothing (the re-fired hover snapped it back, especially once the window
  // scrolled a new row under the cursor). Gate hover on ACTUAL pointer movement:
  // remember the last (x,y) and only re-select when it changes. A re-fire at the
  // same coords is ignored, so the keyboard wins until you truly move the mouse.
  let lastPointerX = -1;
  let lastPointerY = -1;
  const hoverRow = (idx: number, e: { x: number; y: number }) => {
    if (e.x === lastPointerX && e.y === lastPointerY) return;
    lastPointerX = e.x;
    lastPointerY = e.y;
    setSelIdx(idx);
  };

  return (
    <box
      position="relative"
      flexDirection="row"
      backgroundColor={palette().background}
      style={{ height: "100%" }}
      onMouseDown={refocusInput}
    >
      {/* Copy toast — a "Copied to clipboard" card that slides in at the top-right
          corner on a selection copy, holds, then slides out (see flashCopied /
          toastTop). Absolutely positioned so it overlays the column. Same block
          language (and height) as the compact input strip: accent rail + elevated
          surface. */}
      <Show when={toastFrame() >= 0}>
        <box position="absolute" top={toastTop()} right={2} flexShrink={0}>
          <Rail color={brand()}>
            <box
              backgroundColor={palette().elevated}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
            >
              <text fg={palette().assistant}>{`${GLYPH.check} Copied to clipboard`}</text>
            </box>
          </Rail>
        </box>
      </Show>

      {/* Left gutter — black backdrop that centers the chat column. */}
      <box flexGrow={1} flexShrink={1} />

      {/* The chat column — one centered, capped-width conversation column. No top
          bar: the brand is the centered splash, and the live details sit under the
          input. Everything else (transcript, status panels, input) lives here. */}
      <box
        position="relative"
        flexDirection="column"
        width={contentWidth()}
        flexShrink={0}
        padding={1}
      >
      {/* Top-left context line: location · git · goal — the persistent "where am
          I", tucked in the corner so it's out of the conversation's way. Pinned
          to height 1: it goes BLANK (not away) while the sidebar session card
          shows the same facts, so the transcript top never reflows. */}
      <box flexDirection="row" flexShrink={0} height={1}>
        <text flexShrink={1} fg={palette().muted} wrapMode="none">{topLeftLine()}</text>
        <box flexGrow={1} />
      </box>
      {/* Body — the /jobs sub-view when open; otherwise a centered VIBE CODR splash
          on a fresh screen, or the scrolling transcript once the chat starts. */}
      <box flexDirection="column" flexGrow={1}>
        {/* /jobs sub-view: running shell commands + detected localhost servers, in
            place of the transcript. Esc or /jobs closes it. */}
        <Show when={showJobs()}>
          <box flexDirection="column" flexGrow={1}>
            <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>
              {`Background jobs · ${jobs().length}`}
            </text>
            <text flexShrink={0} fg={palette().muted}>
              {"running shell commands + any localhost servers · esc or /jobs to close"}
            </text>
            <scrollbox
              flexGrow={1}
              flexShrink={1}
              scrollY
              contentOptions={{ flexDirection: "column", gap: 1 }}
              scrollbarOptions={{ visible: false }}
            >
              <Show
                when={jobs().length > 0}
                fallback={
                  <text fg={palette().muted} wrapMode="word" marginTop={1}>
                    {"No background jobs yet — start a long-running command (a dev server, watcher, or build) with the bash tool's background mode and it'll appear here with any localhost URL it prints."}
                  </text>
                }
              >
                <For each={jobs()}>
                  {(j) => {
                    const c = () =>
                      j.status === "running"
                        ? brand()
                        : j.status === "killed"
                          ? palette().del
                          : palette().muted;
                    return (
                      <box flexDirection="column">
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={c()}>
                            {j.status === "running"
                              ? spinnerFrame(tick())
                              : j.status === "killed"
                                ? GLYPH.warn
                                : GLYPH.check}
                          </text>
                          <text flexGrow={1} wrapMode="word" fg={palette().assistant}>{j.command}</text>
                          <text flexShrink={0} fg={palette().muted}>
                            {j.status === "running"
                              ? j.pid
                                ? `pid ${j.pid}`
                                : "running"
                              : `${j.status} ${j.exitCode ?? ""}`.trim()}
                          </text>
                        </box>
                        <For each={j.servers}>
                          {(url) => <text fg={palette().tool}>{`    → ${url}`}</text>}
                        </For>
                        <For each={j.outputTail.split("\n").filter(Boolean).slice(-4)}>
                          {(line) => (
                            <text fg={palette().muted} wrapMode="none">
                              {`    ${truncate(line, Math.max(20, contentWidth() - 8))}`}
                            </text>
                          )}
                        </For>
                      </box>
                    );
                  }}
                </For>
              </Show>
            </scrollbox>
          </box>
        </Show>
        <Show when={!showJobs()}>
        <Show
          when={blocks().length > 0}
          fallback={
            // Vertically centered by the top/bottom flex-grow spacers. The
            // wordmark and every tip line are EACH centered on their own row, so
            // the whole splash reads as one centered column under the logo.
            <box flexDirection="column" flexGrow={1}>
              <box flexGrow={1} />
              <box flexDirection="row">
                <box flexGrow={1} />
                <box flexDirection="column" flexShrink={0}>
                  <Show
                    when={showWordmark()}
                    fallback={
                      <Show
                        when={contentWidth() >= LOGO_MIN_COLS && dims().height >= 12}
                        fallback={
                          <text fg={brand()} attributes={TextAttributes.BOLD}>{"◆ Vibe Codr"}</text>
                        }
                      >
                        {/* Native ASCII-font wordmark (medium terminals, where the
                            block art doesn't fit) — the flat brand accent (a
                            per-character gradient isn't available on this renderable). */}
                        <ascii_font text="VIBE CODR" font="slick" color={brand()} />
                      </Show>
                    }
                  >
                    {/* ░██ block wordmark with a clean left→right single-hue brand
                        sweep: each row is a line of per-character <text>s colored by
                        COLUMN position, so column i shares a ramp position across
                        every row and the whole block reads as one smooth light→deep
                        brand fade, not per-letter confetti. Follows `/accent`. Static
                        (rendered once on the idle splash) — no idle timer. */}
                    <For each={WORDMARK}>
                      {(line) => <BrandLine line={line} cols={WORDMARK_COLS} hue={brand()} />}
                    </For>
                  </Show>
                </box>
                <box flexGrow={1} />
              </box>
              {/* Prompt starters under the wordmark: a quiet intro, then the
                  example asks as a block-centered list with aligned `›` markers —
                  reads as inviting quick-actions instead of a cramped one-liner. */}
              <box flexDirection="column" marginTop={2}>
                <SegRow center segs={[{ t: "Try asking", fg: palette().muted }]} />
                <box flexDirection="row" flexShrink={0} marginTop={1}>
                  <box flexGrow={1} />
                  <box flexDirection="column" flexShrink={0}>
                    <For each={["explain this codebase", "fix the failing test", "add a --json flag"]}>
                      {(ex) => (
                        <box flexDirection="row" flexShrink={0}>
                          <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>{"›  "}</text>
                          <text flexShrink={0} fg={palette().assistant}>{ex}</text>
                        </box>
                      )}
                    </For>
                  </box>
                  <box flexGrow={1} />
                </box>
              </box>
              <box flexGrow={1} />
            </box>
          }
        >
        <scrollbox
          ref={(el: typeof scrollEl) => (scrollEl = el)}
          flexGrow={1}
          flexShrink={1}
          stickyScroll
          stickyStart="bottom"
          scrollY
          viewportCulling
          contentOptions={{ flexDirection: "column" }}
          scrollbarOptions={{ visible: false }}
        >
          {/* Older turns beyond the render window: a single tappable fold row.
              Revealing pages them back in (scroll-anchored, see revealOlder) —
              the data was never dropped, only kept out of the layout tree. */}
          <Show when={windowStart() > 0}>
            <box flexDirection="column" flexShrink={0} marginTop={1} onMouseDown={revealOlder}>
              <text flexShrink={0} fg={palette().muted}>
                {`▸ ${windowStart()} earlier turn${windowStart() === 1 ? "" : "s"} · tap to load ${Math.min(REVEAL_PAGE, windowStart())} more`}
              </text>
            </box>
          </Show>
          {/* The transcript as connected TURN THREADS. `<Index>` keys by position
              (turns only ever append, and the window is stable while a turn
              streams), so streaming re-renders only the live turn.
              Each turn: a `◆` node carrying the user message, then a continuous
              left rail (git-graph style) running top→bottom through the turn's tool
              steps + answer. Tap the node to fold the whole exchange under it. */}
          <Index each={windowedTurns()}>
            {(turn) => {
              const hasNode = () => turn().user !== undefined;
              const items = () => turn().items;
              const itemStart = () => turnWindowStart(items().length, TURN_ITEMS_MAX, TURN_ITEMS_STEP);
              const visibleItems = () => items().slice(itemStart());
              const folded = () => hasNode() && collapsedTurns().has(turn().key);
              const foldTap = () => {
                if (hasNode() && items().length > 0) anchoredToggle(() => toggleTurn(turn().key));
              };
              // Content width inside a block = column pad(2) + block left border(1) +
              // block padding L(2)+R(2) = 7 consumed.
              const blockInner = () => contentWidth() - 7;
              return (
                // Every block (including the first, below the top-left context line)
                // gets the same 1-row top gap, so spacing is uniform throughout.
                <box flexDirection="column" flexShrink={0} marginTop={1}>
                  {/* Each turn renders as UNIFORM filled BLOCKS (opencode-style): a
                      raised panel surface with top/bottom/left padding and a thin left
                      accent edge. The fill makes it read as one clean, uniform solid
                      block on any terminal; the accent is a thin line, not a bar. */}
                  <Show when={turn().user}>
                    <Rail color={brand()} onMouseDown={foldTap}>
                      <box
                        backgroundColor={palette().panel}
                        flexDirection="column"
                        paddingTop={1}
                        paddingBottom={1}
                        paddingLeft={2}
                        paddingRight={2}
                      >
                        <text flexShrink={0} wrapMode="word" fg={palette().assistant} attributes={TextAttributes.BOLD}>
                          {turn().user!.text}
                        </text>
                        <Show when={folded()}>
                          <text flexShrink={0} fg={palette().muted} marginTop={1}>
                            {`▸ ${items().length} item${items().length === 1 ? "" : "s"} hidden · tap to expand`}
                          </text>
                        </Show>
                      </box>
                    </Rail>
                  </Show>
                  {/* The turn's output — assistant answer + tool steps + notices — in a
                      single uniform panel block with a subtle left accent. */}
                  <Show when={!folded() && items().length > 0}>
                    <Rail color={palette().gutter} marginTop={hasNode() ? 1 : 0}>
                      <box
                        backgroundColor={palette().panel}
                        flexDirection="column"
                        paddingTop={1}
                        paddingBottom={1}
                        paddingLeft={2}
                        paddingRight={2}
                      >
                        <Show when={itemStart() > 0}>
                          <text flexShrink={0} fg={palette().muted} marginBottom={1}>
                            {`▸ ${itemStart()} earlier item${itemStart() === 1 ? "" : "s"} in this turn hidden`}
                          </text>
                        </Show>
                        <Index each={visibleItems()}>
                          {(blk, i) => {
                            const sourceIndex = () => itemStart() + i;
                            const prev = () => items()[sourceIndex() - 1];
                            // A step row (tool or thinking) stacks flush under a
                            // preceding step — a run of thought→act→act reads as one
                            // segment; otherwise a gap row above it.
                            const steppy = (k: string | undefined) => k === "tool" || k === "thinking";
                            const chained = () =>
                              steppy(blk().kind) && steppy(prev()?.kind);
                            return (
                              <>
                                <Show when={blk().kind === "assistant"}>
                                  <box
                                    id={`msg-${(blk() as { id: number }).id}`}
                                    flexDirection="column"
                                    flexShrink={0}
                                    marginTop={sourceIndex() > 0 && (blk() as { gap: boolean }).gap ? 1 : 0}
                                  >
                                    <AssistantText
                                      text={(blk() as { text: string }).text}
                                      streaming={(blk() as { streaming: boolean }).streaming}
                                      style={mdStyle}
                                      fg={palette().assistant}
                                      palette={palette()}
                                      width={blockInner()}
                                      indent={0}
                                    />
                                  </box>
                                </Show>
                                <Show when={blk().kind === "tool"}>
                                  <ToolBlockView
                                    block={blk as () => Extract<Block, { kind: "tool" }>}
                                    palette={palette()}
                                    style={mdStyle}
                                    chained={sourceIndex() > 0 && chained()}
                                    first={sourceIndex() === 0}
                                    width={blockInner()}
                                    spin={() => spinnerFrame(tick())}
                                    onToggle={(id) => anchoredToggle(() => toggle(id))}
                                  />
                                </Show>
                                <Show when={blk().kind === "thinking"}>
                                  <ThinkingBlockView
                                    block={blk as () => Extract<Block, { kind: "thinking" }>}
                                    palette={palette()}
                                    chained={sourceIndex() > 0 && chained()}
                                    first={sourceIndex() === 0}
                                    width={blockInner()}
                                    onToggle={(id) => anchoredToggle(() => toggle(id))}
                                  />
                                </Show>
                                <Show when={blk().kind === "notice"}>
                                  {/* Severity carries the tone: errors red, warnings
                                      amber, plain info MUTED — system chatter ("Plan
                                      saved to …") must recede, not read as a warning.
                                      A leading `·` marks a system note. No word-wrap:
                                      command output (/help, /config) is pre-aligned. */}
                                  <text
                                    flexShrink={0}
                                    fg={
                                      (blk() as { level?: string }).level === "error"
                                        ? palette().del
                                        : (blk() as { level?: string }).level === "warn"
                                          ? palette().notice
                                          : palette().muted
                                    }
                                    marginTop={sourceIndex() > 0 ? 1 : 0}
                                  >
                                    {/* Clamped per line so one long unbroken notice
                                        (an error payload) can't widen the panel. */}
                                    {`· ${(blk() as { text: string }).text
                                      .split("\n")
                                      .map((l) => truncate(l, Math.max(20, blockInner() - 2)))
                                      .join("\n")}`}
                                  </text>
                                </Show>
                              </>
                            );
                          }}
                        </Index>
                      </box>
                    </Rail>
                  </Show>
                </box>
              );
            }}
          </Index>
        </scrollbox>
        </Show>
        </Show>
      </box>

      {/* Live working indicator — the braille spinner glyph animates via `tick`
          (which only advances while a turn runs) in a hue-cycling rainbow so
          "the model is thinking" has its own signature; the elapsed/interrupt
          label stays muted for readability. Hidden while a permission card is
          up (the card is the active affordance then). */}
      <Show when={working() && perms().length === 0 && !plan()}>
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <box flexDirection="row" flexShrink={0}>
            <text fg={rainbow(tick())}>
              {spinnerFrame(tick())}
            </text>
            <text fg={palette().muted}>
              {` ${elapsedLabel()}  ·  esc to interrupt`}
            </text>
          </box>
          {/* Live thinking stack — the model's last few reasoning lines stream
              under the spinner while it thinks (older lines recede to the
              dimmer gutter tone, the newest reads in muted). The stack clears
              when the burst lands as its `✻ thought` transcript row. */}
          <Show when={!sidebarOn() && reasoningLines().length > 0}>
            <box flexDirection="column" flexShrink={0}>
              {/* Inline view: just the last 3 lines, clipped to the column (the
                  deeper untruncated tail feeds the sidebar on wide panes). */}
              <Index each={reasoningLines().slice(-3)}>
                {(line, i) => (
                  <box flexDirection="row" flexShrink={0}>
                    <text flexShrink={0} fg={i === 0 ? rainbow(tick()) : palette().gutter}>{i === 0 ? "  ✻ " : "    "}</text>
                    <text
                      flexShrink={1}
                      wrapMode="none"
                      fg={i === Math.min(3, reasoningLines().length) - 1 ? palette().muted : palette().gutter}
                      attributes={TextAttributes.ITALIC}
                    >
                      {truncate(line(), Math.max(24, contentWidth() - 10))}
                    </text>
                  </box>
                )}
              </Index>
            </box>
          </Show>
        </box>
      </Show>
      <Show when={plan()}>
        {/* Bounded + scrollable: the plan can be long, so its content scrolls
            inside the card (mouse wheel / drag) while the approval hint below it
            and the input stay on-screen — instead of the whole thing overflowing.
            Same block language as the turns + input: a filled panel surface with a
            thin left accent in the PLAN hue, so the approval moment reads as one
            coherent card. */}
        <Rail color={modeColor("plan")} marginTop={1} height={planPanelRows()}>
          <box
            backgroundColor={palette().panel}
            flexDirection="column"
            flexGrow={1}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
          >
            <text flexShrink={0} fg={modeColor("plan")} attributes={TextAttributes.BOLD}>
              {"Plan · review & approve"}
            </text>
            <Show when={plan()?.ungrounded}>
              <text flexShrink={0} fg={palette().notice} attributes={TextAttributes.BOLD}>
                {"⚠ ungrounded — presented without the research this request required"}
              </text>
            </Show>
            <Show when={plan()?.sources?.length || plan()?.assumptions?.length}>
              <text flexShrink={0} fg={palette().muted}>
                {[
                  plan()?.sources?.length
                    ? `Grounded in ${plan()!.sources!.length} web source${plan()!.sources!.length === 1 ? "" : "s"}`
                    : "",
                  plan()?.assumptions?.length
                    ? `${plan()!.assumptions!.length} assumption${plan()!.assumptions!.length === 1 ? "" : "s"} flagged`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </text>
            </Show>
            <scrollbox flexGrow={1} flexShrink={1} stickyScroll={false} scrollbarOptions={{ visible: false }}>
              <AssistantText
                text={planDisplayText()}
                streaming={false}
                style={mdStyle}
                fg={palette().assistant}
                palette={palette()}
                width={contentWidth() - 7}
              />
            </scrollbox>
            {/* Approval hint — actionable keys pop bright, descriptors stay muted. */}
            <box flexDirection="row" flexShrink={0} marginTop={1}>
              <For
                each={(() => {
                  const lit = palette().assistant;
                  const dim = palette().muted;
                  const segs: Seg[] = [
                    { t: "Enter", fg: lit },
                    { t: " accept & run", fg: dim },
                    { t: "  ·  ", fg: dim },
                    { t: "^Y", fg: lit },
                    { t: " run in yolo", fg: dim },
                    { t: "  ·  ", fg: dim },
                    { t: "type", fg: lit },
                    { t: " to revise", fg: dim },
                    { t: "  ·  ", fg: dim },
                    { t: "Esc", fg: lit },
                    { t: " keep planning", fg: dim },
                  ];
                  if (planOverflows()) segs.push({ t: "  ·  ", fg: dim }, { t: "scroll", fg: lit }, { t: " to read", fg: dim });
                  return segs;
                })()}
              >
                {(s) => <text flexShrink={0} fg={s.fg}>{s.t}</text>}
              </For>
            </box>
          </box>
        </Rail>
      </Show>
      {/* Tasks — the live to-do list, just above the input; hides once everything
          is done so a finished list doesn't linger. The window centers on the
          ACTIVE work: overflowing completed tasks collapse into one leading
          "✔ N done" line, so the in-progress task is never scrolled out.
          On wide terminals the list moves to the right sidebar instead. */}
      <Show when={!sidebarOn() && tasksVisible()}>
        <Panel
          title={`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
          titleColor={brand()}
        >
          <Show when={windowTasks(tasks(), PANEL_MAX_ROWS).lead > 0}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={palette().muted}>{TASK_GLYPH.completed}</text>
              <text flexShrink={0} fg={palette().muted}>
                {`${windowTasks(tasks(), PANEL_MAX_ROWS).lead} done`}
              </text>
            </box>
          </Show>
          <For each={windowTasks(tasks(), PANEL_MAX_ROWS).visible}>
            {(task) => {
              const c = () =>
                task.status === "completed"
                  ? palette().muted
                  : task.status === "in_progress"
                    ? brand()
                    : palette().assistant;
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={c()}>{TASK_GLYPH[task.status]}</text>
                  <text flexGrow={1} wrapMode="word" fg={c()}>{task.title}</text>
                </box>
              );
            }}
          </For>
          <Show when={windowTasks(tasks(), PANEL_MAX_ROWS).trailing > 0}>
            <text fg={palette().muted}>{`  +${windowTasks(tasks(), PANEL_MAX_ROWS).trailing} more`}</text>
          </Show>
        </Panel>
      </Show>
      {/* Subagents — live fan-out. ONE truncated line each by default (so a big
          fan-out stays tidy and never fills the screen); tap a row to expand its
          full prompt + result (bounded), tap again to collapse. Each row carries
          a right-aligned elapsed (live while running, final once done); a done
          row folds its result glimpse into the line. Cleared per turn. */}
      <Show when={!sidebarOn() && subagents().length > 0}>
        <Panel
          title={(() => {
            const done = subagents().filter((s) => s.status === "done").length;
            return done > 0 && done < subagents().length
              ? `Subagents · ${done}/${subagents().length} done`
              : `Subagents · ${subagents().length}`;
          })()}
          titleColor={brand()}
        >
          <For each={subagents().slice(0, PANEL_MAX_ROWS)}>
            {(s) => {
              const open = () => expandedSubs().has(s.id);
              // Calm single tone (no rainbow rotation): a running agent's glyph is
              // the brand accent (alive), a finished one recedes to the muted gutter
              // tone. The prompt text reads in the body color while running and
              // dims to muted once done so finished rows recede.
              const glyphFg = () => (s.status === "running" ? brand() : palette().gutter);
              const fg = () => (s.status === "running" ? palette().assistant : palette().muted);
              // Right-aligned elapsed: ticks live while running, freezes at the
              // total once done — the fan-out reads like a build matrix. A
              // sub-second finish shows nothing (a "0.0s" column is noise).
              const elapsed = () => {
                if (s.status === "running" && s.startedAt) {
                  void tick();
                  return `${Math.max(0, Math.round((Date.now() - s.startedAt) / 1000))}s`;
                }
                if (s.elapsedMs === undefined || s.elapsedMs < 1000) return "";
                return `${(s.elapsedMs / 1000).toFixed(s.elapsedMs >= 10_000 ? 0 : 1)}s`;
              };
              const oneLine = () => {
                const base = firstLine(s.prompt) ?? s.prompt;
                // A running child appends its live activity ("… · $ bun test");
                // a done row folds in its result glimpse ("… ↳ found 3 cases").
                const line =
                  s.status === "running" && s.activity
                    ? `${base} · ${s.activity}`
                    : s.status === "done" && s.result
                      ? `${base} ${GLYPH.result} ${s.result}`
                      : base;
                return truncate(line, Math.max(24, contentWidth() - 20));
              };
              return (
                <box flexDirection="column" onMouseDown={() => toggleSub(s.id)}>
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={palette().muted}>{open() ? "▾" : "▸"}</text>
                    <text flexShrink={0} fg={glyphFg()}>
                      {s.status === "running" ? spinnerFrame(tick()) : GLYPH.check}
                    </text>
                    <Show
                      when={open()}
                      fallback={<text flexGrow={1} wrapMode="none" fg={fg()}>{oneLine()}</text>}
                    >
                      {/* Bounded so an expanded row can't run off the screen. */}
                      <text flexGrow={1} wrapMode="word" fg={fg()}>{truncate(s.prompt, 700)}</text>
                    </Show>
                    <Show when={elapsed()}>
                      <text flexShrink={0} fg={palette().gutter}>{elapsed()}</text>
                    </Show>
                  </box>
                  <Show when={open() && s.result}>
                    {/* A flex row so a long result HANGS under the `↳` marker
                        instead of wrapping back to the panel's left edge. */}
                    <box flexDirection="row" paddingLeft={4}>
                      <text flexShrink={0} fg={palette().muted}>{`${GLYPH.result} `}</text>
                      <text flexGrow={1} wrapMode="word" fg={palette().muted}>
                        {truncate(s.result ?? "", 300)}
                      </text>
                    </box>
                  </Show>
                </box>
              );
            }}
          </For>
          <Show when={subagents().length > PANEL_MAX_ROWS}>
            <text fg={palette().muted}>{`  +${subagents().length - PANEL_MAX_ROWS} more`}</text>
          </Show>
        </Panel>
      </Show>
      {/* Queue — prompts you typed ahead while a turn runs. They auto-run in
          order; each row offers `steer` (jump it to the front + interrupt the
          current turn so it runs NOW) and `✕` (drop it). */}
      <Show when={pendingQ().length > 0}>
        <Panel title={`Queued · ${pendingQ().length}`} titleColor={brand()}>
          <For each={pendingQ().slice(0, PANEL_MAX_ROWS)}>
            {(q, i) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={palette().muted}>{`${i() + 1}.`}</text>
                <text flexGrow={1} wrapMode="none" fg={palette().assistant}>
                  {truncate(q.label, Math.max(20, contentWidth() - 24))}
                </text>
                <text
                  flexShrink={0}
                  fg={brand()}
                  attributes={TextAttributes.UNDERLINE}
                  onMouseDown={() => props.engine.send({ type: "steer", id: q.id })}
                >
                  {"steer"}
                </text>
                <text
                  flexShrink={0}
                  fg={palette().muted}
                  onMouseDown={() => props.engine.send({ type: "dequeue", id: q.id })}
                >
                  {"✕"}
                </text>
              </box>
            )}
          </For>
          <Show when={pendingQ().length > PANEL_MAX_ROWS}>
            <text fg={palette().muted}>{`  +${pendingQ().length - PANEL_MAX_ROWS} more queued`}</text>
          </Show>
          <text fg={palette().muted} marginTop={1}>
            {"steer = run next & interrupt now  ·  ✕ = remove  ·  otherwise they run in order"}
          </text>
        </Panel>
      </Show>
      {/* Permission request — the same block language as the turns + input: a
          filled panel card with a thin amber left accent. The tool action reads in
          the body tone; below it, a PREVIEW of what's actually being approved
          (the full command / the edit's -/+ lines / a write's content head) so
          the user never grants blind off a truncated one-liner. */}
      <Show when={perms()[0]}>
        {(p) => {
          const preview = () => permissionPreview(p().toolName, p().input);
          return (
            <Rail color={palette().notice} marginTop={1}>
              <box
                backgroundColor={palette().panel}
                flexDirection="column"
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
              >
                <text fg={palette().notice} attributes={TextAttributes.BOLD}>
                  {`${GLYPH.warn} Permission required · ${p().toolName}`}
                </text>
                <text fg={palette().assistant} wrapMode="word">{toolLabel(p().toolName, p().input)}</text>
                <Show when={preview()}>
                  <box flexDirection="column" flexShrink={0} marginTop={1}>
                    {/* Clamped to the card width — an unclamped wrapMode="none"
                        line (a long command) would widen the card past the column. */}
                    <For each={preview()!.lines}>
                      {(line) => (
                        <text
                          flexShrink={0}
                          wrapMode="none"
                          fg={preview()!.diff ? diffColor(line, palette()) : palette().muted}
                        >
                          {`  ${truncate(preview()!.diff ? diffPad(line) : line, Math.max(20, contentWidth() - 9)) || " "}`}
                        </text>
                      )}
                    </For>
                  </box>
                </Show>
                {/* The answer hints flow-WRAP: this concatenated row (y once · a
                    session · ^P project · n/esc deny · type → deny with feedback)
                    is ~110 cols and clipped its tail (the deny-with-feedback
                    affordance) at 80. flexWrap lets it stack onto extra rows at any
                    width instead of hard-clipping — the footer's own overflow policy,
                    applied here. ^P (Ctrl-chorded) grants always-for-this-project so
                    the first keystroke of a typed deny can't fire a durable ALLOW. */}
                <box flexDirection="row" flexWrap="wrap" flexShrink={0} marginTop={1}>
                  <For
                    each={[
                      { t: "y", fg: palette().assistant },
                      { t: " allow once", fg: palette().muted },
                      { t: "  ·  ", fg: palette().muted },
                      { t: "a", fg: palette().assistant },
                      { t: " always (session)", fg: palette().muted },
                      { t: "  ·  ", fg: palette().muted },
                      { t: "^P", fg: palette().assistant },
                      { t: " always (project)", fg: palette().muted },
                      { t: "  ·  ", fg: palette().muted },
                      { t: "n", fg: palette().assistant },
                      { t: "/", fg: palette().muted },
                      { t: "esc", fg: palette().assistant },
                      { t: " deny", fg: palette().muted },
                      { t: "  ·  ", fg: palette().muted },
                      { t: "type", fg: palette().assistant },
                      { t: " why → deny with feedback", fg: palette().muted },
                    ] satisfies Seg[]}
                  >
                    {(s) => <text flexShrink={0} fg={s.fg}>{s.t}</text>}
                  </For>
                  <Show when={perms().length > 1}>
                    <text flexShrink={0} fg={palette().muted}>{`  ·  +${perms().length - 1} more pending`}</text>
                  </Show>
                </box>
              </box>
            </Rail>
          );
        }}
      </Show>
      {/* The input — a UNIFORM filled block (same language as the message blocks):
          a raised ELEVATED surface (a shade above the panel blocks, so the active
          field stands out) with padding and a thin left rail in the MODE hue
          (ASK peach / PLAN green / YOLO red). The prompt reads `MODE ❯ …`; typing
          `/` opens the command menu as rows inside the SAME block above the prompt
          — one connected control. A background fill (not a line frame) stays a
          clean solid box on any terminal. */}
      <Rail color={accent()} marginTop={1}>
        <box
          backgroundColor={palette().elevated}
          flexDirection="column"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          {/* Command menu / submenus, inside the block above the prompt while typing
              `/`. ↑/↓ (or hover) highlight, Tab completes, Enter (or click) runs, Esc
              dismisses. `/model` opens a live searchable picker; enum commands mark the
              current value with `●`. Only the highlighted row carries a selection tint. */}
          <Show when={menuModel().open}>
            <box flexDirection="column" flexShrink={0}>
              {/* Section header in the theme's signature hue (violet on the
                  default) — the one colored line above a monochrome list,
                  mirroring opencode's dialog headers. */}
              <Show when={menuView()?.title}>
                <text fg={palette().heading} attributes={TextAttributes.BOLD}>{menuView()?.title}</text>
              </Show>
              <Show when={menuView()?.hint}>
                <text fg={palette().muted}>{menuView()?.hint}</text>
              </Show>
              <Show when={menuView()?.loading}>
                <text fg={palette().muted}>{"Loading…"}</text>
              </Show>
              <For each={menuView()?.rows ?? []}>
                {/* Two-column rows — the label (command/model/value) in the body
                    tone, its description muted beside it; the highlighted row gets
                    a FULL-WIDTH selection band (bg on the row box, with a flex
                    spacer) instead of a ragged text-length tint. Hover highlights
                    (only on real pointer movement — see hoverRow), click selects +
                    runs. Keyboard nav is global via useKeyboard; terminal rows
                    have no DOM focus, hence the a11y ignore. */}
                {(row) => (
                  // biome-ignore lint/a11y/useKeyWithMouseEvents: terminal UI — no text-row focus; keyboard nav is global (useKeyboard)
                  <box
                    flexDirection="row"
                    flexShrink={0}
                    backgroundColor={row.active ? palette().selBg : undefined}
                    onMouseOver={(e: { x: number; y: number }) => hoverRow(row.idx, e)}
                    onMouseDown={() => {
                      chooseAt(row.idx, true);
                      refocusInput();
                    }}
                  >
                    {/* On the active row everything flips to `selFg` — the band
                        is a solid accent surface (violet on the default theme),
                        so text must take the band's own contrast color, not the
                        chrome tones tuned for the dark backdrop. */}
                    <text flexShrink={0} fg={row.active ? palette().selFg : palette().muted}>
                      {`${row.active ? "❯" : " "} `}
                    </text>
                    <Show when={menuView()?.marker}>
                      <text flexShrink={0} fg={row.active ? palette().selFg : row.current ? brand() : palette().muted}>
                        {row.current ? "● " : "  "}
                      </text>
                    </Show>
                    {/* A row's own `fg` (the accent swatches) wins over the
                        active/body tones so the color preview reads even while
                        highlighted; selection still shows via ❯ + the band. */}
                    <text
                      flexShrink={0}
                      fg={row.fg ?? (row.active ? palette().selFg : palette().assistant)}
                      attributes={row.active ? TextAttributes.BOLD : undefined}
                    >
                      {row.label}
                    </text>
                    <Show when={row.desc}>
                      <text flexShrink={1} wrapMode="none" fg={row.active ? palette().selFg : palette().muted}>
                        {row.desc}
                      </text>
                    </Show>
                    <box flexGrow={1} />
                  </box>
                )}
              </For>
              <Show when={menuView()?.more}>
                {/* Indent matches the 2-char `❯ ` row prefix so the affordance
                    aligns with the label column above it. */}
                <text fg={palette().muted}>{`  ${menuView()?.more}`}</text>
              </Show>
              <text flexShrink={0}>{" "}</text>
            </box>
          </Show>
          {/* The prompt row: mode label · caret · field. The field grows with wrapped
              text up to INPUT_MAX_ROWS, then scrolls internally; the mode + caret stay
              on the first line. */}
          <box flexDirection="row" flexShrink={0}>
            <text flexShrink={0} fg={accent()} attributes={TextAttributes.BOLD}>{`${modeWord()} `}</text>
            <text flexShrink={0} fg={accent()} attributes={TextAttributes.BOLD}>{"❯ "}</text>
            {/* A TEXTAREA, not an <input>: OpenTUI's InputRenderable is
                single-line by design (height 1, no wrapping), so long drafts
                horizontally scrolled out of the box instead of wrapping — the
                "text going out of the input area" bug. The textarea wraps for
                real and OWNS its height: it auto-grows from one row up to
                INPUT_MAX_ROWS, then scrolls internally — no estimated row
                count to drift out of sync. PROMPT_KEYS restores chat semantics
                (Enter submits, Shift+Enter inserts a newline). Content flows
                textarea → draft via onContentChange; programmatic draft writes
                flow back through the createEffect near refocusInput. onSubmit
                receives a SubmitEvent, so it must not shadow submit's optional
                draft-override parameter. */}
            <textarea
              ref={(el: NonNullable<typeof inputEl>) => (inputEl = el)}
              focused
              flexGrow={1}
              minHeight={1}
              maxHeight={INPUT_MAX_ROWS}
              wrapMode="word"
              keyBindings={PROMPT_KEYS}
              onContentChange={() => {
                const v = inputEl?.editBuffer.getText() ?? "";
                if (v !== draft()) setDraft(v);
              }}
              onSubmit={() => submit()}
              placeholder="Send a message or type / to start"
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              // The "registered command" cue: a slash draft whose command word
              // is a real invocable (built-in, custom command, or skill) reads
              // in the heading hue — typo'd commands stay body-colored.
              textColor={draftIsCommand() ? palette().heading : palette().assistant}
              focusedTextColor={draftIsCommand() ? palette().heading : palette().assistant}
              placeholderColor={palette().muted}
              cursorColor={accent()}
            />
          </box>
        </box>
      </Rail>
      {/* Under-input status bar — a justified row, NOT centered: the live status
          (model · changed · ctx · cost) hugs the LEFT edge (aligned with the
          top-left context line), and the key hints hug the RIGHT edge. Hints show
          only on the splash / while a job runs; if they don't fit beside the status
          they drop to their own left row below (never centered, never colliding). */}
      {/* Pinned to height 1: with the session card up the status may be empty
          (model/usage live in the card), and a collapsed row would pull the
          sidebar's bottom-alignment reserve off by one. */}
      <box flexDirection="row" flexShrink={0} height={1} marginTop={1}>
        <text flexShrink={0} fg={palette().muted} wrapMode="none">{detailsRight()}</text>
        <box flexGrow={1} />
        <Show when={showHints() && footerFits()}>
          <box flexDirection="row" flexShrink={0}>
            <For each={hintSegs()}>{(s) => <text flexShrink={0} fg={s.fg}>{s.t}</text>}</For>
          </box>
        </Show>
      </box>
      <Show when={showHints() && !footerFits()}>
        <box flexDirection="row" flexShrink={0}>
          <For each={hintSegs()}>{(s) => <text flexShrink={0} fg={s.fg}>{s.t}</text>}</For>
        </box>
      </Show>
      </box>
      {/* Right sidebar (wide terminals) — a SESSION card on top (wordmark ·
          dir · model · git · ctx · goal), then Tasks, then the live Subagents
          fan-out, then the turn's THOUGHT LOG filling the rest. Each section is
          the SAME block language as the chat
          column (filled panel surface + thin left rail + identical padding),
          with the same uniform 1-row gap between blocks — the sidebar reads as
          one more column of the same material, not different chrome. */}
      <Show when={sidebarOn()}>
        <box flexDirection="column" width={SIDEBAR_W} flexShrink={0} padding={1}>
          {/* One reserved row mirrors the chat column's context line, so the
              sidebar's first block sits level with the first transcript block.
              No marginTop on the FIRST sidebar block: the chat's first-block
              margin is swallowed by its scrollbox, so a sidebar margin here
              would land the block one row too low. */}
          <box height={1} flexShrink={0} />
          {/* Session card — the sidebar's masthead. The SAME brand treatment as
              the main splash, scaled down: the ascii-font wordmark (the `tiny`
              half-block face, 31×2) in the chrome accent, then the session's
              vitals as bare value lines — no `dir`/`model` label words, the
              values are self-evident. Bright lines carry the two facts you
              glance for (where am I, which model); git/usage/goal stay muted.
              One line each, pre-truncated (the DIR keeps its TAIL — the deep
              segments are the informative ones). Empty rows don't render, and
              the chat column's top context line + footer drop their copies
              while this card is up (the sidebar owns them; no double-print). */}
          <Rail color={palette().gutter} marginTop={0}>
            <box
              backgroundColor={palette().panel}
              flexDirection="column"
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
            >
              <ascii_font
                text="VIBE CODR"
                font="tiny"
                color={brand()}
                backgroundColor={palette().panel}
              />
              <box height={1} flexShrink={0} />
              <For each={sessionRows()}>
                {(row) => (
                  <text
                    flexShrink={0}
                    wrapMode="none"
                    fg={row.dim ? palette().muted : palette().assistant}
                  >
                    {row.value}
                  </text>
                )}
              </For>
            </box>
          </Rail>
          <Show when={tasks().length > 0}>
            <Rail color={palette().gutter} marginTop={1}>
              <box
                backgroundColor={palette().panel}
                flexDirection="column"
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
              >
                <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>
                  {`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
                </text>
                <Show when={windowTasks(tasks(), sideTaskCap()).lead > 0}>
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={palette().muted}>{TASK_GLYPH.completed}</text>
                    <text flexShrink={0} fg={palette().muted}>
                      {`${windowTasks(tasks(), sideTaskCap()).lead} done`}
                    </text>
                  </box>
                </Show>
                <For each={windowTasks(tasks(), sideTaskCap()).visible}>
                  {(task) => {
                    const c = () =>
                      task.status === "completed"
                        ? palette().muted
                        : task.status === "in_progress"
                          ? brand()
                          : palette().assistant;
                    return (
                      <box flexDirection="row" gap={1}>
                        <text flexShrink={0} fg={c()}>{TASK_GLYPH[task.status]}</text>
                        <text flexGrow={1} wrapMode="word" fg={c()}>{task.title}</text>
                      </box>
                    );
                  }}
                </For>
                <Show when={windowTasks(tasks(), sideTaskCap()).trailing > 0}>
                  <text fg={palette().muted}>{`  +${windowTasks(tasks(), sideTaskCap()).trailing} more`}</text>
                </Show>
              </box>
            </Rail>
          </Show>
          {/* Subagents — the live fan-out, in the same block language as Tasks.
              One line per child (spinner while running / ✓ done, its prompt's
              first line, a right-aligned elapsed), plus a second muted line
              under the row for what it's DOING right now (live activity) or —
              once finished — its one-line result glimpse. The inline chat-column
              panel hides while the sidebar hosts this (exactly like Tasks). */}
          <Show when={subagents().length > 0}>
            <Rail color={palette().gutter} marginTop={1}>
              <box
                backgroundColor={palette().panel}
                flexDirection="column"
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
              >
                <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>
                  {(() => {
                    const done = subagents().filter((s) => s.status === "done").length;
                    return done > 0 && done < subagents().length
                      ? `Subagents · ${done}/${subagents().length} done`
                      : `Subagents · ${subagents().length}`;
                  })()}
                </text>
                <For each={subagents().slice(0, sideSubCap())}>
                  {(s) => {
                    const glyphFg = () => (s.status === "running" ? brand() : palette().gutter);
                    const fg = () => (s.status === "running" ? palette().assistant : palette().muted);
                    // Same elapsed shape as the inline panel: live while
                    // running, frozen total once done, sub-second hidden.
                    const elapsed = () => {
                      if (s.status === "running" && s.startedAt) {
                        void tick();
                        return `${Math.max(0, Math.round((Date.now() - s.startedAt) / 1000))}s`;
                      }
                      if (s.elapsedMs === undefined || s.elapsedMs < 1000) return "";
                      return `${(s.elapsedMs / 1000).toFixed(s.elapsedMs >= 10_000 ? 0 : 1)}s`;
                    };
                    // The under-row detail: live activity while running, the
                    // result glimpse once done (nothing → row stays one line).
                    const detail = () =>
                      s.status === "running" ? (s.activity ?? "") : (s.result ?? "");
                    return (
                      <box flexDirection="column">
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={glyphFg()}>
                            {s.status === "running" ? spinnerFrame(tick()) : GLYPH.check}
                          </text>
                          {/* Word-wrap up to ~2 lines (pre-truncated) instead of
                              hard-clipping mid-word at the column edge — a 42-col
                              card cut "fundamental analysis" to "fundamental
                              analysi", which read as a rendering bug. */}
                          <text flexGrow={1} wrapMode="word" fg={fg()}>
                            {truncate(firstLine(s.prompt) ?? s.prompt, 2 * (SIDEBAR_W - 12))}
                          </text>
                          <Show when={elapsed()}>
                            <text flexShrink={0} fg={palette().gutter}>{elapsed()}</text>
                          </Show>
                        </box>
                        <Show when={detail()}>
                          {/* Hang under the glyph column; wrapped but PRE-CAPPED
                              to ~2 lines so a chatty child can't grow the panel
                              row by row. */}
                          <box flexDirection="row" paddingLeft={2}>
                            <text flexShrink={0} fg={palette().muted}>
                              {s.status === "running" ? "· " : `${GLYPH.result} `}
                            </text>
                            <text
                              flexGrow={1}
                              wrapMode="word"
                              fg={palette().muted}
                              attributes={TextAttributes.ITALIC}
                            >
                              {truncate(detail(), 2 * (SIDEBAR_W - 12))}
                            </text>
                          </box>
                        </Show>
                      </box>
                    );
                  }}
                </For>
                <Show when={subagents().length > sideSubCap()}>
                  <text fg={palette().muted}>{`  +${subagents().length - sideSubCap()} more`}</text>
                </Show>
              </box>
            </Rail>
          </Show>
          {/* The thought log — the whole turn's reasoning as one continuous,
              word-wrapped stream in a bottom-sticky scrollbox (newest thought
              always in view, history scrollable). It does NOT clear when a
              burst lands as a transcript row, and it lingers after the turn
              ends — the thought process stays readable until the next message
              is sent. The block GROWS to fill the rows under the Tasks panel,
              so the sidebar's bottom lines up with the chat column. */}
          <Show when={working() || thoughtLog().length > 0}>
            {/* The session card is always above, so this is never the first
                block — the uniform 1-row inter-block gap applies. */}
            <Rail color={palette().gutter} marginTop={1} grow>
              <box
                backgroundColor={palette().panel}
                flexDirection="column"
                flexGrow={1}
                flexShrink={1}
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
              >
                <box flexDirection="row" flexShrink={0}>
                  <text flexShrink={0} fg={working() ? rainbow(tick()) : palette().gutter}>{"✻ "}</text>
                  <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>
                    {/* "Activity" when the trail is only tool actions (a
                        non-reasoning model) — honest labelling either way. */}
                    {trailKind() === "activity" ? "Activity" : "Thinking"}
                  </text>
                </box>
                <scrollbox
                  flexGrow={1}
                  flexShrink={1}
                  stickyScroll
                  stickyStart="bottom"
                  scrollY
                  contentOptions={{ flexDirection: "column" }}
                  scrollbarOptions={{ visible: false }}
                >
                  <Index each={thoughtLog()}>
                    {(line) => (
                      <text
                        flexShrink={0}
                        wrapMode="word"
                        fg={palette().muted}
                        attributes={TextAttributes.ITALIC}
                      >
                        {line() || " "}
                      </text>
                    )}
                  </Index>
                </scrollbox>
              </box>
            </Rail>
          </Show>
          {/* Reserve the chat column's under-input rows (the status bar's
              marginTop gap + the status row, +1 when the hints wrap to their
              own line) so the growing Thinking block's BOTTOM edge lands
              exactly on the input block's bottom edge — not on the terminal's
              bottom padding two rows below it. */}
          <box height={2 + (showHints() && !footerFits() ? 1 : 0)} flexShrink={0} />
        </box>
      </Show>
      {/* Right gutter — mirrors the left, centering the chat column. */}
      <box flexGrow={1} flexShrink={1} />
    </box>
  );
}

/** One coloured run in a {@link SegRow} — bright tokens on muted scaffolding. */
type Seg = { t: string; fg: string };

/** The rail glyph column: `▎` (left one-quarter block) per row — a THIN solid
 * line. Block elements render edge-to-edge (no inter-row gaps, unlike `│`), so
 * the line stays continuous on any terminal. Pre-built tall and clipped to the
 * card height by the overflow-hidden box in {@link Rail}. */
const RAIL_GLYPHS = Array(512).fill("▎").join("\n");

/**
 * A block with a thin left accent RAIL (git-graph style): a 1-column strip of
 * `▎` quarter-block glyphs, absolutely positioned over the block's reserved
 * first column and clipped to its height. This is deliberately NOT a
 * `border={["left"]}`: the border renderable paints outside normal content
 * flow, which (a) gaps `│` into dashes on terminals with line spacing and
 * (b) can leave stray ghost segments behind when a block reflows or scrolls
 * partially out of a scrollbox. Glyph content in flow is always clipped,
 * cleared, and repainted with its block.
 */
function Rail(props: {
  color: string;
  marginTop?: number;
  height?: number;
  /** Hug content but SHRINK when the parent runs out of rows. Default stays
   * rigid. */
  shrink?: boolean;
  /** GROW to fill the parent's remaining rows (and shrink under pressure) —
   * the sidebar's thinking block stretches so the sidebar spans the same
   * height as the chat column. */
  grow?: boolean;
  onMouseDown?: () => void;
  children: unknown;
}) {
  return (
    <box
      position="relative"
      flexDirection="row"
      flexGrow={props.grow ? 1 : 0}
      flexShrink={props.shrink || props.grow ? 1 : 0}
      marginTop={props.marginTop ?? 0}
      height={props.height}
      onMouseDown={props.onMouseDown}
    >
      {/* Reserve the rail column in layout so content starts at column 2. */}
      <box width={1} flexShrink={0} />
      <box flexDirection="column" flexGrow={1}>
        {props.children}
      </box>
      {/* The thin line itself — stretched to the block height, clipped. */}
      <box position="absolute" left={0} top={0} bottom={0} width={1} overflow="hidden">
        <text fg={props.color} wrapMode="none">{RAIL_GLYPHS}</text>
      </box>
    </box>
  );
}

/**
 * A single line built from coloured text runs, rendered as a row of adjacent
 * `<text>` segments (OpenTUI has no inline-markup `<text>`, so a styled line is a
 * row of plain ones). `center` wraps the line in flex spacers so it sits centered
 * on its own row (used by the splash + footer so each line is individually
 * centered); without it the row is left-aligned for callers that center a whole
 * stack themselves.
 */
function SegRow(props: { segs: Seg[]; center?: boolean; marginTop?: number }) {
  return (
    <box flexDirection="row" flexShrink={0} marginTop={props.marginTop ?? 0}>
      <Show when={props.center}>
        <box flexGrow={1} />
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <For each={props.segs}>{(s) => <text fg={s.fg}>{s.t}</text>}</For>
      </box>
      <Show when={props.center}>
        <box flexGrow={1} />
      </Show>
    </box>
  );
}

/**
 * One wordmark row as a left→right single-hue brand fade: a flex ROW of one
 * `<text>` per character, each colored by its COLUMN position (`cols` = the full
 * block width, so every row shares the same ramp position per column → one clean
 * light→deep sweep, not per-letter confetti). `hue` is the live accent so the
 * sweep follows `/accent`. This is the same per-`<text fg>` mechanism `SegRow`
 * uses — OpenTUI applies `fg` reliably on a `<text>`, whereas inline `<span fg>`
 * children do not paint. Static (rendered once on the idle splash), so the
 * per-character node count is fine. Empty rows render a single space to keep
 * their height.
 */
function BrandLine(props: { line: string; cols: number; hue: string }) {
  const cells = () => brandSpans(props.line || " ", props.cols, props.hue);
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={cells()}>
        {(c) => (
          <text flexShrink={0} fg={c.fg}>
            {c.ch}
          </text>
        )}
      </For>
    </box>
  );
}

/**
 * Assistant / plan / subagent markdown. Splits the text into prose / code / table
 * blocks (markdown-blocks.ts) and renders each with the RIGHT primitive: prose via
 * OpenTUI's native <markdown> (proper wrapping + inline bold/italic/code conceal),
 * code and tables via our own <box>/<text>. This is deliberate: OpenTUI's
 * <markdown> blanks a prose block whenever a code/table block is a sibling (even
 * across separate <markdown> instances), which silently ate the prose in every
 * code-containing reply — so code/tables get native primitives instead, which also
 * lets us style them cleanly. Falls back to plain <text> with no SyntaxStyle.
 */
function AssistantText(props: {
  text: string;
  streaming: boolean;
  style: SyntaxStyle | undefined;
  fg: string;
  palette: Palette;
  /** Width budget for table fitting; defaults to a sane value for narrow contexts. */
  width?: number;
  /** Left indent for prose/heading/quote blocks; code + tables stay flush at 0 so
   * they align with the full-width input frame. Default 0. */
  indent?: number;
}) {
  const split = createMarkdownSplitter();
  const blocks = () => split(props.text);
  const indent = () => props.indent ?? 0;
  // One left edge for all assistant content. `code` and `quote` carry their OWN
  // left marker (the `│` border / the `▎` bar), so they sit flush at the block
  // edge and their marker lines up with the tool-step + user gutters; their text
  // then falls one column in — matching prose. `prose`/`heading`/`table` have no
  // marker, so they're indented to that same content column. (Previously tables
  // rendered flush-left, 2 cols left of the prose, and quotes 2 cols right — a
  // visible zig-zag; this aligns every block on one edge.)
  const pad = (kind: MdBlock["kind"]) => (kind === "code" || kind === "quote" ? 0 : indent());
  return (
    <Show
      when={props.style}
      fallback={
        <For each={props.text.split("\n")}>{(l) => <text fg={props.fg}>{l || " "}</text>}</For>
      }
    >
      <box flexDirection="column">
        <Index each={blocks()}>
          {(block, i) => (
            // One blank row between blocks (none above the first) for even rhythm.
            // Prose/heading/quote indent; code + tables stay flush-left (full width).
            <box flexDirection="column" marginTop={i > 0 ? 1 : 0} paddingLeft={pad(block().kind)}>
              <Switch>
                <Match when={block().kind === "heading"}>
                  <HeadingBlock block={block as () => Extract<MdBlock, { kind: "heading" }>} palette={props.palette} />
                </Match>
                <Match when={block().kind === "quote"}>
                  <QuoteBlock block={block as () => Extract<MdBlock, { kind: "quote" }>} palette={props.palette} />
                </Match>
                <Match when={block().kind === "code"}>
                  {/* A fenced block tagged with a data-view language (chart / line /
                      pie / weather / sources) renders as a rich view; anything else
                      is an ordinary syntax-highlighted code block. */}
                  <RichOrCode
                    block={block as () => Extract<MdBlock, { kind: "code" }>}
                    palette={props.palette}
                    width={(props.width ?? 80) - indent()}
                  />
                </Match>
                <Match when={block().kind === "table"}>
                  <TableBlock
                    block={block as () => Extract<MdBlock, { kind: "table" }>}
                    palette={props.palette}
                    // The table is indented like prose (pad above), so shrink its
                    // fit-width by that indent to keep the right edge in the column.
                    width={(props.width ?? 80) - indent()}
                  />
                </Match>
                <Match when={block().kind === "prose"}>
                  {/* Prose ONLY — never code/tables — so the <markdown> sibling bug
                      can't trigger. Inline bold/italic/code still conceal here. */}
                  <markdown
                    content={(block() as Extract<MdBlock, { kind: "prose" }>).text}
                    streaming={false}
                    syntaxStyle={props.style!}
                    fg={props.fg}
                  />
                </Match>
              </Switch>
            </box>
          )}
        </Index>
      </box>
    </Show>
  );
}

/** A markdown heading — bold accent text, no underline rule. Any rule (a filled
 * band OR a `─` run) reads as stray chrome at terminal scale; the accent color +
 * bold + surrounding blank rows carry the document structure on their own. */
function HeadingBlock(props: { block: () => Extract<MdBlock, { kind: "heading" }>; palette: Palette }) {
  const p = props.palette;
  return (
    <text fg={p.heading} attributes={TextAttributes.BOLD} wrapMode="word">
      {props.block().text}
    </text>
  );
}

/** A blockquote — a solid left accent bar (a bg-filled column, same rail language
 * as the blocks) with muted, italic quoted text hanging beside it. */
function QuoteBlock(props: { block: () => Extract<MdBlock, { kind: "quote" }>; palette: Palette }) {
  const p = props.palette;
  return (
    <Rail color={p.gutter}>
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <For each={props.block().lines}>
          {(l) => (
            <text flexGrow={1} wrapMode="word" fg={p.muted} attributes={TextAttributes.ITALIC}>
              {l || " "}
            </text>
          )}
        </For>
      </box>
    </Rail>
  );
}

/** A fenced code block — an inset ELEVATED surface (a shade above the message panel
 * so it reads as a distinct code block) with monospace code in its own hue. No left
 * bar; the fill + code color set it apart. The language is a quiet muted tag. Every
 * line is clamped (ellipsis) to `width`: an unclamped wrapMode="none" line widens
 * the elevated box past the chat column and paints stray filled strips into the
 * side gutter (the "weird elements" overflow). Code intentionally clips rather
 * than wraps — wrapped code reads as broken indentation. */
function CodeBlock(props: {
  block: () => Extract<MdBlock, { kind: "code" }>;
  palette: Palette;
  /** Inner width budget (terminal cells); lines clamp to it minus the padding. */
  width?: number;
}) {
  const p = props.palette;
  const lines = () => {
    const l = props.block().lines;
    return l.length ? l : [""];
  };
  const w = () => Math.max(12, (props.width ?? 96) - 2);
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={p.elevated} paddingLeft={1} paddingRight={1}>
      <Show when={props.block().lang}>
        <text fg={p.muted}>{props.block().lang}</text>
      </Show>
      <For each={lines()}>{(l) => <text fg={p.code} wrapMode="none">{truncateWidth(l, w()) || " "}</text>}</For>
    </box>
  );
}

/** A GFM table as a proper GRID (opencode-style): `┌┬┐`/`├┼┤`/`└┴┘` box rules with
 * `│` column borders drawn in the border tone, header cells in the accent (bold),
 * data cells in the body tone. The rules render as one border-tone `<text>`; each
 * data line draws its outer + inner `│` borders around cells. Cells come pre-padded
 * + width-fitted (with `<br>` in-cell breaks) from renderTable. */
function TableBlock(props: {
  block: () => Extract<MdBlock, { kind: "table" }>;
  palette: Palette;
  width: number;
}) {
  const p = props.palette;
  const cols = () => Math.max(1, ...props.block().rows.map((r) => r.length));
  // A grid whose columns can't physically fit (many columns × the 3-cell
  // minimum) would clip mid-grid; render each row as a `header: value` record
  // stanza instead — narrower terminals get a readable list, not a broken box.
  const fits = () => tableFits(cols(), Math.max(12, props.width));
  const records = () => {
    const [header, ...data] = props.block().rows;
    const rows = data.length ? data : [header ?? []];
    return rows.map((r) =>
      r.map((cell, c) => ({
        label: data.length ? (header?.[c] ?? "") : "",
        value: cell,
      })),
    );
  };
  const lines = () => renderTable(props.block().rows, props.block().align, Math.max(12, props.width));
  // A header/row → alternating border + ` cell ` parts: │ c0 │ c1 │ … so the `│`
  // and the rule junctions line up (each ` cell ` is the column width + 2 pad).
  const parts = (cells: string[]): { text: string; sep: boolean }[] => {
    const out: { text: string; sep: boolean }[] = [{ text: "│", sep: true }];
    for (const c of cells) {
      out.push({ text: ` ${c} `, sep: false });
      out.push({ text: "│", sep: true });
    }
    return out;
  };
  return (
    <Show
      when={fits()}
      fallback={
        <box flexDirection="column" flexShrink={0}>
          <For each={records()}>
            {(rec, ri) => (
              <box flexDirection="column" flexShrink={0} marginTop={ri() > 0 ? 1 : 0}>
                <For each={rec}>
                  {(f) => (
                    <box flexDirection="row" flexShrink={0}>
                      <Show when={f.label}>
                        <text flexShrink={0} fg={p.muted}>{`${f.label}: `}</text>
                      </Show>
                      <text flexShrink={1} wrapMode="word" fg={p.assistant}>{f.value || " "}</text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      }
    >
      <box flexDirection="column" flexShrink={0}>
        <For each={lines()}>
          {(line) =>
            line.role === "rule" ? (
              <text flexShrink={0} fg={p.border} wrapMode="none">{line.text}</text>
            ) : (
              <box flexDirection="row" flexShrink={0}>
                <For each={parts(line.cells)}>
                  {(part) => (
                    <text
                      flexShrink={0}
                      fg={part.sep ? p.border : line.role === "header" ? p.heading : p.assistant}
                      attributes={!part.sep && line.role === "header" ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {part.text}
                    </text>
                  )}
                </For>
              </box>
            )
          }
        </For>
      </box>
    </Show>
  );
}

// ── Rich data views (charts / graphs / weather / sources) ─────────────────────

/** Route a fenced code block to its rich view (bar/line/pie/weather/sources) by
 * language tag, or fall back to a syntax-highlighted code block. */
function RichOrCode(props: { block: () => Extract<MdBlock, { kind: "code" }>; palette: Palette; width: number }) {
  const kind = () => richKind(props.block().lang);
  const body = () => props.block().lines.join("\n");
  const w = () => Math.max(12, props.width);
  return (
    <Switch fallback={<CodeBlock block={props.block} palette={props.palette} width={props.width} />}>
      <Match when={kind() === "bar"}>
        <BarChart body={body()} palette={props.palette} width={w()} />
      </Match>
      <Match when={kind() === "line" || kind() === "sparkline"}>
        <LineChart body={body()} palette={props.palette} width={w()} spark={kind() === "sparkline"} />
      </Match>
      <Match when={kind() === "pie"}>
        <PieChart body={body()} palette={props.palette} width={w()} />
      </Match>
      <Match when={kind() === "weather"}>
        <WeatherCard body={body()} palette={props.palette} width={w()} />
      </Match>
      <Match when={kind() === "sources"}>
        <SourceCards body={body()} palette={props.palette} width={w()} />
      </Match>
    </Switch>
  );
}

/** Run-length encode a pie grid row into `{slice, len}` runs so a stretch of
 * same-slice cells renders as one solid background span (fewer nodes, no seams). */
function pieRuns(row: number[]): { slice: number; len: number }[] {
  const out: { slice: number; len: number }[] = [];
  for (const s of row) {
    const last = out[out.length - 1];
    if (last && last.slice === s) last.len++;
    else out.push({ slice: s, len: 1 });
  }
  return out;
}

/** Right-pad `s` to `n` display cells (CJK/emoji-aware). */
function padRight(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - displayWidth(s)));
}
/** Left-pad `s` to `n` display cells. */
function padLeft(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - displayWidth(s))) + s;
}
// (Truncation to display cells is the shared `truncateWidth` in markdown-blocks.)

/** A horizontal bar chart: `label ▇▇▇▇  value`, each bar in a distinct series hue,
 * value labels right-aligned into a column. A quiet title sits above. A chart
 * with a SINGLE datum renders as a stat line (label + bold accent value) — one
 * bar always fills 100% of the track, so it carries no information. */
function BarChart(props: { body: string; palette: Palette; width: number }) {
  const p = props.palette;
  const model = () => parseChart(props.body);
  const rows = () => {
    const { data } = model();
    const max = Math.max(1, ...data.map((d) => d.value));
    // Row = label(+2) + bar/track + gap(2) + value + a cell of slack; the budget
    // clamps every column to the available width, so a narrow terminal shrinks
    // the track (and then the label/value) instead of clipping the value column.
    const { labelW, valueW, track } = barChartLayout(data, props.width);
    return data.map((d, i) => {
      const bar = barGlyphs(d.value / max, track);
      // Split the bar into its FULL cells (painted as a background fill — one
      // seamless band, no per-glyph hairlines) and the fractional eighth-block
      // tail (a fg glyph, which is the only place sub-cell precision needs one).
      const fullCells = /^█*/.exec(bar)![0].length;
      const tailGlyph = bar.slice(fullCells);
      const gap = " ".repeat(Math.max(0, track - displayWidth(bar)));
      return {
        label: padRight(truncateWidth(d.label, labelW), labelW),
        full: fullCells,
        tailGlyph,
        tail: `${gap}  ${padLeft(truncateWidth(d.display, valueW), valueW)}`,
        color: p.series[i % p.series.length]!,
      };
    });
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={model().title}>
        <text fg={p.heading} attributes={TextAttributes.BOLD}>{model().title}</text>
      </Show>
      <Show when={model().data.length === 0}>
        <CodeBlock block={() => ({ kind: "code", lang: "", lines: props.body.split("\n") })} palette={p} width={props.width} />
      </Show>
      <Show when={model().data.length === 1}>
        <box flexDirection="row" flexShrink={0}>
          <text flexShrink={0} fg={p.series[0]!}>{"▍ "}</text>
          <text flexShrink={0} fg={p.assistant} attributes={TextAttributes.BOLD}>{model().data[0]!.display}</text>
          <text flexShrink={0} fg={p.muted}>{`  ${model().data[0]!.label}`}</text>
        </box>
      </Show>
      <Show when={model().data.length > 1}>
        <For each={rows()}>
          {(r) => (
            <box flexDirection="row" flexShrink={0}>
              <text flexShrink={0} fg={p.muted}>{`${r.label}  `}</text>
              <Show when={r.full > 0}>
                <text flexShrink={0} bg={r.color}>{" ".repeat(r.full)}</text>
              </Show>
              <Show when={r.tailGlyph}>
                <text flexShrink={0} fg={r.color}>{r.tailGlyph}</text>
              </Show>
              <text flexShrink={0} fg={p.assistant}>{r.tail}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

/** A line chart: a single series as a braille plot with min/max y-axis labels, or
 * (for `sparkline`, or multiple series) one compact block sparkline per series with
 * its range — each in a distinct series hue. */
function LineChart(props: { body: string; palette: Palette; width: number; spark?: boolean }) {
  const p = props.palette;
  const model = () => parseSeries(props.body);
  const useBraille = () => !props.spark && model().series.length === 1 && model().series[0]!.points.length >= 2;
  const braille = () => {
    const pts = model().series[0]!.points;
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    // The axis column yields to the plot: cap it so plot + axis never exceed
    // the width (an extreme magnitude can push compactNum past 7 cells), then
    // the plot takes exactly what remains — no fixed floor that overflows.
    const axisW = Math.min(
      Math.max(displayWidth(compactNum(min)), displayWidth(compactNum(max))),
      Math.max(4, props.width - 5),
    );
    const h = 6;
    const w = Math.max(4, props.width - axisW - 1);
    const rows = brailleChart(pts, w, h);
    // Axis labels: the series max sits on the top row, the min on the bottom row.
    return {
      rows,
      axisW,
      top: truncateWidth(compactNum(max), axisW),
      bottom: truncateWidth(compactNum(min), axisW),
      color: p.series[0]!,
    };
  };
  const sparks = () => {
    // Budgeted columns: a long series RESAMPLES into the spark column instead of
    // painting one glyph per point (which overflowed the row and shoved the
    // range text off-screen); on a very narrow width the range drops first.
    const { labelW, sparkW, showRange } = sparkLayout(model().series, props.width);
    return model().series.map((s, i) => {
      return {
        label: s.label ? padRight(truncateWidth(s.label, labelW), labelW) : "",
        spark: sparkline(resamplePoints(s.points, sparkW)),
        range: showRange ? `  ${sparkRange(s.points)}` : "",
        color: p.series[i % p.series.length]!,
      };
    });
  };
  return (
    // No parseable numeric series → the fenced content must not VANISH; show it
    // as an ordinary code block (same fallback bar/pie use).
    <Show
      when={model().series.length > 0}
      fallback={<CodeBlock block={() => ({ kind: "code", lang: "", lines: props.body.split("\n") })} palette={p} width={props.width} />}
    >
      <box flexDirection="column" flexShrink={0}>
        <Show when={model().title}>
          <text fg={p.heading} attributes={TextAttributes.BOLD}>{model().title}</text>
        </Show>
        <Show
          when={useBraille()}
          fallback={
            <For each={sparks()}>
              {(s) => (
                <box flexDirection="row" flexShrink={0}>
                  <Show when={s.label}>
                    <text flexShrink={0} fg={p.muted}>{`${s.label}  `}</text>
                  </Show>
                  <text flexShrink={0} fg={s.color}>{s.spark}</text>
                  <text flexShrink={0} fg={p.muted}>{s.range}</text>
                </box>
              )}
            </For>
          }
        >
          <For each={braille().rows}>
            {(row, i) => (
              <box flexDirection="row" flexShrink={0}>
                <text flexShrink={0} fg={p.muted}>
                  {`${padLeft(i() === 0 ? braille().top : i() === braille().rows.length - 1 ? braille().bottom : "", braille().axisW)} `}
                </text>
                <text flexShrink={0} fg={braille().color}>{row}</text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  );
}

/** A pie/donut chart: a circular disc of colored half-blocks beside a legend of
 * `■ label  pct%` rows. Slices start at 12 o'clock, sized by share of the total. */
function PieChart(props: { body: string; palette: Palette; width: number }) {
  const p = props.palette;
  const model = () => parseChart(props.body);
  const view = () => {
    const { data } = model();
    const values = data.map((d) => d.value);
    const pct = sharePercents(values);
    // Budgeted columns: the legend label shrinks before the disc, and when the
    // width can't seat a legible disc at all (cols = 0) the legend stands alone
    // — the old fixed 10-col disc floor pushed the legend off a narrow terminal.
    const { labelW, cols, rows: pieRows } = pieLayout(data.map((d) => d.label), props.width);
    // A SOLID disc (not a donut) — at terminal cell sizes a filled circle reads
    // unmistakably as a pie, where a hole fragments into scattered arcs.
    const grid = cols > 0 ? pieGrid(values, cols, pieRows) : [];
    return {
      grid,
      legend: data.map((d, i) => ({
        label: padRight(truncateWidth(d.label, labelW), labelW),
        pct: pct[i]!,
        color: p.series[i % p.series.length]!,
      })),
    };
  };
  return (
    // Data must exist AND have a positive total — an all-zero/negative "pie"
    // would draw an invisible disc beside an all-0% legend; show the raw text.
    <Show
      when={model().data.some((d) => d.value > 0)}
      fallback={<CodeBlock block={() => ({ kind: "code", lang: "", lines: props.body.split("\n") })} palette={p} width={props.width} />}
    >
      <box flexDirection="row" flexShrink={0}>
        {/* The circular grid, painted as background-colored cells (run-length
            encoded per row). A bg-filled space fills the whole cell rect — solid
            edge-to-edge regardless of the block-glyph's font metrics, where a run
            of `█` foreground glyphs can seam at a color boundary. Full-cell steps
            keep the rim coherent (half-cell smoothing reads as torn edges here). */}
        <box flexDirection="column" flexShrink={0}>
          <For each={view().grid}>
            {(gridRow) => (
              <box flexDirection="row" flexShrink={0}>
                <For each={pieRuns(gridRow)}>
                  {(run) => (
                    <text flexShrink={0} bg={run.slice >= 0 ? view().legend[run.slice]?.color ?? p.muted : undefined}>
                      {" ".repeat(run.len)}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
        {/* Legend: swatch · label (padded so the percentages align) · share.
            The gap belongs to the disc — legend-only mode sits flush left. */}
        <box flexDirection="column" flexShrink={0} paddingLeft={view().grid.length > 0 ? 2 : 0}>
          <For each={view().legend}>
            {(l) => (
              <box flexDirection="row" flexShrink={0}>
                <text flexShrink={0} fg={l.color}>{"■ "}</text>
                <text flexShrink={0} fg={p.assistant}>{`${l.label}  `}</text>
                <text flexShrink={0} fg={p.muted}>{`${l.pct}%`}</text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Show>
  );
}

/** A weather card: a bordered panel with the location, a big glyph + temperature +
 * condition, then a chip row (hi/lo, humidity, wind, …) and an optional forecast. */
function WeatherCard(props: { body: string; palette: Palette; width?: number }) {
  const p = props.palette;
  const w = () => parseWeather(props.body);
  // Nothing recognizable parsed → the block would render as a lone default ⛅
  // with all its content dropped; show the raw text as a code block instead.
  const hasContent = () =>
    Boolean(w().location || w().temp || w().condition || w().hi || w().lo) ||
    w().chips.length > 0 ||
    w().forecast.length > 0;
  return (
    <Show
      when={hasContent()}
      fallback={<CodeBlock block={() => ({ kind: "code", lang: "", lines: props.body.split("\n") })} palette={p} width={props.width} />}
    >
    <box flexDirection="column" flexShrink={0}>
      <Show when={w().location}>
        <text fg={p.heading} attributes={TextAttributes.BOLD}>{w().location}</text>
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <text flexShrink={0} fg={p.series[3] ?? p.notice}>{weatherIcon(w().condition)}</text>
        <Show when={w().temp}>
          <text flexShrink={0} fg={p.assistant} attributes={TextAttributes.BOLD}>{`  ${w().temp}`}</text>
        </Show>
        <Show when={w().condition}>
          <text flexShrink={0} fg={p.muted}>{`   ${w().condition}`}</text>
        </Show>
      </box>
      <Show when={w().hi || w().lo || w().chips.length > 0}>
        {/* A flat row of adjacent <text> runs — OpenTUI paints fg per <text>, so a
            two-tone chip (muted label + bright value) is two siblings, not nested. */}
        <box flexDirection="row" flexShrink={0}>
          <Show when={w().hi}>
            <text flexShrink={0} fg={p.add}>{`↑${w().hi}`}</text>
          </Show>
          <Show when={w().lo}>
            <text flexShrink={0} fg={p.del}>{`  ↓${w().lo}`}</text>
          </Show>
          <For each={w().chips}>
            {(c, i) => (
              <>
                <text flexShrink={0} fg={p.muted}>
                  {`${i() > 0 || w().hi || w().lo ? "  ·  " : ""}${c.label} `}
                </text>
                <text flexShrink={0} fg={p.assistant}>{c.value}</text>
              </>
            )}
          </For>
        </box>
      </Show>
      <Show when={w().forecast.length > 0}>
        {/* `gap` between day columns (no trailing padding on the last), so the row
            isn't wider than the rest and the filled card stays a clean rectangle. */}
        <box flexDirection="row" flexShrink={0} marginTop={1} gap={3}>
          <For each={w().forecast}>
            {(d) => (
              <box flexDirection="column" flexShrink={0}>
                <text flexShrink={0} fg={p.muted}>{d.day}</text>
                <text flexShrink={0} fg={p.series[3] ?? p.notice}>{weatherIcon(d.cond)}</text>
                <text flexShrink={0} fg={p.assistant}>{`${d.hi ?? ""}${d.lo ? `/${d.lo}` : ""}`}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
    </Show>
  );
}

/** Source / citation cards: a numbered list where each entry is a bold title, a
 * link-tone domain, and a muted wrapped snippet — the industry-standard "sources"
 * treatment for search/reference output. The title + domain are real OSC 8
 * HYPERLINKS (via the `link` prop), so Cmd/Ctrl-click opens the source in a browser
 * on any terminal that supports terminal hyperlinks. */
function SourceCards(props: { body: string; palette: Palette; width: number }) {
  return <SourceList sources={parseSources(props.body)} palette={props.palette} width={props.width} />;
}

/** The shared source-card list renderer (```sources``` blocks AND expanded
 * web-search tool output). Numbers stay quiet muted — one calm treatment, no
 * per-entry color rotation. */
function SourceList(props: { sources: SourceItem[]; palette: Palette; width: number }) {
  const p = props.palette;
  // A clickable href: use the URL as-is if it has a scheme, else assume https.
  const href = (s: { url?: string }): { url: string } | undefined =>
    s.url ? { url: /^[a-z]+:\/\//i.test(s.url) ? s.url : `https://${s.url}` } : undefined;
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.sources}>
        {(s, i) => (
          <box flexDirection="row" flexShrink={0} marginTop={i() > 0 ? 1 : 0}>
            <text flexShrink={0} fg={p.muted}>{`${i() + 1}  `}</text>
            <box flexDirection="column" flexGrow={1}>
              <text flexShrink={0} fg={p.heading} attributes={TextAttributes.BOLD} wrapMode="none" link={href(s)}>
                {truncateWidth(s.title, Math.max(8, props.width - 4))}
              </text>
              <Show when={s.domain}>
                <text flexShrink={0} fg={p.tool} attributes={TextAttributes.UNDERLINE} link={href(s)}>
                  {s.domain}
                </text>
              </Show>
              <Show when={s.snippet}>
                <text flexGrow={1} fg={p.muted} wrapMode="word">{s.snippet}</text>
              </Show>
            </box>
          </box>
        )}
      </For>
    </box>
  );
}

/**
 * A live status section (Tasks / Subagents / Queued): a bold accent TITLE row over
 * its rows, FLAT on the base background — no box, no fill. Filled chrome reads as
 * messy grey rectangles floating on black (especially where a terminal's line
 * spacing ragged-edges the fill); a titled, flat section stays uniform on any
 * terminal. Hierarchy comes from the accent title + spacing, not a container.
 */
function Panel(props: {
  title: string;
  titleColor: string;
  children: unknown;
}) {
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <text flexShrink={0} fg={props.titleColor} attributes={TextAttributes.BOLD}>{props.title}</text>
      {props.children}
    </box>
  );
}

/**
 * A tool call / file edit as one clean step hanging off the turn thread: a
 * clickable header (chevron · colored icon · human label · right-aligned meta) that
 * expands to the captured output or colored diff hunk. Condensed by default so the
 * transcript stays scannable; the right-aligned meta forms a tidy column down a run
 * of steps. No own border — the enclosing turn rail is the thread.
 */
function ToolBlockView(props: {
  block: () => Extract<Block, { kind: "tool" }>;
  palette: Palette;
  style: SyntaxStyle | undefined;
  /** This row follows another visible step row → stack flush (no top gap). */
  chained?: boolean;
  /** First item in the turn's output block → no top gap (the block padding spaces it). */
  first?: boolean;
  /** Inner content width (for the subagent-reply markdown). */
  width?: number;
  /** Live spinner frame (tick-driven) — shown as the chevron while the call runs. */
  spin?: () => string;
  onToggle: (id: number) => void;
}) {
  const b = props.block;
  const p = props.palette;
  const expandable = () => b().output.length > 0;
  // Split the stored label into its leading glyph + the summary so the icon can
  // carry the tool tone while the summary stays calm — `"→ read x"` → `→`, `read x`.
  const icon = () => {
    const sp = b().label.indexOf(" ");
    return sp > 0 ? b().label.slice(0, sp) : b().label;
  };
  const summary = () => {
    const sp = b().label.indexOf(" ");
    return sp > 0 ? b().label.slice(sp + 1) : "";
  };
  // The chevron column: a live spinner while the call RUNS (each step is visibly
  // alive, not just the bottom working line), then the expand state (`▸`/`▾`),
  // or `·` for a row with nothing to expand.
  const chevron = () =>
    !b().done && props.spin ? props.spin() : expandable() ? (b().collapsed ? "▸" : "▾") : "·";
  // Right-aligned meta: the collapsed hint (`5 results` / `12 lines` / `diff`),
  // prefixed with the call's duration when it was slow (≥2s) — a scannable
  // "what cost time" column down a run of steps.
  const duration = () => {
    // While a call RUNS, subscribe to the same tick()-driven spinner the chevron
    // uses so the live elapsed re-renders each frame; a finished row is static.
    // The label itself (finished wall-clock vs. live ticking elapsed, both gated
    // at ≥2s so no tool looks dead) is the pure `toolDurationLabel`.
    if (!b().done && b().startedAt !== undefined) props.spin?.();
    return toolDurationLabel(b(), Date.now());
  };
  const meta = () =>
    b().collapsed && expandable() ? [duration(), collapsedHint(b())].filter(Boolean).join(" · ") : duration();
  const visible = () => b().output.slice(0, MAX_OUTPUT_LINES);
  const overflow = () => Math.max(0, b().output.length - MAX_OUTPUT_LINES);
  // Live output preview while the call runs: the last couple of streamed lines,
  // muted, under the header — a long `bun test` scrolls line by line instead of
  // sitting dead until it exits. Replaced by the real output when it lands.
  const liveTail = () => {
    if (b().done) return [] as string[];
    const lines = (b().tail ?? "").split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-2);
  };
  return (
    <box
      id={`tool-${b().id}`}
      flexDirection="column"
      flexShrink={0}
      marginTop={props.first || props.chained ? 0 : 1}
      onMouseDown={() => {
        if (expandable()) props.onToggle(b().id);
      }}
    >
      {/* Header: chevron/spinner · icon · summary … right-aligned meta. */}
      <box flexDirection="row" flexShrink={0}>
        <text flexShrink={0} fg={!b().done ? p.tool : p.muted}>{`${chevron()} `}</text>
        <text flexShrink={0} fg={b().isError ? p.del : p.tool}>{icon()}</text>
        {/* The summary is PRE-truncated with an ellipsis to the width left after
            the meta column — flexShrink alone hard-clips it mid-word straight
            into the meta ("…comparison 202  2.1s · 5 results"), reading as broken. */}
        <text flexShrink={1} wrapMode="none" fg={b().isError ? p.del : p.muted}>
          {` ${truncate(
            summary(),
            Math.max(
              12,
              (props.width ?? 80) - 3 - displayWidth(icon()) - (meta() ? displayWidth(meta()) + 2 : 0),
            ),
          )}`}
        </text>
        <box flexGrow={1} />
        <Show when={meta()}>
          <text flexShrink={0} fg={b().isError ? p.del : p.gutter}>{`  ${meta()}`}</text>
        </Show>
      </box>
      <For each={liveTail()}>
        {(line) => (
          <text flexShrink={0} wrapMode="none" fg={p.muted}>
            {`    ${truncate(line, Math.max(20, (props.width ?? 80) - 6))}`}
          </text>
        )}
      </For>
      <Show when={!b().collapsed && expandable()}>
        <Switch
          fallback={
            <box flexDirection="column">
              {/* Every output line is clamped to the panel width: an unclamped
                  wrapMode="none" line (a minified bundle, a long log line) makes
                  the panel overflow the column and paint stray strips into the
                  side gutter — the "weird elements" bug. */}
              <For each={visible()}>
                {(line) =>
                  b().isDiff ? (
                    // Fg-only diff: green additions, red deletions, dim context — no
                    // background band (flat stays uniform on any terminal).
                    <text fg={diffColor(line, p)} wrapMode="none">
                      {`  ${truncate(diffPad(line), Math.max(20, (props.width ?? 80) - 2)) || " "}`}
                    </text>
                  ) : (
                    <text fg={p.muted} wrapMode="none">
                      {`  ${truncate(line, Math.max(20, (props.width ?? 80) - 2))}`}
                    </text>
                  )
                }
              </For>
              <Show when={overflow() > 0}>
                <text fg={p.muted}>{`  … ${overflow()} more line${overflow() === 1 ? "" : "s"}`}</text>
              </Show>
            </box>
          }
        >
          {/* Web-search output expands to the clean source-card treatment (title /
              domain / snippet), not a raw text dump. */}
          <Match when={b().isSources}>
            <box flexDirection="column" paddingLeft={2} paddingTop={1} paddingBottom={1}>
              <SourceList
                sources={parseSearchResults(b().output.join("\n"))}
                palette={p}
                width={(props.width ?? 80) - 2}
              />
            </box>
          </Match>
          {/* A subagent's reply is markdown prose — render headers/bold/lists/code
              (and tables where supported) instead of raw text. */}
          <Match when={b().isMarkdown}>
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              <AssistantText
                text={b().output.join("\n")}
                streaming={false}
                style={props.style}
                fg={p.assistant}
                palette={p}
                width={(props.width ?? 80) - 2}
              />
            </box>
          </Match>
        </Switch>
      </Show>
    </box>
  );
}

/**
 * A landed reasoning burst — one quiet step row (`✻ thought · 8s`) in the turn
 * thread, expandable to the full reasoning text in muted italic. The live
 * preview under the spinner shows thinking as it happens; this keeps it
 * reviewable afterwards instead of evaporating when the answer starts.
 */
function ThinkingBlockView(props: {
  block: () => Extract<Block, { kind: "thinking" }>;
  palette: Palette;
  chained?: boolean;
  first?: boolean;
  width?: number;
  onToggle: (id: number) => void;
}) {
  const b = props.block;
  const p = props.palette;
  const header = () => {
    const s = b().seconds ?? 0;
    return s >= 1 ? `thought · ${s}s` : "thought";
  };
  const lines = () => b().text.split("\n").slice(0, MAX_OUTPUT_LINES);
  const overflow = () => Math.max(0, b().text.split("\n").length - MAX_OUTPUT_LINES);
  return (
    <box
      id={`think-${b().id}`}
      flexDirection="column"
      flexShrink={0}
      marginTop={props.first || props.chained ? 0 : 1}
      onMouseDown={() => props.onToggle(b().id)}
    >
      <box flexDirection="row" flexShrink={0}>
        <text flexShrink={0} fg={p.muted}>{`${b().collapsed ? "▸" : "▾"} `}</text>
        <text flexShrink={0} fg={p.gutter}>{"✻"}</text>
        <text flexShrink={1} wrapMode="none" fg={p.muted} attributes={TextAttributes.ITALIC}>
          {` ${header()}`}
        </text>
        <box flexGrow={1} />
      </box>
      <Show when={!b().collapsed}>
        <box flexDirection="column" flexShrink={0}>
          <For each={lines()}>
            {(line) => (
              <text flexShrink={0} wrapMode="word" fg={p.muted} attributes={TextAttributes.ITALIC}>
                {`  ${line || " "}`}
              </text>
            )}
          </For>
          <Show when={overflow() > 0}>
            <text fg={p.muted}>{`  … ${overflow()} more line${overflow() === 1 ? "" : "s"}`}</text>
          </Show>
        </box>
      </Show>
    </box>
  );
}

/** Green additions / red deletions / dim context on an expanded diff. */
function diffColor(line: string, p: Palette): string {
  if (line.startsWith("+")) return p.add;
  if (line.startsWith("-")) return p.del;
  return p.muted;
}

/** Open the diff's sign column out to `± content`: one space after the +/-/context
 * marker, so code starts at the same column on every line. Raw unified diff glues
 * the sign to unindented content (`-console.log(…)`) while indented lines read
 * `-  return …` — mixed hunks look ragged without the normalization. Hunk headers
 * and file markers (@@ / +++ / ---) pass through untouched. */
function diffPad(line: string): string {
  if (/^(@@|\+\+\+|---)/.test(line)) return line;
  if (/^[+\- ]/.test(line)) return `${line[0]} ${line.slice(1)}`;
  return line;
}

/** The dim footer metrics: context fill, token usage/cost, and queue depth. */
function metricsLine(
  queued: number,
  usage: SessionUsage,
  ctx: { usedTokens: number; contextWindow: number } | null,
): string {
  const parts: string[] = [];
  const pct =
    ctx && ctx.contextWindow > 0
      ? Math.min(100, Math.round((ctx.usedTokens / ctx.contextWindow) * 100))
      : 0;
  // Only surface context fill once it's meaningful (≥1%); avoids "ctx 0%" noise.
  if (pct >= 1) parts.push(`ctx ${pct}%`);
  if (usage.totalTokens > 0) parts.push(formatUsage(usage));
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join("  ·  ");
}

/** A model's context window as a compact label: `1M` / `400k` / `128k`. */
function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/** Current working directory with $HOME collapsed to `~`. Tail-kept by display
 * cells (a CJK/emoji dir name measures its real columns; no mid-surrogate cut). */
function shortCwd(): string {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return tailWidth(path, 48);
}

export async function mountApp(engine: EngineClient): Promise<void> {
  // exitOnCtrlC off: the renderer's built-in handler exits WITHOUT running
  // engine.finalize() (no session digest, orphaned background jobs, unclosed
  // MCP). Ctrl+C is handled in App's useKeyboard instead, which routes through
  // the same finalize-then-exit path as /exit.
  render(() => <App engine={engine} />, { exitOnCtrlC: false });
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
