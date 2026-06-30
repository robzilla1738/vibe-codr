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
import type { EngineClient, GitInfo, JobInfo, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { applyPalette, isExactCommand, PALETTE_COMMANDS, paletteState } from "./commands-catalog.ts";
import { GLYPH } from "./glyphs.ts";
import { formatUsage, TASK_GLYPH } from "./headless.ts";
import { commandsForUiMode, deriveUiMode, modeColor, nextUiMode } from "./modes.ts";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";
import { spinnerFrame, workingLabel } from "./spinner.ts";
import { getTheme, type Palette } from "./themes.ts";
import { toolLabel } from "./tool-icons.ts";
import { WORDMARK_3D, WORDMARK_3D_COLS } from "./wordmark.ts";

/** The chat column's maximum width. At or below this the column fills the
 * terminal; above it the column stays centered with quiet side gutters
 * (ChatGPT-style — a readable, bounded conversation measure). */
const CONTENT_MAX = 96;
/** Cap how many output lines an expanded tool/diff block renders. */
const MAX_OUTPUT_LINES = 160;
/** The wordmark is rendered with OpenTUI's native ASCII-font renderable
 * (`<ascii_font font="slick">`) in the brand color — see the empty-state splash. */
/** Min column width to show the big wordmark (else a compact brand line). */
const LOGO_MIN_COLS = 56;

/**
 * One block in the transcript. The transcript is append-only: positions never
 * move, so we render it with <Index> (stable per-position rows) and only the
 * block currently being mutated (the streaming reply, or a toggled tool block)
 * re-renders. `id` is a stable handle for click-to-toggle.
 */
type Block =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; streaming: boolean; gap: boolean }
  | {
      kind: "tool";
      id: number;
      /** Header label ("→ read x" or, after a file change, "✎ edited x +n -m"). */
      label: string;
      /** Full captured output / diff hunk, shown only when expanded. */
      output: string[];
      collapsed: boolean;
      /** Output is a unified diff → color +/- lines when expanded. */
      isDiff: boolean;
      /** Output is markdown prose (a subagent's reply) → render via <markdown>. */
      isMarkdown?: boolean;
      isError: boolean;
    }
  | { kind: "notice"; id: number; text: string };

/** A subagent shown in the Subagents panel while it runs and after it finishes. */
interface Subagent {
  id: string;
  prompt: string;
  status: "running" | "done";
  /** One-line result summary, surfaced once the subagent finishes. */
  result?: string;
}

/** A file edited this session, with its cumulative line delta (footer summary). */
interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

