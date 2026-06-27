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

  // A pending permission prompt; while set, the next line answers it.
  let pendingPerm: string | null = null;
  void (async () => {
    for await (const event of engine.events()) {
      if (event.type === "permission-request") {
        pendingPerm = event.id;
        process.stdout.write(
          `\n${ansi.yellow("⚠ permission")} ${ansi.bold(event.toolName)} wants to run ` +
            `${ansi.dim(truncate(JSON.stringify(event.input ?? {}), 100))}\n` +
            ansi.dim("  Allow? [y]es · [a]lways · [n]o\n"),
        );
      }
    }
  })();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question(ansi.green("› "), (line) => {
      const trimmed = line.trim();
      if (pendingPerm) {
        const decision = parseDecision(trimmed);
        engine.send({ type: "resolve-permission", id: pendingPerm, decision });
        pendingPerm = null;
        ask();
        return;
      }
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

/** Map a y/a/n answer to a permission decision (default deny on anything else). */
function parseDecision(input: string): "once" | "always" | "deny" {
  const c = input.trim().toLowerCase()[0];
  if (c === "y") return "once";
  if (c === "a") return "always";
  return "deny";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
