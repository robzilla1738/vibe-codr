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
 * Layout: a slim status bar on top, a two-column body (scrolling transcript +
 * a right "context rail" with tasks/subagents/usage), and the input affordances
 * below. Assistant text renders through OpenTUI's native <markdown> renderable
 * (NOT a hand-rolled ANSI string — embedding raw escape codes in a <text> made
 * the renderer miscount widths and garble long streamed replies). Tool and diff
 * output is condensed to one line and expands on click.
 */

import { SyntaxStyle, TextAttributes } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { EngineClient, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { applyPalette, isExactCommand, PALETTE_COMMANDS, paletteState } from "./commands-catalog.ts";
import { GLYPH } from "./glyphs.ts";
import { formatUsage, TASK_GLYPH } from "./headless.ts";
import { commandsForUiMode, deriveUiMode, modeColor, modeLabel, nextUiMode } from "./modes.ts";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";
import { spinnerFrame, workingLabel } from "./spinner.ts";
import { getTheme, type Palette } from "./themes.ts";
import { toolLabel } from "./tool-icons.ts";

/** Width of the right context rail and the terminal width it needs to appear.
 * The rail scrolls and pins the session footer, so it never overflows — no row
 * caps needed (cf. opencode's sidebar). */
const RAIL_WIDTH = 34;
const RAIL_MIN_COLS = 96;
/** Cap how many output lines an expanded tool/diff block renders. */
const MAX_OUTPUT_LINES = 160;
/** How many recent tool calls the rail's "Activity" feed keeps. */
const MAX_ACTIVITY = 6;

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
      isError: boolean;
    }
  | { kind: "notice"; id: number; text: string };

/** A subagent shown in the context rail while it runs and after it finishes. */
interface Subagent {
  id: string;
  prompt: string;
  status: "running" | "done";
  /** One-line result summary, surfaced once the subagent finishes. */
  result?: string;
}

/** A recent tool call for the rail's live "Activity" feed. */
interface Activity {
  callId: string;
  label: string;
  status: "running" | "done" | "error";
}

