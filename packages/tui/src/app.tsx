/**
 * OpenTUI (Solid) interactive app — the primary, polished UI.
 *
 * This file is excluded from `tsc` typecheck (see tsconfig.json) because it
 * depends on `@opentui/core` / `@opentui/solid` / `solid-js`, which are
 * optional native peer deps. It is dynamically imported by `startTui`; if the
 * import fails, the readline REPL in `tui.ts` takes over. Because it can't be
 * typechecked, only use OpenTUI props/events confirmed to exist in the installed
 * version, and keep `packages/core/scripts/screenshot.ts` in lockstep with any
 * visible change here (that script mirrors this render for the README shots).
 *
 * Layout: a single, centered, capped-width chat column (ChatGPT-style, no
 * sidebar) on a black background. There is NO top header — a fresh screen shows a
 * centered VIBE CODR wordmark; once you start, the column is: the scrolling
 * transcript, the live status panels (working · plan · tasks · subagents ·
 * permission · command-menu), the input (whose top border doubles as the mode
 * break, e.g. `━━ ▶ EXECUTE ━━`), and a two-line status block UNDER the input
 * (cwd · git / model · changed · ctx · cost — plus hints + goal). The column is
 * centered by two flex-grow gutter boxes, so it fills a narrow terminal and gets
 * quiet side margins on a wide one. Assistant text renders through OpenTUI's
 * native <markdown> renderable (NOT a hand-rolled ANSI string — embedding raw
 * escape codes in a <text> made the renderer miscount widths and garble long
 * streamed replies). Tool and diff output is condensed to one line and expands on
 * click; tapping your own message folds the whole turn under it.
 */

