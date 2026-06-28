import * as readline from "node:readline";
import type { EngineClient } from "@vibe/shared";
import { ansi } from "./ansi.ts";
import { renderHeadless } from "./headless.ts";
import { lineToCommand, parsePermissionDecision } from "./slash.ts";

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
    `${ansi.bold("◆ vibecodr")} ${ansi.dim(`— ${snap.model} · ${snap.mode} mode`)}\n` +
      ansi.dim(
        "Type a prompt to begin. /help for commands · @file to attach · /exit to quit.\n\n",
      ),
  );

  // Print engine events in the background.
  void renderHeadless(engine, { showTools: true });

  // Pending permission prompts (FIFO) — while non-empty, each line answers the
  // oldest, so parallel side-effecting tool calls in one step don't get stuck.
  const pendingPerms: string[] = [];
  void (async () => {
    for await (const event of engine.events()) {
      if (event.type === "permission-request") {
        pendingPerms.push(event.id);
        process.stdout.write(
          `\n${ansi.yellow("⚠ permission")} ${ansi.bold(event.toolName)} wants to run ` +
            `${ansi.dim(truncate(JSON.stringify(event.input ?? {}), 100))}\n` +
            ansi.dim("  Allow? [y]es · [a]lways · [n]o\n"),
        );
      }
    }
  })();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl-C aborts the active turn (instead of killing the process); pressing it
  // again at an idle prompt exits.
  rl.on("SIGINT", () => {
    if (engine.snapshot().busy) {
      engine.send({ type: "abort" });
      process.stdout.write(ansi.dim("\n^C — aborting current turn\n"));
      rl.prompt();
    } else {
      rl.close();
    }
  });

  // Accumulates lines for multi-line input (each non-final line ends with `\`).
  let buffer: string[] = [];
  const ask = () =>
    rl.question(buffer.length ? ansi.dim("… ") : ansi.green("› "), (line) => {
      const permId = pendingPerms.shift();
      if (permId) {
        engine.send({
          type: "resolve-permission",
          id: permId,
          decision: parsePermissionDecision(line.trim()),
        });
        ask();
        return;
      }
      // A trailing backslash continues onto the next line.
      if (line.endsWith("\\")) {
        buffer.push(line.slice(0, -1));
        ask();
        return;
      }
      const full = (buffer.length ? `${buffer.join("\n")}\n` : "") + line;
      buffer = [];
      const trimmed = full.trim();
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