/** A file edited this session, with its cumulative line delta (rail "Changed"). */
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
  // Recent tool calls (newest first, capped), the rail's live activity feed.
  const [activity, setActivity] = createSignal<Activity[]>([]);
  // Turns (assistant block ids) whose tool/notice output is folded away — click
  // a message to fold its work, or Ctrl+O to fold/unfold every turn at once.
  const [collapsedTurns, setCollapsedTurns] = createSignal<Set<number>>(new Set());
  const toggleTurn = (turn: number) =>
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      next.has(turn) ? next.delete(turn) : next.add(turn);
      return next;
    });
  // Owning assistant turn for each tool/notice block, computed by POSITION (the
  // nearest preceding assistant message in the transcript) rather than emission
  // order — so clicking a message always folds the work shown beneath it, even
  // when a tool was emitted before the assistant's first text. Tools before any
  // assistant text in a turn stay unowned (nothing above to fold them under).
  const grouping = createMemo(() => {
    const owner = new Map<number, number>(); // block id → owning assistant id
    const counts = new Map<number, number>(); // assistant id → foldable child count
    let cur = -1;
    for (const b of blocks()) {
      if (b.kind === "user") cur = -1;
      else if (b.kind === "assistant") cur = b.id;
      else if ((b.kind === "tool" || b.kind === "notice") && cur >= 0) {
        owner.set(b.id, cur);
        counts.set(cur, (counts.get(cur) ?? 0) + 1);
      }
    }
    return { owner, counts };
  });
  const turnChildCount = (assistantId: number) => grouping().counts.get(assistantId) ?? 0;
  // A tool/notice block is hidden when its owning message's turn is folded.
  const isHidden = (blockId: number) => {
    const o = grouping().owner.get(blockId);
    return o !== undefined && collapsedTurns().has(o);
  };
  // Ctrl+O: fold every turn that has foldable work, or unfold all if any is folded.
  const toggleAllTurns = () =>
    setCollapsedTurns((prev) =>
      prev.size > 0 ? new Set() : new Set(grouping().counts.keys()),
    );
  // Files touched this session (path → cumulative line delta), shown in the rail.
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
  // Rail-only projections of the live status (the header stays minimal).
  const [ctxInfo, setCtxInfo] = createSignal(ctxSummary(ctx));
  const [usageInfo, setUsageInfo] = createSignal(usage.totalTokens > 0 ? formatUsage(usage) : "");
  const [goalInfo, setGoalInfo] = createSignal<string | null>(goal);
  const cwd = shortCwd();
  // One fixed brand hue (light lavender) is shown across the whole UI — header,
  // rail, working line, user bars, plan box, menu. Everything else is neutral
  // text/muted; green/red appear only on diffs, amber only on warnings, so the
  // UI reads as one tasteful color, not a rainbow.
  const brand = () => palette().primary;
  // The text-input area is the ONLY region that tracks the active mode — its
  // left bar, caret, and cursor recolor on plan/execute/yolo; nothing else does.
  const accent = () => modeColor(uiMode(), palette());
  // Every invocable slash name (built-ins + custom commands + skills) from the
  // engine snapshot, plus the static palette as a floor. When the draft matches
  // one exactly, the input shifts to the green "recognized" hue as an instant
  // registered cue (a timed pulse could layer on later via `tick()`); otherwise
  // it stays the mode accent.
  const commandNames = new Set(
    [...PALETTE_COMMANDS.map((c) => c.name), ...(snap.commandNames ?? [])].map((n) =>
      n.toLowerCase(),
    ),
  );
  const inputAccent = () =>
    isExactCommand(draft(), commandNames) ? palette().subagent : accent();

  // Native markdown rendering needs a SyntaxStyle (for fenced code highlighting).
  // Created once; if the native lib can't build one we fall back to plain text.
  let mdStyle: SyntaxStyle | undefined;
  try {
    mdStyle = SyntaxStyle.create();
  } catch {
    mdStyle = undefined;
  }

  // The context rail only appears when the terminal is wide enough to keep the
  // transcript readable; otherwise tasks fall back to a bottom panel.
  const dims = useTerminalDimensions();
  const showRail = () => dims().width >= RAIL_MIN_COLS;

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
    setCtxInfo(ctxSummary(ctx));
    setUsageInfo(usage.totalTokens > 0 ? formatUsage(usage) : "");
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
            // Subagent deltas (they carry a subagentId) are summarized in the rail,
            // not streamed into the parent transcript; empty deltas are no-ops.
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
            setActivity((prev) =>
              [{ callId: event.toolCallId, label, status: "running" as const }, ...prev].slice(
                0,
                MAX_ACTIVITY,
              ),
            );
            setBlocks((prev) => {
              const next = [
                ...prev,
                {
                  kind: "tool" as const,
                  id: newId(),
                  label,
                  output: [] as string[],
                  collapsed: true,
                  isDiff: false,
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
            setActivity((prev) =>
              prev.map((a) =>
                a.callId === event.toolCallId
                  ? { ...a, status: event.isError ? "error" : "done" }
                  : a,
              ),
            );
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
            // Track the file in the rail's "Changed" section (cumulative delta).
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
      setActivity([]);
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

  return (
    <box flexDirection="column" padding={1} style={{ height: "100%" }} onMouseDown={refocusInput}>
      {/* Header — a slim status bar with a single underline rule. Brand + mode
          pill on the left, cwd on the right. The model/usage detail moves to the
          rail when it's shown; on narrow terminals it stays in a second row. */}
      <box
        flexDirection="column"
        flexShrink={0}
        border={["bottom"]}
        borderColor={palette().border}
        paddingBottom={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row">
            <text fg={brand()} attributes={TextAttributes.BOLD}>
              {"◆ vibe-codr"}
            </text>
            <text fg={palette().muted}>{"   "}</text>
            <text
              fg={brand()}
              bg={palette().elevated}
              attributes={TextAttributes.BOLD}
            >{` ${modeLabel(uiMode())} `}</text>
          </box>
          <text fg={palette().muted}>{cwd}</text>
        </box>
        <Show when={!showRail()}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={palette().assistant}>{headModel()}</text>
            <Show when={goalInfo()}>
              <text fg={palette().muted}>{`★ ${truncate(goalInfo() ?? "", 32)}`}</text>
            </Show>
          </box>
        </Show>
      </box>

      {/* Body — a scrolling transcript beside the context rail. */}
      <box flexDirection="row" flexGrow={1} marginTop={1} gap={2}>
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
          <Show when={blocks().length === 0}>
            <box flexDirection="column" paddingLeft={1}>
              <text fg={brand()} attributes={TextAttributes.BOLD}>
                {"◆ vibe-codr"}
              </text>
              <text fg={palette().muted}>
                {"Your model-agnostic coding agent — plan, execute, or yolo."}
              </text>
              <text fg={palette().muted}>
                {"Try:  explain this codebase  ·  fix the failing test  ·  add a --json flag"}
              </text>
              <text fg={palette().muted}>
                {"Shift+Tab switches mode · @file attaches · / opens commands"}
              </text>
            </box>
          </Show>
          {/* <Index> keys by position (stable, append-only). A block's `kind`
              is immutable for its lifetime — the file-changed fold mutates a
              tool block in place (tool→tool) but never changes kind — so the
              per-kind <Show> branches below never need to swap a row's element. */}
          <Index each={blocks()}>
            {(block) => (
              <Show
                when={block().kind !== "user"}
                fallback={
                  // Signature user turn: the SAME raised frame as the input bar
                  // (heavy accent gutter, elevated surface, prompt caret) so your
                  // sent messages and the place you type read as one element.
                  <box
                    border={["left"]}
                    borderStyle="heavy"
                    borderColor={brand()}
                    backgroundColor={palette().elevated}
                    flexDirection="row"
                    marginTop={1}
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
                }
              >
                {/* assistant / tool / notice. An assistant message is a click
                    target: clicking folds its turn's tool/notice work away
                    (leaving just the prose), with a "N steps hidden" affordance. */}
                <Show when={block().kind === "assistant"}>
                  <box
                    id={`msg-${(block() as { id: number }).id}`}
                    flexDirection="column"
                    marginTop={(block() as { gap: boolean }).gap ? 1 : 0}
                    paddingLeft={1}
                    onMouseDown={() => {
                      const id = (block() as { id: number }).id;
                      if (turnChildCount(id) > 0) anchoredToggle(() => toggleTurn(id));
                    }}
                  >
                    <AssistantText
                      text={(block() as { text: string }).text}
                      streaming={(block() as { streaming: boolean }).streaming}
                      style={mdStyle}
                      fg={palette().assistant}
                    />
                    <Show when={turnChildCount((block() as { id: number }).id) > 0}>
                      <text fg={palette().muted}>
                        {collapsedTurns().has((block() as { id: number }).id)
                          ? `▸ ${turnChildCount((block() as { id: number }).id)} step${turnChildCount((block() as { id: number }).id) === 1 ? "" : "s"} hidden`
                          : "▾"}
                      </text>
                    </Show>
                  </box>
                </Show>
                <Show when={block().kind === "tool" && !isHidden((block() as { id: number }).id)}>
                  <ToolBlockView
                    block={block as () => Extract<Block, { kind: "tool" }>}
                    palette={palette()}
                    onToggle={(id) => anchoredToggle(() => toggle(id))}
                  />
                </Show>
                <Show when={block().kind === "notice" && !isHidden((block() as { id: number }).id)}>
                  <text fg={palette().notice} marginTop={1} paddingLeft={1}>
                    {(block() as { text: string }).text}
                  </text>
                </Show>
              </Show>
            )}
          </Index>
        </scrollbox>

        {/* Context rail — a panel surface with stacked, scrolling sections:
            tasks, subagents, changed files, then session info (last so the work
            stays prominent up top). Sections hide when empty; the task list also
            hides once everything's done (the transcript keeps the record). Item
            text wraps rather than truncating, so nothing is silently cut off. */}
        <Show when={showRail()}>
          <box
            width={RAIL_WIDTH}
            flexShrink={0}
            backgroundColor={palette().elevated}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
          >
            <scrollbox
              flexGrow={1}
              scrollY
              contentOptions={{ flexDirection: "column", gap: 1 }}
              scrollbarOptions={{ visible: false }}
            >
              {/* Activity — the last few tool calls (newest first): a live feed
                  of what the agent is doing right now. Shown only while a turn is
                  running so it never duplicates the transcript when you're idle;
                  the running row animates, errors show red. */}
              <Show when={working() && activity().length > 0}>
                <box flexDirection="column">
                  <text fg={palette().assistant} attributes={TextAttributes.BOLD}>{"Activity"}</text>
                  <For each={activity()}>
                    {(a) => {
                      const c =
                        a.status === "error"
                          ? palette().del
                          : a.status === "running"
                            ? brand()
                            : palette().muted;
                      const glyph =
                        a.status === "running"
                          ? spinnerFrame(tick())
                          : a.status === "error"
                            ? "✗"
                            : GLYPH.check;
                      return (
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={c}>{glyph}</text>
                          <text flexGrow={1} wrapMode="none" fg={c}>
                            {truncate(a.label, RAIL_WIDTH - 4)}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                </box>
              </Show>

              <Show when={subagents().length > 0}>
                <box flexDirection="column">
                  <text fg={palette().assistant} attributes={TextAttributes.BOLD}>{"Subagents"}</text>
                  <For each={subagents()}>
                    {(s) => (
                      <box flexDirection="column">
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={s.status === "running" ? brand() : palette().muted}>
                            {s.status === "running" ? spinnerFrame(tick()) : GLYPH.check}
                          </text>
                          <text
                            flexGrow={1}
                            wrapMode="word"
                            fg={s.status === "running" ? brand() : palette().muted}
                          >
                            {s.prompt}
                          </text>
                        </box>
                        <Show when={s.result}>
                          <text fg={palette().muted} wrapMode="word">
                            {`   ${GLYPH.result} ${s.result}`}
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              <Show when={tasks().length > 0 && tasks().some((t) => t.status !== "completed")}>
                <box flexDirection="column">
                  <text fg={palette().assistant} attributes={TextAttributes.BOLD}>
                    {`Tasks  ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
                  </text>
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

              <Show when={changedFiles().length > 0}>
                <box flexDirection="column">
                  <text fg={palette().assistant} attributes={TextAttributes.BOLD}>{"Changed"}</text>
                  <For each={changedFiles()}>
                    {(f) => (
                      <box flexDirection="row" gap={1} justifyContent="space-between">
                        <text flexGrow={1} wrapMode="none" fg={palette().muted}>
                          {truncateLeft(f.path, RAIL_WIDTH - 5 - changeWidth(f))}
                        </text>
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <Show when={f.added > 0}>
                            <text fg={palette().add}>{`+${f.added}`}</text>
                          </Show>
                          <Show when={f.removed > 0}>
                            <text fg={palette().del}>{`-${f.removed}`}</text>
                          </Show>
                        </box>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              {/* Session — always shown, last so tasks/subagents stay prominent
                  up top; on a fresh chat it's the only section and sits at the top. */}
              <box flexDirection="column">
                <text fg={palette().assistant} attributes={TextAttributes.BOLD}>{"Session"}</text>
                <text fg={palette().muted} wrapMode="word">{headModel()}</text>
                <Show when={ctxInfo()}>
                  <text fg={palette().muted}>{`ctx ${ctxInfo()}`}</text>
                </Show>
                <Show when={usageInfo()}>
                  <text fg={palette().muted}>{usageInfo()}</text>
                </Show>
                <Show when={goalInfo()}>
                  <text fg={palette().muted} wrapMode="word">{`★ ${goalInfo()}`}</text>
                </Show>
              </box>
            </scrollbox>
          </box>
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
      {/* Tasks fallback for narrow terminals (no rail). */}
      <Show when={!showRail() && tasks().length > 0}>
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
            {(task) => (
              <text
                fg={
                  task.status === "completed"
                    ? palette().muted
                    : task.status === "in_progress"
                      ? brand()
                      : palette().assistant
                }
              >
                {`${TASK_GLYPH[task.status]} ${task.title}`}
              </text>
            )}
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
      {/* Text input — a raised, clearly-bounded field. The heavy left bar and the
          prompt caret are the only accent here; the surface is one elevated tone
          so it reads as "type here" without a bright highlight bar. */}
      <box
        border={["left"]}
        borderStyle="heavy"
        borderColor={inputAccent()}
        backgroundColor={palette().elevated}
        flexDirection="row"
        flexShrink={0}
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={inputAccent()} attributes={TextAttributes.BOLD}>
          {"❯ "}
        </text>
        <input
          ref={(el: { focus: () => void }) => (inputEl = el)}
          focused
          flexGrow={1}
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Ask vibe-codr…   @file · /help · /model <id> · /undo"
          backgroundColor={palette().elevated}
          focusedBackgroundColor={palette().elevated}
          textColor={palette().assistant}
          focusedTextColor={palette().assistant}
          placeholderColor={palette().muted}
          cursorColor={inputAccent()}
        />
      </box>
      {/* Footer — key bindings on the left, live context/usage/cost on the right
          (shown only once there's something to report). */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0} marginTop={1}>
        <text fg={palette().muted}>
          {"shift+tab mode · / commands · click ▸ expand · ^O fold all · esc interrupt"}
        </text>
        <Show when={metrics()}>
          <text flexShrink={0} fg={palette().muted}>{metrics()}</text>
        </Show>
      </box>
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
      marginTop={1}
      paddingLeft={1}
      onMouseDown={() => {
        if (expandable()) props.onToggle(b().id);
      }}
    >
      <text fg={b().isError ? p.del : p.muted}>{head()}</text>
      <Show when={!b().collapsed && expandable()}>
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

/** The dim header detail (narrow mode): context fill, usage, queue, and goal. */
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

/** Rail context line: "12% · 24k/200k", or "" when not meaningful yet. */
function ctxSummary(ctx: { usedTokens: number; contextWindow: number } | null): string {
  if (!ctx || ctx.contextWindow <= 0) return "";
  const pct = Math.min(100, Math.round((ctx.usedTokens / ctx.contextWindow) * 100));
  if (pct < 1) return "";
  return `${pct}% · ${ktok(ctx.usedTokens)}/${ktok(ctx.contextWindow)}`;
}
function ktok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
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

/** Truncate from the LEFT (keep the tail/basename), e.g. `…core/src/engine.ts`. */
function truncateLeft(s: string, n: number): string {
  if (n <= 1) return s.slice(-1);
  return s.length > n ? `…${s.slice(-(n - 1))}` : s;
}

/** Display width of a changed-file's "+a -b" delta, for laying out the row. */
function changeWidth(f: ChangedFile): number {
  const a = f.added > 0 ? `+${f.added}` : "";
  const r = f.removed > 0 ? `-${f.removed}` : "";
  return [a, r].filter(Boolean).join(" ").length;
}

export async function mountApp(engine: EngineClient): Promise<void> {
  render(() => <App engine={engine} />);
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