import { SyntaxStyle, TextAttributes } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type {
  EngineClient,
  AgentInfo,
  GitInfo,
  JobInfo,
  ModelSummary,
  ProviderInfo,
  SessionUsage,
  Task,
  UIEvent,
} from "@vibe/shared";
import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { applyPalette, paletteState } from "./commands-catalog.ts";
import { renderTable, splitMarkdown, type MdBlock } from "./markdown-blocks.ts";
import { GLYPH } from "./glyphs.ts";
import { formatUsage, TASK_GLYPH } from "./headless.ts";
import { commandsForUiMode, deriveUiMode, modeColor, nextUiMode } from "./modes.ts";
import { brandSpans } from "./gradient.ts";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";
import { spinnerFrame, workingLabel } from "./spinner.ts";
import { getTheme, type Palette } from "./themes.ts";
import { PANEL } from "./layout.ts";
import { toolLabel } from "./tool-icons.ts";
import {
  initialTranscript,
  reduceTranscript,
  groupTurns,
  collapsedHint,
  firstLine,
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
 * (ChatGPT-style — a readable, bounded conversation measure). */
const CONTENT_MAX = 96;
/** Cap how many output lines an expanded tool/diff block renders. */
const MAX_OUTPUT_LINES = 160;
/** Max visible rows the input box grows to before it scrolls internally. */
const INPUT_MAX_ROWS = 10;
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
  // A turn is anchored by its user message; every block after it (until the next
  // user message) belongs to that turn. `turnKey` maps any block id → its turn's
  // user-message id, and `counts` is how many non-user blocks each turn has — so
  // tapping a user message can fold (and count) its whole exchange.
  const grouping = createMemo(() => groupTurns(blocks()));
  const turnItemCount = (userId: number) => grouping().counts.get(userId) ?? 0;
  // A non-user block is hidden when its turn (its user message) is folded.
  const isHidden = (blockId: number) => {
    const k = grouping().turnKey.get(blockId);
    return k !== undefined && collapsedTurns().has(k);
  };
  // Ctrl+O: fold every turn that has work, or unfold all if any is folded.
  const toggleAllTurns = () =>
    setCollapsedTurns((prev) =>
      prev.size > 0 ? new Set() : new Set(grouping().counts.keys()),
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
  const [plan, setPlan] = createSignal<string | null>(null);
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
  let turnStartedAt = 0;
  let model = snap.model;
  let mode = snap.mode;
  let approvals = snap.approvalMode;
  let goal = snap.goal;
  let usage: SessionUsage = snap.usage;
  let ctx: { usedTokens: number; contextWindow: number } | null = null;
  // A handle to the text input so we can restore focus after a mouse click — a
  // click on any renderable blurs the input, which would otherwise leave the
  // user unable to type until they click the field again.
  let inputEl: { focus: () => void } | undefined;
  // Defer past the renderer's own post-click focus handling (which would
  // otherwise blur the input right after our synchronous focus() call).
  const refocusInput = () => queueMicrotask(() => inputEl?.focus());
  // The transcript scrollbox, captured so expand/collapse can hold the clicked
  // row in place instead of letting sticky-scroll snap to the bottom.
  let scrollEl: { scrollTop: number; stickyScroll: boolean } | undefined;
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
  const [palette, setPalette] = createSignal<Palette>(getTheme(snap.theme));
  const [uiMode, setUiMode] = createSignal(deriveUiMode(mode, approvals));
  const [headModel, setHeadModel] = createSignal(model);
  // Live "ctx N% · tokens · $cost · N queued" — shown in the footer when relevant.
  const [metrics, setMetrics] = createSignal(metricsLine(0, usage, ctx));
  // The goal (★) shown in the header's second row; updated via /goal.
  const [goalInfo, setGoalInfo] = createSignal<string | null>(goal);
  const cwd = shortCwd();
  // The chrome accent: Blue 300 by default (the DEFAULT palette's primary),
  // overridable to any hue via `/accent <hex>`. Reserved for titles + markers —
  // panel titles, the `❯` user marker + gutter, the active task/step, the selected
  // menu row, and the caret — plus the wordmark sweep and the spinner. Box borders
  // stay neutral grey (`palette().border`).
  const [accentColor, setAccentColor] = createSignal(snap.accentColor || "");
  const brand = () => accentColor() || palette().primary;
  // The mode chip on the input's top border — the one mode-driven hue in the UI:
  // ASK (execute) blue · PLAN green · YOLO red.
  const accent = () => modeColor(uiMode());
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
  const contentWidth = () => Math.min(CONTENT_MAX, Math.max(1, dims().width - 2));

  // How many rows the input needs for the current draft: each explicit line
  // soft-wraps to ceil(width / inner-width) rows. Drives the input box height so
  // it grows with the text (capped at INPUT_MAX_ROWS, then it scrolls inside).
  // `inner` = column inner (contentWidth−2) minus the input's border+padding (4).
  // Once the draft wraps we add one row of headroom: the edit buffer keeps the
  // cursor's trailing position visible, so without it the first line scrolls off.
  const inputRows = () => {
    const inner = Math.max(8, contentWidth() - 6);
    const rows = draft()
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / inner)), 0);
    return Math.min(INPUT_MAX_ROWS, Math.max(1, rows >= 2 ? rows + 1 : rows));
  };

  const [selIdx, setSelIdx] = createSignal(0);

  // One normalized menu row — its `choose` carries the row's own action, so the
  // keyboard handler, click handler, and renderer share a single path regardless
  // of which kind of menu produced it.
  type MenuRow = { text: string; current?: boolean; choose: (run: boolean) => void };

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
          const ctx = mdl.contextWindow ? `  (${Math.round(mdl.contextWindow / 1000)}k)` : "";
          return {
            text: `${full}${ctx}`,
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
      return { open: rows.length > 0, loading: false, kind: "models" as const, isAgent, title, hint, rows };
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
            // The ✓/○ in the text conveys status; no ● (that marks a "current" pick).
            text: `${p.configured ? "✓" : "○"} ${p.id.padEnd(12)} ${status}`,
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
          text: `${a.name.padEnd(12)} ${(a.model ?? "inherits").padEnd(24)} ${a.mode}`,
          // Selecting an agent opens the model picker targeting it.
          choose: () => setDraft(`/model agent ${a.name} `),
        }));
      // A trailing affordance to scaffold a new agent.
      rows.push({ text: "＋ new agent…", choose: () => setDraft("/agents new ") });
      return { open: rows.length > 0, loading: false, kind: "agents" as const, title, hint, rows };
    }
    const st = paletteState(draft());
    if (!st.open) return { open: false, loading: false, kind: "command" as const, title: "", hint: "", rows: [] as MenuRow[] };
    if (st.mode === "command") {
      const nameW = Math.min(14, Math.max(...st.items.map((c) => c.name.length + 1)));
      const rows: MenuRow[] = st.items.map((c, idx) => {
        const hint = c.values ? ` (${c.values.join("|")})` : c.arg ? ` ${c.arg}` : "";
        return {
          text: `${`/${c.name}`.padEnd(nameW + 1)}  ${c.description}${hint}`,
          choose: (run: boolean) => {
            const res = applyPalette(st, idx);
            if (!res) return;
            setDraft(res.draft);
            if (run && res.done) runText(res.draft);
          },
        };
      });
      return { open: true, loading: false, kind: "command" as const, title: "commands", hint: "", rows };
    }
    const cur = currentValueFor(st.command.name);
    const rows: MenuRow[] = st.items.map((v) => ({
      text: `${st.command.name} → ${v}`,
      current: cur === v,
      choose: (run: boolean) => {
        const line = `/${st.command.name} ${v}`;
        setDraft(line);
        if (st.command.name === "reasoning") setReasoningSig(v === "off" ? undefined : v);
        if (run) runText(line);
      },
    }));
    return { open: true, loading: false, kind: "value" as const, title: `/${st.command.name}`, hint: "", rows };
  });

  // Pre-highlight the current value (if any), else the first row, whenever the
  // menu contents change (new query / picker target / freshly-loaded models).
  createEffect(() => {
    const m = menuModel();
    void `${m.title}:${m.rows.length}:${m.loading}:${modelTarget()}`;
    const cur = m.rows.findIndex((r) => r.current);
    setSelIdx(cur >= 0 ? cur : 0);
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

  // Apply the row at absolute index `i` (keyboard highlight or a click).
  const chooseAt = (i: number, run: boolean) => menuModel().rows[i]?.choose(run);

  // Windowed rows for rendering (≤8 visible, scrolled to keep the highlight in
  // view). Each view row carries its absolute index so a click selects + runs it.
  const WINDOW = 8;
  const menuView = () => {
    const m = menuModel();
    if (!m.open) return null;
    const rows = m.rows;
    const sel = Math.min(Math.max(0, selIdx()), Math.max(0, rows.length - 1));
    const start = Math.min(Math.max(0, sel - 4), Math.max(0, rows.length - WINDOW));
    const view = rows.slice(start, start + WINDOW).map((r, i) => ({
      active: start + i === sel,
      current: !!r.current,
      text: r.text,
      idx: start + i,
    }));
    const more = rows.length > WINDOW ? `+${rows.length - WINDOW} more · type to filter` : "";
    return { rows: view, title: m.title, hint: m.hint, more, loading: m.loading };
  };

  // ── Transcript state ────────────────────────────────────────────────────────
  // The pure reducer (reducer.ts) owns blocks/changedFiles + the streaming/tool
  // cursors; this file mirrors its output into Solid signals for rendering.
  let ts = initialTranscript();
  const commit = () => {
    setBlocks(ts.blocks);
    setChangedFiles(ts.changedFiles);
  };
  const resetTranscript = () => {
    ts = initialTranscript();
    commit();
  };

  // Streamed deltas are COALESCED: tokens accumulate in a buffer and flush on a
  // short timer (~25fps) instead of one reduce + <markdown> re-parse per token.
  // Re-parsing growing text on every token is O(n²) and was the source of the
  // streaming lag on long replies; flushing per frame keeps it smooth.
  let pendingDelta = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const STREAM_FLUSH_MS = 40;
  const landPending = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
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

  // Apply a transcript action: land any buffered stream text first (so the action
  // sees the up-to-date reply), reduce, then mirror the new state to the signals.
  const apply = (action: TranscriptAction) => {
    if (action.type !== "delta") landPending();
    ts = reduceTranscript(ts, action);
    commit();
  };

  // Finalize the streaming reply (land buffered text, flip `streaming` off).
  const finalizeAssistant = () => apply({ type: "finalize" });
  // Toggle a tool/diff block's collapsed state (the click-to-expand handler).
  const toggle = (id: number) => apply({ type: "toggle", id });

  // Refresh the header chrome + rail projections whenever live status changes.
  const refreshStatus = () => {
    setUiMode(deriveUiMode(mode, approvals));
    setHeadModel(model);
    setMetrics(metricsLine(queued(), usage, ctx));
    setGoalInfo(goal);
  };
  // Resolve the oldest pending permission and drop it from the queue.
  const answerPerm = (decision: "once" | "always" | "deny") => {
    const head = perms()[0];
    if (!head) return;
    props.engine.send({ type: "resolve-permission", id: head.id, decision });
    setPerms((p) => p.slice(1));
  };
  // Resolve a presented plan from the approval card, then dismiss it.
  const answerPlan = (decision: "accept" | "edit" | "keep-planning", edit?: string) => {
    props.engine.send({ type: "resolve-plan", decision, ...(edit ? { edit } : {}) });
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
    // Ctrl+O folds/unfolds every turn's tool work at once (just the prose left).
    if (key.ctrl && key.name === "o") {
      key.preventDefault?.();
      toggleAllTurns();
      return;
    }
    // Esc closes the /jobs sub-view first (before it interrupts a turn).
    if (key.name === "escape" && showJobs()) {
      key.preventDefault?.();
      setShowJobs(false);
      return;
    }
    const m = menuModel();
    // Permission shortcuts: while a request is pending and you're not mid-typing,
    // y/a/n answers it directly and Esc rejects it.
    if (perms().length > 0 && !m.open && !draft().trim()) {
      if (key.name === "y" || key.name === "a" || key.name === "n") {
        key.preventDefault?.();
        answerPerm(key.name === "y" ? "once" : key.name === "a" ? "always" : "deny");
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
      if (key.name === "escape") {
        key.preventDefault?.();
        answerPlan("keep-planning");
        return;
      }
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
        if (n) setSelIdx((i) => (i - 1 + n) % n);
        break;
      case "down":
        key.preventDefault?.();
        if (n) setSelIdx((i) => (i + 1) % n);
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
    // Animate the working spinner / elapsed clock, but only while a turn runs.
    const timer = setInterval(() => {
      if (working()) setTick((t) => t + 1);
    }, 90);
    onCleanup(() => {
      clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
    });

    void (async () => {
      // The reducer owns per-turn call maps; endTurn finalizes the reply and
      // drops them, then stops the spinner.
      const endTurn = () => {
        apply({ type: "clear-turn" });
        setWorking(false);
      };
      for await (const event of props.engine.events() as AsyncIterable<UIEvent>) {
        switch (event.type) {
          case "user-message":
            // Subagents are per-turn activity (tasks persist, they don't) — start
            // each turn with a clean SUBAGENTS section. The plan box is transient
            // too: a new turn means it was acted on or abandoned.
            setSubagents([]);
            setPlan(null);
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
            // Buffer the token and flush on the next frame — coalescing keeps long
            // streamed replies smooth.
            pendingDelta += event.delta;
            scheduleFlush();
            break;
          case "tool-call-started":
            if (event.subagentId) break; // subagent tools don't enter the transcript
            apply({
              type: "tool-start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            });
            break;
          case "tool-call-finished":
            if (event.subagentId) break;
            apply({
              type: "tool-finish",
              toolCallId: event.toolCallId,
              output: event.output,
              isError: event.isError,
            });
            break;
          case "file-changed":
            // The reducer folds the diff into the EXACT tool block that produced it
            // (by call id), so an edit reads as one row with the hunk beneath it, and
            // accumulates the per-file delta for the footer summary.
            apply({
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
          case "plan-presented":
            finalizeAssistant();
            setPlan(event.plan);
            break;
          case "subagent-started":
            setSubagents((prev) => [
              ...prev,
              { id: event.subagentId, prompt: event.prompt, status: "running" },
            ]);
            break;
          case "subagent-finished":
            setSubagents((prev) =>
              prev.map((s) =>
                s.id === event.subagentId
                  ? { ...s, status: "done", result: firstLine(event.result) }
                  : s,
              ),
            );
            break;
          case "mode-changed":
            mode = event.mode;
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
            apply({ type: "notice", text: event.message });
            break;
          case "engine-error":
            endTurn();
            apply({ type: "notice", text: `error: ${event.message}` });
            break;
          default:
            break;
        }
      }
    })();
  });

  const runText = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setDraft("");
    // A new turn: re-engage auto-follow so the streamed reply scrolls into view
    // (a prior expand/collapse may have disengaged it — see `anchoredToggle`).
    if (scrollEl) scrollEl.stickyScroll = true;
    if (text === "/exit" || text === "/quit") {
      props.engine.send({ type: "shutdown" });
      process.exit(0);
    }
    // `/jobs` toggles the background-jobs sub-view (running shell commands +
    // detected localhost servers). Handled locally — no engine round-trip.
    if (text === "/jobs") {
      setShowJobs((v) => !v);
      return;
    }
    // While permission prompts are pending, a typed reply answers the oldest.
    if (perms().length > 0) {
      answerPerm(parsePermissionDecision(text));
      return;
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
      resetTranscript();
      setPlan(null);
      setSubagents([]);
      setCollapsedTurns(new Set());
      setPerms([]);
      setPendingQ([]);
      setWorking(false);
    }
    // Route through the shared mapper so `/model <id>`, `/goal <text>`, etc.
    // keep their arguments (the same logic the REPL uses).
    props.engine.send(lineToCommand(text));
  };
  // OpenTUI's input passes the committed value on Enter; fall back to the
  // controlled draft. When the command menu is open the keyboard handler
  // intercepts Enter instead, so this runs only for prompts / typed commands.
  const submit = (value?: string) => runText(value ?? draft());

  // The status details sit UNDER the input now (ChatGPT-style), cleanly split:
  // left = cwd · git; right = model · changed-files · ctx/usage/cost.
  const gitSummary = () => {
    const g = git();
    if (!g) return "";
    let s = `⎇ ${g.branch}`;
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
  const detailsLeft = () => [cwd, gitSummary()].filter(Boolean).join("  ·  ");
  const detailsRight = () =>
    [headModel(), changedSummary(), metrics()].filter(Boolean).join("  ·  ");
  // One centered status line under the input: location · git · model · changed ·
  // ctx · cost (· goal). Centered (not edge-justified) so the model never floats
  // off alone on the far right with a void beside it — uniform with the hints
  // line below and the centered splash above.
  const detailsCenter = () =>
    [detailsLeft(), detailsRight(), goalInfo() ? `★ ${truncate(goalInfo() ?? "", 40)}` : ""]
      .filter(Boolean)
      .join("  ·  ");
  const runningJobs = () => jobs().filter((j) => j.status === "running").length;
  // Key hints as coloured runs: the actionable tokens (keys, `/`, `click`) pop in
  // the bright foreground; their descriptors and separators stay muted. `/jobs`
  // is advertised only while background jobs are actually running.
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

  return (
    <box
      flexDirection="row"
      backgroundColor={palette().background}
      style={{ height: "100%" }}
      onMouseDown={refocusInput}
    >
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
                    {/* ░██ block wordmark with a clean left→right single-hue blue
                        sweep: each row is a line of per-character <text>s colored by
                        COLUMN position, so column i shares a ramp position across
                        every row and the whole block reads as one smooth light→deep
                        blue fade, not per-letter confetti. Follows `/accent`. Static
                        (rendered once on the idle splash) — no idle timer. */}
                    <For each={WORDMARK}>
                      {(line) => <BrandLine line={line} cols={WORDMARK_COLS} hue={brand()} />}
                    </For>
                  </Show>
                </box>
                <box flexGrow={1} />
              </box>
              {/* A single, centered prompt-starter line — no tagline, no key
                  cheatsheet (those live in the under-input status). Just three
                  example asks to get going. */}
              <box flexDirection="column" marginTop={1}>
                <SegRow
                  center
                  segs={[
                    { t: "Try ", fg: palette().muted },
                    { t: "› ", fg: brand() },
                    { t: "explain this codebase", fg: palette().assistant },
                    { t: "  ·  ", fg: palette().muted },
                    { t: "fix the failing test", fg: palette().assistant },
                    { t: "  ·  ", fg: palette().muted },
                    { t: "add a --json flag", fg: palette().assistant },
                  ]}
                />
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
          contentOptions={{ flexDirection: "column" }}
          scrollbarOptions={{ visible: false }}
        >
          {/* <Index> keys by position (stable, append-only). A block's `kind`
              is immutable for its lifetime — the file-changed fold mutates a
              tool block in place (tool→tool) but never changes kind — so the
              per-kind <Show> branches below never need to swap a row's element. */}
          <Index each={blocks()}>
            {(block, index) => {
              // A tool row "chains" to the one above it when that row is also a
              // visible tool — consecutive steps (search → fetch → fetch) then
              // stack flush instead of each floating in its own gap.
              const chained = () => {
                if (index <= 0) return false;
                const cur = block();
                if (cur.kind !== "tool" || isHidden(cur.id)) return false;
                const prev = blocks()[index - 1];
                return prev?.kind === "tool" && !isHidden(prev.id);
              };
              return (
              <Show
                when={block().kind !== "user"}
                fallback={
                  // Your turn: the SAME raised frame as the input bar. TAP it to
                  // fold the whole exchange under it (reply + tool work), leaving
                  // just your message + an expand affordance. Tap again to reopen.
                  <box
                    flexDirection="column"
                    marginTop={1}
                    onMouseDown={() => {
                      const id = (block() as { id: number }).id;
                      if (turnItemCount(id) > 0) anchoredToggle(() => toggleTurn(id));
                    }}
                  >
                    <box
                      border={["left"]}
                      borderStyle="heavy"
                      borderColor={brand()}
                      backgroundColor={palette().elevated}
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      paddingTop={1}
                      paddingBottom={1}
                    >
                      <text flexShrink={0} fg={brand()} attributes={TextAttributes.BOLD}>
                        {"❯ "}
                      </text>
                      <text flexGrow={1} wrapMode="word" fg={palette().assistant} attributes={TextAttributes.BOLD}>
                        {block().text}
                      </text>
                    </box>
                    <Show
                      when={
                        turnItemCount((block() as { id: number }).id) > 0 &&
                        collapsedTurns().has((block() as { id: number }).id)
                      }
                    >
                      <text fg={palette().muted} paddingLeft={1}>
                        {`▸ ${turnItemCount((block() as { id: number }).id)} item${turnItemCount((block() as { id: number }).id) === 1 ? "" : "s"} hidden · tap to expand`}
                      </text>
                    </Show>
                  </box>
                }
              >
                {/* assistant / tool / notice — all hidden when their turn (the
                    user message above) is folded. Folding is driven from the user
                    message, so these are not themselves click targets. */}
                <Show when={block().kind === "assistant" && !isHidden((block() as { id: number }).id)}>
                  <box
                    id={`msg-${(block() as { id: number }).id}`}
                    flexDirection="column"
                    marginTop={(block() as { gap: boolean }).gap ? 1 : 0}
                  >
                    {/* `indent={2}` aligns prose/headings/quotes with the user-message
                        and tool-step content (border(1)+pad(1)); code blocks and
                        tables render flush at x=0 so they share the input frame's full
                        width (both left AND right edges align, not just the right). */}
                    <AssistantText
                      text={(block() as { text: string }).text}
                      streaming={(block() as { streaming: boolean }).streaming}
                      style={mdStyle}
                      fg={palette().assistant}
                      palette={palette()}
                      width={contentWidth() - 2}
                      indent={2}
                    />
                  </box>
                </Show>
                <Show when={block().kind === "tool" && !isHidden((block() as { id: number }).id)}>
                  <ToolBlockView
                    block={block as () => Extract<Block, { kind: "tool" }>}
                    palette={palette()}
                    style={mdStyle}
                    chained={chained()}
                    hue={palette().gutter}
                    onToggle={(id) => anchoredToggle(() => toggle(id))}
                  />
                </Show>
                <Show when={block().kind === "notice" && !isHidden((block() as { id: number }).id)}>
                  <text fg={palette().notice} marginTop={1} paddingLeft={2}>
                    {(block() as { text: string }).text}
                  </text>
                </Show>
              </Show>
              );
            }}
          </Index>
        </scrollbox>
        </Show>
        </Show>
      </box>

      {/* Live working indicator — the braille spinner glyph animates via `tick`
          (which only advances while a turn runs) in the flat brand accent; the
          elapsed/interrupt label stays muted for readability. Hidden while a
          permission card is up (the card is the active affordance then). */}
      <Show when={working() && perms().length === 0}>
        <box flexDirection="row" flexShrink={0} marginTop={1}>
          <text fg={brand()}>
            {spinnerFrame(tick())}
          </text>
          <text fg={palette().muted}>
            {` ${workingLabel(Date.now() - turnStartedAt)}  ·  esc to interrupt`}
          </text>
        </box>
      </Show>
      <Show when={plan()}>
        <box {...PANEL} borderColor={palette().border} title="Plan" titleColor={brand()}>
          <AssistantText
            text={plan() ?? ""}
            streaming={false}
            style={mdStyle}
            fg={palette().assistant}
            palette={palette()}
            width={contentWidth() - 4}
          />
          <text fg={palette().muted}>
            {`${GLYPH.check} Enter to accept & execute  ·  type changes to revise  ·  Esc to keep planning`}
          </text>
        </box>
      </Show>
      {/* Tasks — the live to-do list, just above the input; hides once everything
          is done so a finished list doesn't linger. */}
      <Show when={tasks().length > 0 && tasks().some((t) => t.status !== "completed")}>
        <box
          {...PANEL}
          borderColor={palette().border}
          title={`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
          titleColor={brand()}
        >
          <For each={tasks()}>
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
        </box>
      </Show>
      {/* Subagents — live fan-out. ONE truncated line each by default (so a big
          fan-out stays tidy and never fills the screen); tap a row to expand its
          full prompt + result (bounded), tap again to collapse. Cleared per turn. */}
      <Show when={subagents().length > 0}>
        <box
          {...PANEL}
          borderColor={palette().border}
          title={`Subagents · ${subagents().length}`}
          titleColor={brand()}
        >
          <For each={subagents()}>
            {(s) => {
              const open = () => expandedSubs().has(s.id);
              // Calm single tone (no rainbow rotation): a running agent's glyph is
              // the brand accent (alive), a finished one recedes to the muted gutter
              // tone. The prompt text reads in the body color while running and
              // dims to muted once done so finished rows recede.
              const glyphFg = () => (s.status === "running" ? brand() : palette().gutter);
              const fg = () => (s.status === "running" ? palette().assistant : palette().muted);
              const oneLine = () =>
                truncate(firstLine(s.prompt) ?? s.prompt, Math.max(24, contentWidth() - 14));
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
                  </box>
                  <Show when={open() && s.result}>
                    <text fg={palette().muted} wrapMode="word">
                      {`    ${GLYPH.result} ${truncate(s.result ?? "", 300)}`}
                    </text>
                  </Show>
                </box>
              );
            }}
          </For>
        </box>
      </Show>
      {/* Queue — prompts you typed ahead while a turn runs. They auto-run in
          order; each row offers `steer` (jump it to the front + interrupt the
          current turn so it runs NOW) and `✕` (drop it). */}
      <Show when={pendingQ().length > 0}>
        <box
          {...PANEL}
          borderColor={palette().border}
          title={`Queued · ${pendingQ().length}`}
          titleColor={brand()}
        >
          <For each={pendingQ()}>
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
          <text fg={palette().muted} marginTop={1}>
            {"steer = run next & interrupt now  ·  ✕ = remove  ·  otherwise they run in order"}
          </text>
        </box>
      </Show>
      {/* Permission card — a bordered warning with the tool action and y/a/n. */}
      <Show when={perms()[0]}>
        {(p) => (
          <box
            border={["left"]}
            borderStyle="heavy"
            borderColor={palette().notice}
            backgroundColor={palette().panel}
            flexDirection="column"
            flexShrink={0}
            marginTop={1}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={palette().notice} attributes={TextAttributes.BOLD}>
              {`${GLYPH.warn} permission required · ${p().toolName}`}
            </text>
            <text fg={palette().assistant}>{`  ${toolLabel(p().toolName, p().input)}`}</text>
            <text fg={palette().muted}>{"  [y]es once  ·  [a]lways  ·  [n]o"}</text>
            <Show when={perms().length > 1}>
              <text fg={palette().muted}>{`  +${perms().length - 1} more pending`}</text>
            </Show>
          </box>
        )}
      </Show>
      {/* Slash-command menu / interactive submenus — opens while typing a
          `/command`. ↑/↓ (or hover) to highlight, Tab to complete, Enter (or
          click a row) to run, Esc to dismiss. Drilling into `/model` opens a live,
          searchable model picker; enum commands (theme/approvals/reasoning) show
          their values with the current one marked `●`. */}
      <Show when={menuModel().open}>
        <box
          // Docks IN-FLOW directly above the input as one connected control: the
          // same full width, the same neutral-grey border, and a blue title — with
          // NO bottom border, so the input's own top border (carrying the mode
          // chip) is the shared divider and the two read as a single framed field
          // that grows upward as you type `/`. The input drops its top margin while
          // this is open (below) so they sit flush. Opening it shrinks the
          // scrollable transcript above rather than covering it.
          border={["top", "left", "right"]}
          borderColor={palette().border}
          // Padded to match the input's ` ASK ` chip so the docked pair share one
          // title style (`┌─ commands ─` rather than a flush `┌─commands─`).
          title={menuView()?.title ? ` ${menuView()?.title} ` : undefined}
          titleColor={brand()}
          backgroundColor={palette().panel}
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          {/* Context header (e.g. which agent the model picker is configuring). */}
          <Show when={menuView()?.hint}>
            <text fg={palette().heading}>{`  ${menuView()?.hint}`}</text>
          </Show>
          <Show when={menuView()?.loading}>
            <text fg={palette().muted}>{"  Loading…"}</text>
          </Show>
          <For each={menuView()?.rows ?? []}>
            {/* Hover highlights, click selects + runs (index-based, so a click works
                on any row regardless of the highlight). Keyboard nav is global via
                useKeyboard — terminal text rows have no DOM focus, so the hover needs
                no paired onFocus despite the browser-oriented a11y lint. */}
            {(row) => (
              // biome-ignore lint/a11y/useKeyWithMouseEvents: terminal UI — no text-row focus; keyboard nav is global (useKeyboard)
              <text
                fg={row.active ? brand() : palette().muted}
                bg={row.active ? palette().selBg : undefined}
                attributes={row.active ? TextAttributes.BOLD : undefined}
                onMouseOver={() => setSelIdx(row.idx)}
                onMouseDown={() => {
                  chooseAt(row.idx, true);
                  refocusInput();
                }}
              >
                {`${row.active ? "❯" : " "} ${row.current ? "●" : " "} ${row.text}`}
              </text>
            )}
          </For>
          <Show when={menuView()?.more}>
            <text fg={palette().muted}>{`     ${menuView()?.more}`}</text>
          </Show>
        </box>
      </Show>
      {/* Text input — a clean neutral-grey frame with the text inside, on the black
          backdrop (NO fill): the box sets no background and the input is
          transparent, so there's no grey surface at all. Color here is on the
          markers only — the mode CHIP on the top edge (the `ASK`/`PLAN`/`YOLO` word
          in the mode hue: ASK blue · PLAN green · YOLO red) and the blue caret. */}
      <box
        border
        borderColor={palette().border}
        title={` ${modeWord()} `}
        titleColor={accent()}
        // COLUMN, not row: in a row the input only grows horizontally and shows a
        // single (cursor) line; in a column it grows vertically so every wrapped
        // line stays visible as the frame gets taller.
        flexDirection="column"
        flexShrink={0}
        // Flush against the docked menu when it's open (they share the top border
        // as a divider); a 1-row breathing gap otherwise.
        marginTop={menuModel().open ? 0 : 1}
        paddingLeft={1}
        paddingRight={1}
        // Grow with the text: the input soft-wraps (wrapMode below) and the frame
        // gets taller as it fills, up to INPUT_MAX_ROWS, then scrolls internally —
        // instead of the old single line that scrolled long text off to the left.
        height={inputRows() + 2}
      >
        <input
          ref={(el: { focus: () => void }) => (inputEl = el)}
          focused
          flexGrow={1}
          // Soft-wrap on word boundaries so long input stays visible and the box
          // grows, rather than scrolling horizontally out of view.
          wrapMode="word"
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Send a message or type / to start"
          // Transparent — no fill, just the bordered frame + text on black.
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={palette().assistant}
          focusedTextColor={palette().assistant}
          placeholderColor={palette().muted}
          cursorColor={brand()}
        />
      </box>
      {/* Status details + hints, directly UNDER the input (the old top header
          lives here now), BOTH centered for a uniform footer. Line 1: location ·
          git · model · changed · ctx · cost (· goal). Line 2: the key hints. */}
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <box flexGrow={1} />
        <text flexShrink={0} fg={palette().muted}>{detailsCenter()}</text>
        <box flexGrow={1} />
      </box>
      <SegRow center segs={hintSegs()} />
      </box>
      {/* Right gutter — mirrors the left, centering the chat column. */}
      <box flexGrow={1} flexShrink={1} />
    </box>
  );
}

/** One coloured run in a {@link SegRow} — bright tokens on muted scaffolding. */
type Seg = { t: string; fg: string };

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
 * One wordmark row as a left→right single-hue blue fade: a flex ROW of one
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
  const blocks = () => splitMarkdown(props.text);
  const pad = (kind: MdBlock["kind"]) => (kind === "code" || kind === "table" ? 0 : props.indent ?? 0);
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
                  <CodeBlock block={block as () => Extract<MdBlock, { kind: "code" }>} palette={props.palette} />
                </Match>
                <Match when={block().kind === "table"}>
                  <TableBlock
                    block={block as () => Extract<MdBlock, { kind: "table" }>}
                    palette={props.palette}
                    width={props.width ?? 80}
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

/** A markdown heading — bold accent text; h1/h2 get a thin underline rule so the
 * document structure reads at a glance. Deeper levels are just bold accent text. */
function HeadingBlock(props: { block: () => Extract<MdBlock, { kind: "heading" }>; palette: Palette }) {
  const p = props.palette;
  const b = props.block;
  const rule = () => (b().level <= 2 ? "─".repeat(Math.max(3, [...b().text].length)) : "");
  return (
    <box flexDirection="column">
      <text fg={p.heading} attributes={TextAttributes.BOLD} wrapMode="word">
        {b().text}
      </text>
      <Show when={rule()}>
        <text fg={p.border}>{rule()}</text>
      </Show>
    </box>
  );
}

/** A blockquote — a calm gutter bar with muted, italic quoted text. */
function QuoteBlock(props: { block: () => Extract<MdBlock, { kind: "quote" }>; palette: Palette }) {
  const p = props.palette;
  return (
    <box flexDirection="column">
      <For each={props.block().lines}>
        {(l) => (
          <box flexDirection="row">
            <text flexShrink={0} fg={p.gutter}>{"▎ "}</text>
            <text flexGrow={1} wrapMode="word" fg={p.muted} attributes={TextAttributes.ITALIC}>
              {l || " "}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

/** A fenced code block — monospace lines on a raised panel surface with a calm
 * left gutter, the language tagged in the accent. */
function CodeBlock(props: { block: () => Extract<MdBlock, { kind: "code" }>; palette: Palette }) {
  const p = props.palette;
  const lines = () => {
    const l = props.block().lines;
    return l.length ? l : [""];
  };
  return (
    <box
      flexDirection="column"
      backgroundColor={p.panel}
      border={["left"]}
      borderColor={p.gutter}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={props.block().lang}>
        <text fg={p.heading} attributes={TextAttributes.BOLD}>{props.block().lang}</text>
      </Show>
      <For each={lines()}>{(l) => <text fg={p.code} wrapMode="none">{l || " "}</text>}</For>
    </box>
  );
}

/** A GFM table — clean box-drawing, columns aligned, rules in the border tone, the
 * header row in the accent and bold. */
function TableBlock(props: {
  block: () => Extract<MdBlock, { kind: "table" }>;
  palette: Palette;
  width: number;
}) {
  const p = props.palette;
  const lines = () => renderTable(props.block().rows, props.block().align, Math.max(12, props.width));
  const rowFg = (role: "rule" | "header" | "row") =>
    role === "rule" ? p.border : role === "header" ? p.heading : p.assistant;
  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => (
          <text
            fg={rowFg(line.role)}
            attributes={line.role === "header" ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {line.text}
          </text>
        )}
      </For>
    </box>
  );
}

/**
 * A tool call / file edit: a single clickable header that expands to show the
 * captured output or the colored diff hunk. Condensed by default so the
 * transcript stays scannable.
 */
function ToolBlockView(props: {
  block: () => Extract<Block, { kind: "tool" }>;
  palette: Palette;
  style: SyntaxStyle | undefined;
  /** This row follows another visible tool row → stack flush (no top gap). */
  chained?: boolean;
  /** The calm gutter tone for the leading left-border marker (one flat tone). */
  hue: string;
  onToggle: (id: number) => void;
}) {
  const b = props.block;
  const p = props.palette;
  const expandable = () => b().output.length > 0;
  const head = () => {
    const t = b();
    const chevron = expandable() ? (t.collapsed ? "▸ " : "▾ ") : "  ";
    const hint = t.collapsed && expandable() ? `  ·  ${collapsedHint(t)}` : "";
    return `${chevron}${t.label}${hint}`;
  };
  const visible = () => b().output.slice(0, MAX_OUTPUT_LINES);
  const overflow = () => Math.max(0, b().output.length - MAX_OUTPUT_LINES);
  return (
    <box
      id={`tool-${b().id}`}
      // The calm gutter tone is the LEFT-BORDER marker — anchored at the column's
      // left edge so it lines up exactly with the user-message gutter and the input
      // frame (all at x=0). Chained steps stack flush, so a run of tool calls reads
      // as one continuous quiet thread. (A thin `│` vs the user gutter's heavy `┃`,
      // so they're aligned but distinct.)
      border={["left"]}
      borderColor={props.hue}
      flexDirection="column"
      flexShrink={0}
      marginTop={props.chained ? 0 : 1}
      paddingLeft={1}
      onMouseDown={() => {
        if (expandable()) props.onToggle(b().id);
      }}
    >
      {/* Header text stays neutral (red on error) for readability. */}
      <text fg={b().isError ? p.del : p.muted}>{head()}</text>
      <Show when={!b().collapsed && expandable()}>
        <Show
          when={b().isMarkdown}
          fallback={
            <box flexDirection="column">
              <For each={visible()}>
                {(line) =>
                  b().isDiff ? (
                    <text fg={diffColor(line, p)} bg={diffBg(line, p)}>
                      {line || " "}
                    </text>
                  ) : (
                    <text fg={p.muted}>{`  ${line}`}</text>
                  )
                }
              </For>
              <Show when={overflow() > 0}>
                <text fg={p.muted}>{`  … ${overflow()} more line${overflow() === 1 ? "" : "s"}`}</text>
              </Show>
            </box>
          }
        >
          {/* A subagent's reply is markdown prose — render headers/bold/lists/code
              (and tables where supported) instead of raw text. */}
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <AssistantText
              text={b().output.join("\n")}
              streaming={false}
              style={props.style}
              fg={p.assistant}
              palette={p}
            />
          </box>
        </Show>
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
function diffBg(line: string, p: Palette): string | undefined {
  if (line.startsWith("+")) return p.addBg;
  if (line.startsWith("-")) return p.delBg;
  return undefined;
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

/** Current working directory with $HOME collapsed to `~`. */
function shortCwd(): string {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return path.length > 48 ? `…${path.slice(-47)}` : path;
}

export async function mountApp(engine: EngineClient): Promise<void> {
  render(() => <App engine={engine} />);
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
