/**
 * OpenTUI (Solid) interactive app — the primary, polished UI.
 *
 * This file is excluded from `tsc` typecheck (see tsconfig.json) because it
 * depends on `@opentui/core` / `@opentui/solid` / `solid-js`, which are
 * optional native peer deps. It is dynamically imported by `startTui`; if the
 * import fails, the readline REPL in `tui.ts` takes over. Once OpenTUI is
 * installed, adjust the component imports below to match its current API.
 */
import { render } from "@opentui/solid";
import { createSignal, onMount, For, Show } from "solid-js";
import type { EngineClient, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";
import { TASK_GLYPH, formatUsage } from "./headless.ts";
import { GLYPH } from "./glyphs.ts";
import { renderMarkdown } from "./markdown.ts";
import { getTheme, type Palette } from "./themes.ts";

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

function App(props: { engine: EngineClient }) {
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
  const [status, setStatus] = createSignal(
    statusLine(model, mode, approvals, goal, 0, usage, ctx),
  );
  const [footer, setFooter] = createSignal(footerLine(usage));

  const append = (line: Line) => setLines((prev) => [...prev, line]);
  const refreshStatus = () => {
    setStatus(statusLine(model, mode, approvals, goal, queued(), usage, ctx));
    setFooter(footerLine(usage));
  };

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
            if (!streaming) {
              streaming = { kind: "assistant", text: "" };
              append(streaming);
            }
            streaming.text += event.delta;
            setLines((prev) => [...prev]);
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

  const submit = () => {
    const text = draft().trim();
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

  return (
    <box flexDirection="column" padding={1} style={{ height: "100%" }}>
      <box flexGrow={1} flexDirection="column">
        <For each={lines()}>
          {(line) => (
            <text fg={colorFor(line.kind, palette())}>
              {prefixFor(line.kind)}
              {line.kind === "assistant" ? renderMarkdown(line.text) : line.text}
            </text>
          )}
        </For>
      </box>
      <Show when={plan()}>
        <box border title="Plan" flexDirection="column" marginTop={1}>
          <For each={(plan() ?? "").split("\n")}>
            {(row) => <text fg={palette().assistant}>{row || " "}</text>}
          </For>
          <text fg={palette().muted}>Run /execute to proceed.</text>
        </box>
      </Show>
      <Show when={tasks().length > 0}>
        <box
          border
          title={`Tasks · ${tasks().filter((t) => t.status === "completed").length}/${tasks().length}`}
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
      {/* Horizontal padding keeps the prompt off the border; a bordered
          single-row input is already vertically centered between the frame. */}
      <box border title={status()} marginTop={1} paddingLeft={1} paddingRight={1}>
        <input
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Ask vibe-codr…  @file to attach · /help · /plan · /model <id> · /undo"
        />
      </box>
      <text fg={palette().muted}>{footer()}</text>
    </box>
  );
}

/** The dim hint under the input: usage when present, else key shortcuts. */
function footerLine(usage: SessionUsage): string {
  return usage.totalTokens > 0
    ? `${formatUsage(usage)} · /help for commands`
    : "/help for commands · /plan to plan · ctrl-c to quit";
}

function statusLine(
  model: string,
  mode: string,
  approvals: string,
  goal: string | null,
  queued: number,
  usage: SessionUsage,
  ctx: { usedTokens: number; contextWindow: number } | null,
): string {
  const g = goal ? ` · ★ ${truncate(goal, 32)}` : "";
  const q = queued > 0 ? ` · ${queued} queued` : "";
  const u = usage.totalTokens > 0 ? ` · ${formatUsage(usage)}` : "";
  const pct =
    ctx && ctx.contextWindow > 0
      ? Math.min(100, Math.round((ctx.usedTokens / ctx.contextWindow) * 100))
      : 0;
  // Only surface context fill once it's meaningful (≥1%); avoids "ctx 0%" noise
  // at the very start of a session.
  const c = pct >= 1 ? ` · ctx ${pct}%` : "";
  return `${model} · ${mode} · ${approvals}${g}${q}${c}${u}`;
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
