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
import { createSignal, onMount, For } from "solid-js";
import type { EngineClient, UIEvent } from "@vibe/shared";

interface Line {
  kind: "user" | "assistant" | "tool" | "notice";
  text: string;
}

function App(props: { engine: EngineClient }) {
  const snap = props.engine.snapshot();
  const [lines, setLines] = createSignal<Line[]>([]);
  const [draft, setDraft] = createSignal("");
  const [status, setStatus] = createSignal(`${snap.model} · ${snap.mode}`);

  const append = (line: Line) => setLines((prev) => [...prev, line]);

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
          case "mode-changed":
            setStatus(`${snap.model} · ${event.mode}`);
            break;
          case "model-changed":
            setStatus(`${event.model} · ${snap.mode}`);
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
      <box border title={status()}>
        <input
          value={draft()}
          onInput={(v: string) => setDraft(v)}
          onSubmit={submit}
          placeholder="Ask vibe-codr…  (/plan, /execute, /model <id>, /goal <text>)"
        />
      </box>
    </box>
  );
}

function colorFor(kind: Line["kind"]): string {
  return kind === "user"
    ? "#7aa2f7"
    : kind === "tool"
      ? "#7dcfff"
      : kind === "notice"
        ? "#e0af68"
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
