import * as readline from "node:readline";
import type { EngineClient } from "@vibe/shared";
import { ansi } from "./ansi.ts";
import { renderHeadless } from "./headless.ts";
import { lineToCommand } from "./slash.ts";

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

async function startRepl(engine: EngineClient): Promise<void> {
  const snap = engine.snapshot();
  process.stdout.write(
    `${ansi.bold("vibecodr")} ${ansi.dim(`(${snap.model}, ${snap.mode} mode)`)}\n` +
      ansi.dim(
        "Type a prompt, /plan, /execute, /model <id>, /goal <text>, /queue, or /exit.\n\n",
      ),
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
      if (trimmed) engine.send(lineToCommand(trimmed));
      ask();
    });
  ask();

  await new Promise<void>((resolve) => rl.on("close", resolve));
}
