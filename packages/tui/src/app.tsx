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
import type { EngineClient, Task, UIEvent } from "@vibe/shared";

interface Line {
  kind: "user" | "assistant" | "tool" | "notice" | "plan" | "subagent";
  text: string;
}

const TASK_GLYPH: Record<Task["status"], string> = {
  completed: "✔",
  in_progress: "▶",
  pending: "○",
};

function App(props: { engine: EngineClient }) {
  const snap = props.engine.snapshot();
  const [lines, setLines] = createSignal<Line[]>([]);
  const [draft, setDraft] = createSignal("");
  const [tasks, setTasks] = createSignal<Task[]>(snap.tasks);
  const [queued, setQueued] = createSignal(0);
  let model = snap.model;
  let mode = snap.mode;
  const [status, setStatus] = createSignal(statusLine(model, mode, 0));

  const append = (line: Line) => setLines((prev) => [...prev, line]);
  const refreshStatus = () => setStatus(statusLine(model, mode, queued()));

  onMount(() => {
    void (async () => {
      let streaming: Line | null = null;
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
            append({ kind: "tool", text: `⚒ ${event.toolName}` });
            streaming = null;
            break;
          case "tasks-updated":
            setTasks(event.tasks);
            break;
          case "queue-changed":
            setQueued(event.pending.length);
            refreshStatus();
            break;
          case "plan-presented":
            append({ kind: "plan", text: `${event.plan}\n— run /execute to proceed` });
            streaming = null;
            break;
          case "subagent-started":
            append({ kind: "subagent", text: `⤷ subagent: ${event.prompt}` });
            break;
          case "subagent-finished":
            append({ kind: "subagent", text: `⤶ subagent done` });
            break;
          case "mode-changed":
            mode = event.mode;
            refreshStatus();
            break;
          case "model-changed":
            model = event.model;
            refreshStatus();
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
    if (text.startsWith("/")) {
      props.engine.send({ type: "run-slash", name: text.slice(1).split(" ")[0]!, args: "" });
    } else {
      props.engine.send({ type: "submit-prompt", text });
    }
  };

  return (
    <box flexDirection="column" padding={1} style={{ height: "100%" }}>
      <box flexGrow={1} flexDirection="column">
        <For each={lines()}>
          {(line) => (
            <text fg={colorFor(line.kind)}>
              {prefixFor(line.kind)}
              {line.text}
            </text>
          )}
        </For>
      </box>
      <Show when={tasks().length > 0}>
        <box border title="Tasks" flexDirection="column">
          <For each={tasks()}>
            {(task) => (
              <text fg={taskColor(task.status)}>
                {`${TASK_GLYPH[task.status]} ${task.title}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <box border title={status()}>
        <input
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Ask vibe-codr…  (/plan, /execute, /model <id>, /goal <text>, /queue)"
        />
      </box>
    </box>
  );
}

function statusLine(model: string, mode: string, queued: number): string {
  const q = queued > 0 ? ` · ${queued} queued` : "";
  return `${model} · ${mode}${q}`;
}

function colorFor(kind: Line["kind"]): string {
  switch (kind) {
    case "user":
      return "#7aa2f7";
    case "tool":
      return "#7dcfff";
    case "notice":
      return "#e0af68";
    case "plan":
      return "#bb9af7";
    case "subagent":
      return "#9ece6a";
    default:
      return "#c0caf5";
  }
}

function taskColor(status: Task["status"]): string {
  return status === "completed"
    ? "#565f89"
    : status === "in_progress"
      ? "#7dcfff"
      : "#c0caf5";
}

function prefixFor(kind: Line["kind"]): string {
  return kind === "user" ? "› " : "";
}

export async function mountApp(engine: EngineClient): Promise<void> {
  render(() => <App engine={engine} />);
  // Keep the process alive while the TUI runs.
  await new Promise<void>(() => {});
}
