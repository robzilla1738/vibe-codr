import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineClient } from "@vibe/shared";
import { ansi } from "./ansi.ts";
import { GLYPH } from "./glyphs.ts";
import { renderHeadless } from "./headless.ts";
import { lineToCommands, routePendingPermLine } from "./slash.ts";
import { permissionPreview, toolLabel } from "./tool-icons.ts";

/**
 * Resolve the OpenTUI app module to import at runtime, mirroring
 * `resolveEngineWorkerPath` in the CLI:
 *   (1) npm bundle: a pre-built `app.js` sibling of the bundled `vibecodr.js`
 *       (shipped in the npm package — `app.tsx` isn't included because it's a
 *       non-literal dynamic import that `bun build` can't resolve).
 *   (2) compiled binary: a pre-built `vibecodr-app.js` sibling of the binary.
 *   (3) source/dev: the in-repo `app.tsx` (transpiled on the fly by Bun's
 *       runtime after the Solid transform plugin is registered).
 * Returns the module specifier to dynamic-import, or null when none exists.
 */
function resolveAppPath(): string | null {
  const here = import.meta.dir;
  // (1) npm bundle — app.js shipped next to vibecodr.js
  const npmApp = join(here, "app.js");
  if (existsSync(npmApp)) return npmApp;
  // (2) compiled binary — vibecodr-app.js sibling of the executable
  const execDir = dirname(process.execPath);
  for (const name of ["vibecodr-app.js", "vibecodr-app"]) {
    const binarySibling = join(execDir, name);
    if (existsSync(binarySibling)) return binarySibling;
  }
  // (3) source/dev — app.tsx in the same package
  const src = join(here, "app.tsx");
  if (existsSync(src)) return src;
  return null;
}

/**
 * Start the interactive UI. Tries the OpenTUI app first; if OpenTUI isn't
 * installed (it's an optional native peer dep), falls back to a readline REPL
 * so the agent is always usable interactively.
 */
export async function startTui(engine: EngineClient): Promise<void> {
  try {
    // app.tsx is Solid JSX. Register OpenTUI's Solid transform plugin before
    // importing it, otherwise Bun compiles the JSX with its default (React)
    // runtime — which isn't installed — and the import throws. Registering at
    // runtime (rather than via bunfig `preload`) keeps the rich UI working no
    // matter which directory `vibecodr` is launched from.
    const preloadModule = "@opentui/solid/preload";
    await import(preloadModule);
    // Resolve the app module: a pre-built bundle (npm/binary) or the source
    // .tsx (dev). Non-literal specifiers keep these optional native peer deps
    // out of the tsc program and out of the main bundle.
    const appPath = resolveAppPath();
    if (!appPath) throw new Error("OpenTUI app module not found (app.js / app.tsx)");
    const mod = (await import(appPath)) as {
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
      ansi.dim("Type a prompt to begin · /help for commands · @file to attach · /exit to quit\n\n"),
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
        // The friendly label + a content preview (full command / edit -/+ lines /
        // write head) — same treatment as the rich TUI card, so the REPL user
        // isn't approving off raw truncated JSON.
        const preview = permissionPreview(event.toolName, event.input);
        const previewText = preview
          ? `${preview.lines.map((l) => `  ${ansi.dim(l)}`).join("\n")}\n`
          : "";
        process.stdout.write(
          `\n${ansi.yellow(`${GLYPH.warn} permission`)} ${ansi.bold(toolLabel(event.toolName, event.input))}\n` +
            previewText +
            ansi.dim(
              "  Allow? y once · a always (session) · p always (project) · n deny — or type why to deny with feedback\n",
            ),
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
      // A slash line while a permission is pending is a COMMAND (e.g. /clear to
      // escape a stuck card), not an answer — route it below. Only a non-slash
      // line answers the oldest pending permission.
      const routed = pendingPerms.length ? routePendingPermLine(line.trim()) : undefined;
      if (routed?.kind === "perm") {
        const permId = pendingPerms.shift()!;
        engine.send({
          type: "resolve-permission",
          id: permId,
          decision: routed.decision,
          ...(routed.feedback ? { feedback: routed.feedback } : {}),
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
      if (trimmed) for (const cmd of lineToCommands(trimmed)) engine.send(cmd);
      ask();
    });
  ask();

  await new Promise<void>((resolve) => rl.on("close", resolve));
}
