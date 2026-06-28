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
 */
import { render, useKeyboard } from "@opentui/solid";
import { createSignal, createEffect, onMount, For, Index, Show } from "solid-js";
import type { EngineClient, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";
import { TASK_GLYPH, formatUsage } from "./headless.ts";
import { GLYPH } from "./glyphs.ts";
import { renderMarkdown } from "./markdown.ts";
import { getTheme, type Palette } from "./themes.ts";
import {
  deriveUiMode,
  nextUiMode,
  commandsForUiMode,
  modeLabel,
  modeColor,
} from "./modes.ts";
import { paletteState, applyPalette } from "./commands-catalog.ts";

interface Line {
  kind:
    | "user"
    | "assistant"
    | "tool"
    | "toolresult"
    | "notice"
    | "subagent"
    | "add"
    | "del"
    | "ctx";
  text: string;
}

export function App(props: { engine: EngineClient }) {
  const snap = props.engine.snapshot();
  const [lines, setLines] = createSignal<Line[]>([]);
  const [draft, setDraft] = createSignal("");
  const [tasks, setTasks] = createSignal<Task[]>(snap.tasks);
  const [plan, setPlan] = createSignal<string | null>(null);
  const [queued, setQueued] = createSignal(0);
  let model = snap.model;
  let mode = snap.mode;
  let approvals = snap.approvalMode;
  let goal = snap.goal;
  let usage: SessionUsage = snap.usage;
  let ctx: { usedTokens: number; contextWindow: number } | null = null;
  const pendingPerms: string[] = []; // FIFO of unanswered permission ids
  const [palette, setPalette] = createSignal<Palette>(getTheme(snap.theme));
  const [uiMode, setUiMode] = createSignal(deriveUiMode(mode, approvals));
  const [headModel, setHeadModel] = createSignal(model);
  const [headInfo, setHeadInfo] = createSignal(headerInfo(0, usage, ctx, goal));
  const cwd = shortCwd();

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
    const rows = st.items.slice(start, start + WINDOW).map((it, i) => {
      const active = start + i === sel;
      if (st.mode === "command") {
        const c = it as { name: string; description: string; values?: string[]; arg?: string };
        const hint = c.values ? ` (${c.values.join("|")})` : c.arg ? ` ${c.arg}` : "";
        return { active, text: `/${c.name}  —  ${c.description}${hint}` };
      }
      return { active, text: `${st.command.name} → ${it as string}` };
    });
    const title = st.mode === "command" ? "commands" : `/${st.command.name}`;
    const more = st.items.length > WINDOW ? `+${st.items.length - WINDOW} more · type to filter` : "";
    return { rows, title, more };
  };

  const append = (line: Line) => setLines((prev) => [...prev, line]);
  // Refresh the header chrome whenever model/mode/usage/context/goal changes.
  const refreshStatus = () => {
    setUiMode(deriveUiMode(mode, approvals));
    setHeadModel(model);
    setHeadInfo(headerInfo(queued(), usage, ctx, goal));
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
  useKeyboard((key: { name?: string; shift?: boolean; preventDefault?: () => void }) => {
    // Shift+Tab cycles plan → execute → yolo, menu open or not.
    if (key.name === "tab" && key.shift) {
      key.preventDefault?.();
      cycleMode();
      return;
    }
    const st = menu();
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
    void (async () => {
      let streaming: Line | null = null;
      // edit/write echo their diff as a tool result too; the file-changed event
      // already rendered it, so skip the next tool-call-finished output.
      let suppressResult = false;
      for await (const event of props.engine.events() as AsyncIterable<UIEvent>) {
        switch (event.type) {
          case "user-message":
            append({ kind: "user", text: event.text });
            streaming = null;
            break;
          case "assistant-text-delta":
            // Update the streaming line IMMUTABLY: replace its object (and the
            // array) so Solid's <Index> sees a changed value and re-renders the
            // row. Mutating in place would never repaint — that was the
            // long-standing "assistant reply never appears" bug.
            setLines((prev) => {
              const idx = streaming ? prev.lastIndexOf(streaming) : -1;
              if (idx >= 0 && streaming) {
                streaming = { kind: "assistant", text: streaming.text + event.delta };
                const copy = prev.slice();
                copy[idx] = streaming;
                return copy;
              }
              streaming = { kind: "assistant", text: event.delta };
              return [...prev, streaming];
            });
            break;
          case "tool-call-started":
            append({
              kind: "tool",
              text: `${GLYPH.tool} ${event.toolName} ${truncate(
                JSON.stringify(event.input ?? {}),
                64,
              )}`,
            });
            streaming = null;
            break;
          case "tool-call-finished": {
            if (suppressResult) {
              suppressResult = false;
              break;
            }
            const out =
              typeof event.output === "string" ? event.output : JSON.stringify(event.output);
            for (const t of out.split("\n").filter((l) => l.length).slice(0, 4)) {
              append({ kind: "toolresult", text: `  ${GLYPH.result} ${truncate(t, 72)}` });
            }
            break;
          }
          case "file-changed": {
            suppressResult = true;
            const verb = event.action === "write" ? "wrote" : "edited";
            append({
              kind: "tool",
              text: `${GLYPH.file} ${verb} ${event.path}  +${event.added} -${event.removed}`,
            });
            for (const dl of event.diff ? event.diff.split("\n") : []) {
              const kind = dl.startsWith("+") ? "add" : dl.startsWith("-") ? "del" : "ctx";
              append({ kind, text: dl });
            }
            streaming = null;
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
            pendingPerms.push(event.id);
            append({
              kind: "notice",
              text: `${GLYPH.warn} allow ${event.toolName}? [y]es · [a]lways · [n]o`,
            });
            break;
          case "plan-presented":
            setPlan(event.plan);
            streaming = null;
            break;
          case "subagent-started":
            append({ kind: "subagent", text: `${GLYPH.subagentIn} subagent: ${event.prompt}` });
            break;
          case "subagent-finished":
            append({ kind: "subagent", text: `${GLYPH.subagentOut} subagent done` });
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
          case "notice":
            append({ kind: "notice", text: event.message });
            break;
          case "engine-error":
            append({ kind: "notice", text: `error: ${event.message}` });
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
    if (text === "/exit" || text === "/quit") {
      props.engine.send({ type: "shutdown" });
      process.exit(0);
    }
    // While permission prompts are pending, each input answers the oldest.
    const permId = pendingPerms.shift();
    if (permId) {
      props.engine.send({
        type: "resolve-permission",
        id: permId,
        decision: parsePermissionDecision(text),
      });
      return;
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
    <box flexDirection="column" padding={1} style={{ height: "100%" }}>
      {/* Header — branding, working dir, mode pill, model, and live context. */}
      <box
        border
        borderColor={palette().border}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={palette().accent}>{"◆ vibe-codr"}</text>
          <text fg={palette().muted}>{cwd}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={modeColor(uiMode(), palette())}>{modeLabel(uiMode())}</text>
          <text fg={palette().muted}>{`${headModel()}${headInfo() ? `  ·  ${headInfo()}` : ""}`}</text>
        </box>
      </box>

      <box flexGrow={1} flexDirection="column" marginTop={1}>
        <Show when={lines().length === 0}>
          <text fg={palette().muted}>
            {"  Ask anything to begin.  Shift+Tab switches mode · @file attaches · /help lists commands."}
          </text>
        </Show>
        <Index each={lines()}>
          {(line) => (
            <text fg={colorFor(line().kind, palette())}>
              {prefixFor(line().kind)}
              {line().kind === "assistant" ? renderMarkdown(line().text) : line().text}
            </text>
          )}
        </Index>
      </box>
      <Show when={plan()}>
        <box
          border
          borderColor={palette().plan}
          title="Plan"
          titleColor={palette().plan}
          flexDirection="column"
          marginTop={1}
        >
          <For each={(plan() ?? "").split("\n")}>
            {(row) => <text fg={palette().assistant}>{row || " "}</text>}
          </For>
          <text fg={palette().muted}>Shift+Tab to execute, or /execute to proceed.</text>
        </box>
      </Show>
      <Show when={tasks().length > 0}>
        <box
          border
          borderColor={palette().border}
          title={`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
          titleColor={palette().accent}
          flexDirection="column"
          marginTop={1}
        >
          <For each={tasks()}>
            {(task) => (
              <text fg={taskColor(task.status, palette())}>
                {`${TASK_GLYPH[task.status]} ${task.title}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      {/* Slash-command menu — opens while typing a `/command`. ↑/↓ to highlight,
          Tab to complete, Enter to run, Esc to dismiss. */}
      <Show when={menu().open}>
        <box
          border
          borderColor={palette().accent}
          title={menuView()?.title}
          titleColor={palette().accent}
          flexDirection="column"
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <For each={menuView()?.rows ?? []}>
            {(row) => (
              <text fg={row.active ? palette().accent : palette().muted}>
                {`${row.active ? "❯ " : "  "}${row.text}`}
              </text>
            )}
          </For>
          <Show when={menuView()?.more}>
            <text fg={palette().muted}>{`  ${menuView()?.more}`}</text>
          </Show>
        </box>
      </Show>
      {/* The input border is tinted by mode so plan/execute/yolo is unmistakable
          right where you type; horizontal padding keeps the prompt off the frame. */}
      <box
        border
        borderColor={modeColor(uiMode(), palette())}
        title={modeLabel(uiMode())}
        titleColor={modeColor(uiMode(), palette())}
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          focused
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Ask vibe-codr…  @file to attach · /help · /model <id> · /undo"
        />
      </box>
      <text fg={palette().muted}>
        {"shift+tab mode · @file attach · /help commands · ctrl-c quit"}
      </text>
    </box>
  );
}

/** The dim header detail: context fill, token/cost usage, queue, and goal. */
function headerInfo(
  queued: number,
  usage: SessionUsage,
  ctx: { usedTokens: number; contextWindow: number } | null,
  goal: string | null,
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
  if (goal) parts.push(`★ ${truncate(goal, 28)}`);
  return parts.join(" · ");
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

function colorFor(kind: Line["kind"], p: Palette): string {
  switch (kind) {
    case "user":
      return p.user;
    case "tool":
      return p.tool;
    case "toolresult":
      return p.muted;
    case "notice":
      return p.notice;
    case "subagent":
      return p.subagent;
    case "add":
      return p.add;
    case "del":
      return p.del;
    case "ctx":
      return p.ctx;
    default:
      return p.assistant;
  }
}

function taskColor(status: Task["status"], p: Palette): string {
  return status === "completed"
    ? p.taskDone
    : status === "in_progress"
      ? p.taskActive
      : p.taskPending;
}

function prefixFor(kind: Line["kind"]): string {
  return kind === "user" ? "› " : "";
}

export async function mountApp(engine: EngineClient): Promise<void> {
  render(() => <App engine={engine} />);
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