interface PendingPerm {
  id: string;
  toolName: string;
  input: unknown;
}

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
  const grouping = createMemo(() => {
    const turnKey = new Map<number, number>(); // block id → turn's user-message id
    const counts = new Map<number, number>(); // user id → # of non-user blocks
    let cur = -1;
    for (const b of blocks()) {
      if (b.kind === "user") {
        cur = b.id;
        turnKey.set(b.id, b.id);
      } else if (cur >= 0) {
        turnKey.set(b.id, cur);
        counts.set(cur, (counts.get(cur) ?? 0) + 1);
      }
    }
    return { turnKey, counts };
  });
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
  const [queued, setQueued] = createSignal(0);
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
  // One configurable accent hue (orange-red `#ff3503` by default, set via `/accent`
  // or the `accentColor` config) is shown across the chrome — wordmark, input
  // frame, working line, user gutter, plan box, menu. Surfaces are charcoal, text
  // monochrome;
  // green/red appear only on diffs, amber only on warnings.
  const [accentColor, setAccentColor] = createSignal(snap.accentColor || "");
  const brand = () => accentColor() || palette().primary;
  // The active mode recolors ONLY the input's top-border TITLE (the mode word):
  // plan cyan / execute brand / yolo red. The input border itself stays brand
  // (purple), matching the command-menu box and the rest of the chrome.
  const accent = () => modeColor(uiMode(), palette());
  // Every invocable slash name (built-ins + custom commands + skills) from the
  // engine snapshot, plus the static palette as a floor. When the draft matches
  // one exactly, the input border shifts to the green "recognized" hue as an
  // instant registered cue; otherwise it stays the brand (purple).
  const commandNames = new Set(
    [...PALETTE_COMMANDS.map((c) => c.name), ...(snap.commandNames ?? [])].map((n) =>
      n.toLowerCase(),
    ),
  );
  const inputAccent = () =>
    isExactCommand(draft(), commandNames) ? palette().subagent : brand();
  // The mode word shown on the input's top border. "execute" means "every action
  // is gated by an approval prompt", so it reads as ASK (vs YOLO = no prompts).
  const modeWord = () => (uiMode() === "execute" ? "ASK" : uiMode().toUpperCase());

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

  // Slash-command menu: derives from the draft, so it opens/filters as you type.
  const menu = () => paletteState(draft());
  const [selIdx, setSelIdx] = createSignal(0);
  // Reset the highlight whenever the menu's contents change (new query/mode).
  createEffect(() => {
    const st = menu();
    void (st.open ? `${st.mode}:${st.query}` : "closed");
    setSelIdx(0);
  });
  // Windowed rows for rendering the menu (≤8 visible, scrolled to the highlight).
  const menuView = () => {
    const st = menu();
    if (!st.open) return null;
    const sel = Math.min(Math.max(0, selIdx()), st.items.length - 1);
    const WINDOW = 8;
    const start = Math.min(Math.max(0, sel - 4), Math.max(0, st.items.length - WINDOW));
    // Pad command names so descriptions line up in a column (opencode-style).
    const nameW =
      st.mode === "command"
        ? Math.min(14, Math.max(...st.items.map((c) => (c as { name: string }).name.length + 1)))
        : 0;
    const rows = st.items.slice(start, start + WINDOW).map((it, i) => {
      const active = start + i === sel;
      if (st.mode === "command") {
        const c = it as { name: string; description: string; values?: string[]; arg?: string };
        const hint = c.values ? ` (${c.values.join("|")})` : c.arg ? ` ${c.arg}` : "";
        return { active, text: `${`/${c.name}`.padEnd(nameW + 1)}  ${c.description}${hint}` };
      }
      return { active, text: `${st.command.name} → ${it as string}` };
    });
    const title = st.mode === "command" ? "commands" : `/${st.command.name}`;
    const more =
      st.items.length > WINDOW ? `+${st.items.length - WINDOW} more · type to filter` : "";
    return { rows, title, more };
  };

  // ── Transcript reducer state ───────────────────────────────────────────────
  // Positions are stable (append-only), so we track the streaming reply and each
  // tool call by index rather than searching the array on every delta.
  let nextId = 0;
  const newId = () => nextId++;
  let activeAssistant = -1; // index of the in-flight assistant block, or -1
  const toolByCallId = new Map<string, number>();

  // Finalize the streaming reply (flip `streaming` off so <markdown> closes any
  // trailing fence/table) and stop appending deltas to it.
  const finalizeAssistant = () => {
    if (activeAssistant >= 0) {
      setBlocks((prev) => {
        const b = prev[activeAssistant];
        if (b?.kind !== "assistant" || !b.streaming) return prev;
        const copy = prev.slice();
        copy[activeAssistant] = { ...b, streaming: false };
        return copy;
      });
    }
    activeAssistant = -1;
  };

  // Toggle a tool/diff block's collapsed state (the click-to-expand handler).
  const toggle = (id: number) =>
    setBlocks((prev) =>
      prev.map((b) => (b.id === id && b.kind === "tool" ? { ...b, collapsed: !b.collapsed } : b)),
    );

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

  // Shift+Tab cycles plan → execute → yolo. `useKeyboard` is a global handler,
  // so it fires even while the input is focused; Shift+Tab arrives as the key
  // name "tab" with `shift` set. The engine emits mode/approvals events back,
  // which refresh the header.
  const cycleMode = () => {
    const target = nextUiMode(deriveUiMode(mode, approvals));
    for (const cmd of commandsForUiMode(target)) props.engine.send(cmd);
  };
  // Apply the highlighted command-menu entry; `run` also submits a complete one.
  const choosePalette = (run: boolean) => {
    const res = applyPalette(menu(), selIdx());
    if (!res) return;
    setDraft(res.draft);
    if (run && res.done) runText(res.draft);
  };
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
    const st = menu();
    // Permission shortcuts: while a request is pending and you're not mid-typing,
    // y/a/n answers it directly and Esc rejects it.
    if (perms().length > 0 && !st.open && !draft().trim()) {
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
    // Esc interrupts an in-flight turn when nothing else claims the key.
    if (key.name === "escape" && !st.open && working() && perms().length === 0) {
      key.preventDefault?.();
      props.engine.send({ type: "abort" });
      return;
    }
    if (!st.open) return; // menu closed → let the input handle keys normally
    const n = st.items.length;
    switch (key.name) {
      case "up":
        key.preventDefault?.();
        setSelIdx((i) => (i - 1 + n) % n);
        break;
      case "down":
        key.preventDefault?.();
        setSelIdx((i) => (i + 1) % n);
        break;
      case "tab": // complete the highlighted entry without running it
        key.preventDefault?.();
        choosePalette(false);
        break;
      case "return":
      case "enter": // run the highlighted entry (preventDefault stops onSubmit)
        key.preventDefault?.();
        choosePalette(true);
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
    onCleanup(() => clearInterval(timer));

    void (async () => {
      // edit/write also echo their diff as the tool result; the file-changed
      // event already folded it into a diff block, so we skip that one
      // tool-call-finished echo — keyed by tool call id so an interleaved result
      // from a parallel read can never be swallowed by mistake.
      const suppressCallIds = new Set<string>();
      // Per-turn maps are cleared on each turn boundary so they can't leak.
      const endTurn = () => {
        finalizeAssistant();
        toolByCallId.clear();
        suppressCallIds.clear();
        setWorking(false);
      };
      for await (const event of props.engine.events() as AsyncIterable<UIEvent>) {
        switch (event.type) {
          case "user-message":
            finalizeAssistant();
            toolByCallId.clear();
            suppressCallIds.clear();
            // Subagents are per-turn activity (tasks persist, they don't) — start
            // each turn with a clean SUBAGENTS section. The plan box is a transient
            // affordance too: a new turn means it was acted on or abandoned.
            setSubagents([]);
            setPlan(null);
            setBlocks((prev) => [...prev, { kind: "user", id: newId(), text: event.text }]);
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
            // Append to the in-flight reply IMMUTABLY: replace its block object so
            // <Index> sees a changed value and re-renders just that row. The first
            // delta of a turn opens a new block with a blank line above it.
            setBlocks((prev) => {
              const cur = prev[activeAssistant];
              if (activeAssistant >= 0 && cur && cur.kind === "assistant") {
                const copy = prev.slice();
                copy[activeAssistant] = { ...cur, text: cur.text + event.delta };
                return copy;
              }
              const next = [
                ...prev,
                {
                  kind: "assistant" as const,
                  id: newId(),
                  text: event.delta,
                  streaming: true,
                  gap: true,
                },
              ];
              activeAssistant = next.length - 1;
              return next;
            });
            break;
          case "tool-call-started": {
            if (event.subagentId) break; // subagent tools don't enter the transcript
            finalizeAssistant();
            const label = toolLabel(event.toolName, event.input);
            // Subagent replies and web-search results are markdown — render them
            // (headers, bold, lists, tables) when expanded instead of raw lines.
            const isMarkdown =
              event.toolName === "spawn_subagent" || event.toolName === "web_search";
            setBlocks((prev) => {
              const next = [
                ...prev,
                {
                  kind: "tool" as const,
                  id: newId(),
                  label,
                  output: [] as string[],
                  // A subagent reply opens expanded (it's the answer); other tools
                  // (incl. web_search) stay condensed to one line until clicked.
                  collapsed: event.toolName !== "spawn_subagent",
                  isDiff: false,
                  isMarkdown,
                  isError: false,
                },
              ];
              toolByCallId.set(event.toolCallId, next.length - 1);
              return next;
            });
            break;
          }
          case "tool-call-finished": {
            if (event.subagentId) break;
            // Skip only the echo for the exact call whose diff we already folded.
            if (suppressCallIds.has(event.toolCallId)) {
              suppressCallIds.delete(event.toolCallId);
              break;
            }
            const idx = toolByCallId.get(event.toolCallId);
            toolByCallId.delete(event.toolCallId); // call ids are single-use
            const out =
              typeof event.output === "string"
                ? event.output
                : JSON.stringify(event.output, null, 2);
            const lines = out.split("\n").filter((l, i, a) => l.length || i < a.length - 1);
            setBlocks((prev) => {
              if (idx == null) return prev;
              const b = prev[idx];
              if (b?.kind !== "tool") return prev;
              const copy = prev.slice();
              copy[idx] = { ...b, output: lines, isError: event.isError };
              return copy;
            });
            break;
          }
          case "file-changed": {
            // Fold the diff into the EXACT tool block that produced it (by call
            // id — no positional guessing), so an edit reads as one row with the
            // hunk shown beneath it. Diffs are the signature output, so they're
            // expanded by default (click the row to collapse).
            suppressCallIds.add(event.toolCallId);
            const verb = event.action === "write" ? "wrote" : "edited";
            const header = `${GLYPH.file} ${verb} ${event.path}  +${event.added} -${event.removed}`;
            const lines = event.diff ? event.diff.split("\n") : [];
            // Track the file for the footer's changed-file summary (cumulative delta).
            setChangedFiles((prev) => {
              const i = prev.findIndex((f) => f.path === event.path);
              if (i >= 0) {
                const copy = prev.slice();
                const f = copy[i] as ChangedFile;
                copy[i] = { path: f.path, added: f.added + event.added, removed: f.removed + event.removed };
                return copy;
              }
              return [...prev, { path: event.path, added: event.added, removed: event.removed }];
            });
            finalizeAssistant();
            setBlocks((prev) => {
              const idx = toolByCallId.get(event.toolCallId);
              const target = idx == null ? undefined : prev[idx];
              const canFold = !!target && target.kind === "tool" && !target.isDiff;
              const folded = {
                kind: "tool" as const,
                id: canFold ? (target as { id: number }).id : newId(),
                label: header,
                output: lines,
                collapsed: false,
                isDiff: true,
                isError: false,
              };
              if (canFold && idx != null) {
                const copy = prev.slice();
                copy[idx] = folded;
                return copy;
              }
              // No matching block, or this call already produced a diff (a second
              // changed file) → append a standalone diff row.
              return [...prev, folded];
            });
            break;
          }
          case "tasks-updated":
            setTasks(event.tasks);
            break;
          case "queue-changed":
            setQueued(event.pending.length);
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
            finalizeAssistant();
            setBlocks((prev) => [
              ...prev,
              { kind: "notice", id: newId(), text: event.message },
            ]);
            break;
          case "engine-error":
            endTurn();
            setBlocks((prev) => [
              ...prev,
              { kind: "notice", id: newId(), text: `error: ${event.message}` },
            ]);
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
    // `/clear` (and `/new`) reset the conversation — wipe the visible transcript
    // AND every piece of live turn state so nothing dangles (a stale spinner,
    // an orphaned permission card, a half-streamed reply). Abort first if a turn
    // is in flight so the engine stops streaming into the cleared screen.
    if (text === "/clear" || text === "/new") {
      if (working()) props.engine.send({ type: "abort" });
      setBlocks([]);
      setPlan(null);
      setSubagents([]);
      setCollapsedTurns(new Set());
      setChangedFiles([]);
      setPerms([]);
      setQueued(0);
      setWorking(false);
      activeAssistant = -1;
      toolByCallId.clear();
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
  // The fresh, wide, tall splash shows the big 3D wordmark (111 cols wide), so
  // the chat column spans the full terminal then — the reading cap would clip the
  // art. It snaps back to CONTENT_MAX the instant a conversation starts or jobs
  // open. `splashLogo3D()` is the single source of truth for "show the 3D logo".
  const splashLogo3D = () =>
    !showJobs() &&
    blocks().length === 0 &&
    // -4: the chat column reserves a 1-col gutter each side (its own padding plus
    // the terminal margin), so the art needs WORDMARK_3D_COLS + 4 to clear it.
    dims().width - 4 >= WORDMARK_3D_COLS &&
    dims().height >= 22;
  const columnWidth = () =>
    splashLogo3D() ? Math.min(dims().width - 2, 160) : contentWidth();
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
      <box flexDirection="column" width={columnWidth()} flexShrink={0} padding={1}>
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
                    when={splashLogo3D()}
                    fallback={
                      <Show
                        when={contentWidth() >= LOGO_MIN_COLS && dims().height >= 16}
                        fallback={
                          <text fg={brand()} attributes={TextAttributes.BOLD}>{"◆ VIBE CODR"}</text>
                        }
                      >
                        {/* Native ASCII-font wordmark — a sleek rounded face in
                            the brand color (orange-red by default; tracks /accent). */}
                        <ascii_font text="VIBE CODR" font="slick" color={brand()} />
                      </Show>
                    }
                  >
                    {/* Big 3D "impossible"-font wordmark on wide, tall terminals —
                        one brand <text> per line, the block left-aligned within
                        this column and centered by the flex spacers around it. */}
                    <For each={WORDMARK_3D}>
                      {(line) => <text fg={brand()}>{line || " "}</text>}
                    </For>
                  </Show>
                </box>
                <box flexGrow={1} />
              </box>
              {/* Tip lines — each individually centered (calm muted subtitle; the
                  actionable tokens — example prompts and keys — in the brighter
                  foreground). */}
              <box flexDirection="column" marginTop={1}>
                <SegRow
                  center
                  segs={[
                    { t: "Your model-agnostic coding agent", fg: palette().muted },
                    { t: "  —  plan · execute · yolo", fg: palette().muted },
                  ]}
                />
                <SegRow
                  center
                  marginTop={1}
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
                <SegRow
                  center
                  segs={[
                    { t: "shift+tab", fg: palette().assistant },
                    { t: " mode", fg: palette().muted },
                    { t: "  ·  ", fg: palette().muted },
                    { t: "@", fg: palette().assistant },
                    { t: " files", fg: palette().muted },
                    { t: "  ·  ", fg: palette().muted },
                    { t: "/", fg: palette().assistant },
                    { t: " commands", fg: palette().muted },
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
                    paddingLeft={1}
                  >
                    <AssistantText
                      text={(block() as { text: string }).text}
                      streaming={(block() as { streaming: boolean }).streaming}
                      style={mdStyle}
                      fg={palette().assistant}
                    />
                  </box>
                </Show>
                <Show when={block().kind === "tool" && !isHidden((block() as { id: number }).id)}>
                  <ToolBlockView
                    block={block as () => Extract<Block, { kind: "tool" }>}
                    palette={palette()}
                    style={mdStyle}
                    chained={chained()}
                    onToggle={(id) => anchoredToggle(() => toggle(id))}
                  />
                </Show>
                <Show when={block().kind === "notice" && !isHidden((block() as { id: number }).id)}>
                  <text fg={palette().notice} marginTop={1} paddingLeft={1}>
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

      {/* Live working indicator — braille spinner + elapsed, hidden while a
          permission card is up (the card is the active affordance then). */}
      <Show when={working() && perms().length === 0}>
        <text fg={brand()} flexShrink={0} marginTop={1}>
          {`${spinnerFrame(tick())} ${workingLabel(Date.now() - turnStartedAt)}  ·  esc to interrupt`}
        </text>
      </Show>
      <Show when={plan()}>
        <box
          border
          borderColor={brand()}
          title="Plan"
          titleColor={brand()}
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <AssistantText
            text={plan() ?? ""}
            streaming={false}
            style={mdStyle}
            fg={palette().assistant}
          />
          <text fg={palette().muted}>Shift+Tab to execute, or /execute to proceed.</text>
        </box>
      </Show>
      {/* Tasks — the live to-do list, just above the input; hides once everything
          is done so a finished list doesn't linger. */}
      <Show when={tasks().length > 0 && tasks().some((t) => t.status !== "completed")}>
        <box
          border
          borderColor={palette().border}
          title={`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
          titleColor={brand()}
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
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
          border
          borderColor={palette().border}
          title={`Subagents · ${subagents().length}`}
          titleColor={brand()}
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <For each={subagents()}>
            {(s) => {
              const open = () => expandedSubs().has(s.id);
              const fg = () => (s.status === "running" ? brand() : palette().muted);
              const oneLine = () =>
                truncate(firstLine(s.prompt) ?? s.prompt, Math.max(24, contentWidth() - 14));
              return (
                <box flexDirection="column" onMouseDown={() => toggleSub(s.id)}>
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={palette().muted}>{open() ? "▾" : "▸"}</text>
                    <text flexShrink={0} fg={fg()}>
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
      {/* Slash-command menu — opens while typing a `/command`. ↑/↓ to highlight,
          Tab to complete, Enter to run, Esc to dismiss. */}
      <Show when={menu().open}>
        <box
          border
          borderColor={brand()}
          title={menuView()?.title}
          titleColor={brand()}
          backgroundColor={palette().panel}
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <For each={menuView()?.rows ?? []}>
            {(row) => (
              <text
                fg={row.active ? brand() : palette().muted}
                bg={row.active ? palette().selBg : undefined}
                attributes={row.active ? TextAttributes.BOLD : undefined}
              >
                {`${row.active ? "❯ " : "  "}${row.text}`}
              </text>
            )}
          </For>
          <Show when={menuView()?.more}>
            <text fg={palette().muted}>{`  ${menuView()?.more}`}</text>
          </Show>
        </box>
      </Show>
      {/* Text input — just the brand border with the mode word on the top edge and
          the text inside, on the black backdrop (NO fill): the box sets no
          background and the input is transparent, so there's no grey surface at all.
          The border flips green while a recognized /command is drafted; the mode word
          carries the mode color (execute brand · plan cyan · yolo red). */}
      <box
        border
        borderColor={inputAccent()}
        title={` ${modeWord()} `}
        titleColor={uiMode() === "execute" ? brand() : accent()}
        flexDirection="row"
        flexShrink={0}
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          ref={(el: { focus: () => void }) => (inputEl = el)}
          focused
          flexGrow={1}
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
 * Assistant / plan prose. Renders through OpenTUI's native <markdown> renderable
 * (proper wrapping, bold/italic/code, fenced blocks) — never a pre-styled ANSI
 * string, which the buffer would miscount and garble. Falls back to plain
 * per-line <text> if a SyntaxStyle couldn't be created.
 */
function AssistantText(props: {
  text: string;
  streaming: boolean;
  style: SyntaxStyle | undefined;
  fg: string;
}) {
  return (
    <Show
      when={props.style}
      fallback={
        <For each={props.text.split("\n")}>{(l) => <text fg={props.fg}>{l || " "}</text>}</For>
      }
    >
      <markdown
        content={props.text}
        streaming={props.streaming}
        syntaxStyle={props.style!}
        fg={props.fg}
      />
    </Show>
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
      flexDirection="column"
      flexShrink={0}
      marginTop={props.chained ? 0 : 1}
      paddingLeft={1}
      onMouseDown={() => {
        if (expandable()) props.onToggle(b().id);
      }}
    >
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
            />
          </box>
        </Show>
      </Show>
    </box>
  );
}

/**
 * The collapsed-row detail after a tool label: `diff` for edits, `N results`
 * for a web search (counting the numbered result entries the search tool emits),
 * else the raw `N lines`. The result-count reads far better than "33 lines" of
 * payload for a search.
 */
function collapsedHint(t: Extract<Block, { kind: "tool" }>): string {
  if (t.isDiff) return "diff";
  if (t.label.startsWith("◈")) {
    const results = t.output.filter((l) => /^\d+\.\s/.test(l)).length;
    if (results > 0) return `${results} result${results === 1 ? "" : "s"}`;
  }
  return `${t.output.length} line${t.output.length === 1 ? "" : "s"}`;
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The first non-empty line of a (possibly multi-line) string, for one-line summaries. */
function firstLine(s: string | undefined): string | undefined {
  const line = s?.split("\n").find((l) => l.trim().length > 0)?.trim();
  return line || undefined;
}

export async function mountApp(engine: EngineClient): Promise<void> {
  render(() => <App engine={engine} />);
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
