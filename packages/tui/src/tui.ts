import * as readline from "node:readline";
import type { EngineClient, EngineCommand } from "@vibe/shared";
import { ansi } from "./ansi.ts";
import { renderHeadless } from "./headless.ts";

/**
 * Start the interactive UI. Tries the OpenTUI app first; if OpenTUI isn't
 * installed (it's an optional native peer dep), falls back to a readline REPL
 * so the agent is always usable interactively.
 */
export async function startTui(engine: EngineClient): Promise<void> {
  try {
    // Non-literal specifier so tsc does not pull the OpenTUI app (an optional
    // native peer dep) into the type program. Resolved by Bun at runtime.
    const appModule = "./app.tsx";
    const mod = (await import(appModule)) as {
      mountApp: (engine: EngineClient) => Promise<void>;
    };
    await mod.mountApp(engine);
  } catch (err) {
    process.stderr.write(
      ansi.dim(`(OpenTUI unavailable, using basic REPL: ${(err as Error).message})\n`),
    );
    await startRepl(engine);
  }
}

/** Map a slash line to an engine command, or null to send as a prompt. */
function slashToCommand(line: string): EngineCommand | null {
  const m = line.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  const name = m[1] ?? "";
  const args = (m[2] ?? "").trim();
  switch (name) {
    case "plan":
      return { type: "set-mode", mode: "plan" };
    case "execute":
      return { type: "set-mode", mode: "execute" };
    case "model":
      return args ? { type: "set-model", model: args } : { type: "run-slash", name, args };
    case "goal":
      return { type: "set-goal", goal: args || null };
    case "compact":
      return { type: "compact" };
    default:
      return { type: "run-slash", name, args };
  }
}

async function startRepl(engine: EngineClient): Promise<void> {
  const snap = engine.snapshot();
  process.stdout.write(
    `${ansi.bold("vibe-codr")} ${ansi.dim(`(${snap.model}, ${snap.mode} mode)`)}\n` +
      ansi.dim("Type a prompt, /plan, /execute, /model <id>, /goal <text>, or /exit.\n\n"),
  );

  // Print engine events in the background.
  void renderHeadless(engine, { showTools: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question(ansi.green("› "), (line) => {
      const trimmed = line.trim();
      if (trimmed === "/exit" || trimmed === "/quit") {
        rl.close();
        return;
      }
      if (trimmed) {
        const cmd = slashToCommand(trimmed);
        if (cmd) engine.send(cmd);
        else engine.send({ type: "submit-prompt", text: trimmed });
      }
      ask();
    });
  ask();

  await new Promise<void>((resolve) => rl.on("close", resolve));
}
