import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, defaultConfig, type Config } from "@vibe/config";
import {
  Engine,
  formatModelList,
  handleCrash,
  loadProjectMemory,
  SessionStore,
  type PersistedSession,
} from "@vibe/core";
import { checkForUpdate, isNewer, readUpdateCache } from "@vibe/core";
import { ProviderRegistry } from "@vibe/providers";
import type { EngineClient } from "@vibe/shared";
import { runOneShot, startTui } from "@vibe/tui";
import { createWorkerEngineClient } from "./engine-worker-client.ts";
import { needsOnboarding, runOnboarding } from "./onboarding.ts";
import { upgradeInstructions } from "./upgrade.ts";
import { VERSION } from "./version.ts";

// Re-export so existing importers of `@vibe/cli`'s VERSION keep working; the
// literal now lives in ./version.ts (stamped at release by set-version.ts).
export { VERSION };

/**
 * Locate the engine worker entry. Order:
 *   1. Sibling of this executable named `vibecodr-engine-worker` — the
 *      second `bun build --compile` target shipped alongside the main binary.
 *   2. The in-repo source entry `packages/cli/src/engine-worker-entry.ts`
 *      discoverable relative to this file (dev / `bun packages/cli/bin/vibecodr.ts`).
 * Returns null when neither exists — the host then falls back to an in-process
 * `Engine` (no worker-host isolation; the cooperative-yield gate alone bounds
 * the freeze). `VIBE_NO_WORKER=1` short-circuits to that fallback too.
 */
function resolveEngineWorkerPath(): string | null {
  // (1) Compiled binary: the worker build target shipped as a sibling of the
  //     main executable. `process.execPath` is the binary itself.
  const binarySibling = join(dirname(process.execPath), "vibecodr-engine-worker");
  if (existsSync(binarySibling)) return binarySibling;
  // (2) npm install: the worker entry shipped next to `vibecodr.js` as a
  //     `--target=bun` bundle. `import.meta.dir` is the JS file's directory
  //     (the bundling inlines everything so no sibling imports dangle).
  const here = import.meta.dir;
  const npmSibling = join(here, "vibecodr-engine-worker.js");
  if (existsSync(npmSibling)) return npmSibling;
  // (3) Source/dev: the in-repo TS entry discoverable next to this file.
  const src = join(here, "engine-worker-entry.ts");
  if (existsSync(src)) return src;
  return null;
}

const HELP = `vibecodr ${VERSION} — a model-agnostic coding agent for the terminal

USAGE
  vibecodr [options]                 start the interactive TUI
  vibecodr -p "<prompt>" [options]   run one prompt headlessly and print the result
  vibecodr models [options]          list available models for configured providers
  vibecodr sessions                  list saved sessions (resume with --resume <id>)
  vibecodr setup                     run the guided provider/model setup (alias: login)
  vibecodr upgrade                   print how to update to the latest version

OPTIONS
  -p, --prompt <text>   run a single prompt (headless / pipeable); use - for stdin
  -m, --model <id>      model string, e.g. anthropic/claude-opus-4-8, lmstudio/<id>
      --mode <mode>     start mode: plan | execute | yolo  (default: execute)
      --cwd <dir>       working directory (default: current)
      --output-format   one-shot output: text (default) | json
      --reasoning       print model reasoning to stderr
  -c, --continue        resume the most recent session
      --resume <id>     resume a specific session by id
  -v, --version         print version and exit
  -h, --help            show this help

MODEL STRINGS
  <provider>/<model-id>   anthropic, openai, codex, google, zai, moonshot,
                          alibaba, deepseek, xai, minimax, groq, mistral,
                          cerebras, together, fireworks, baseten, huggingface,
                          openrouter, perplexity, ollama, lmstudio, custom

IN-SESSION
  Type /help for slash commands (/model /plan /status /config /diff /review …),
  @file to attach file contents, and /exit to quit. Project notes in VIBE.md,
  AGENTS.md or CLAUDE.md are injected into every prompt.
`;

export function applyCliModeOverride(overrides: Partial<Config>, mode: string): boolean {
  // CLI --mode is the same user-facing 3-way projection as the TUI mode chip:
  // plan = read-only gated baseline, execute = mutating but gated, yolo =
  // mutating with approvals off. Therefore explicit plan/execute must clear a
  // persisted approvalMode:auto; otherwise `--mode execute` in a yolo-default
  // config still starts unattended.
  if (mode === "plan") {
    overrides.mode = "plan";
    overrides.approvalMode = "ask";
    return true;
  }
  if (mode === "execute") {
    overrides.mode = "execute";
    overrides.approvalMode = "ask";
    return true;
  }
  if (mode === "yolo") {
    overrides.mode = "execute";
    overrides.approvalMode = "auto";
    return true;
  }
  return false;
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      mode: { type: "string" },
      cwd: { type: "string" },
      "output-format": { type: "string" },
      reasoning: { type: "boolean" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.version) {
    process.stdout.write(`vibe-codr ${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const cwd = values.cwd ?? process.cwd();
  const overrides: Partial<Config> = {};
  if (values.model) overrides.model = values.model;
  if (values.mode !== undefined) {
    // Error on an unrecognized --mode rather than silently defaulting to execute
    // (a `--mode plann` typo would otherwise run in the wrong mode with no signal).
    if (!applyCliModeOverride(overrides, values.mode)) {
      process.stderr.write(`vibecodr: invalid --mode "${values.mode}" (expected "plan", "execute", or "yolo")\n`);
      return 1;
    }
  }
  if (values["output-format"] !== undefined && values["output-format"] !== "json" && values["output-format"] !== "text") {
    process.stderr.write(`vibecodr: invalid --output-format "${values["output-format"]}" (expected "json" or "text")\n`);
    return 1;
  }

  // `vibecodr sessions` — list saved sessions and exit (no engine needed).
  if (positionals[0] === "sessions") {
    process.stdout.write(await formatSessions(cwd));
    return 0;
  }

  // `vibecodr upgrade` — print channel-appropriate update instructions and exit.
  // It PRINTS (never self-mutates) — honest and simple: the channel is detected
  // from how this process was launched (compiled binary vs a bun runtime).
  if (positionals[0] === "upgrade") {
    process.stdout.write(`${upgradeInstructions({ execPath: process.execPath, version: VERSION })}\n`);
    return 0;
  }

  const isSetup = positionals[0] === "setup" || positionals[0] === "login";
  let config: Config;
  try {
    config = await loadConfig({ cwd, overrides });
  } catch (err) {
    // `setup` must stay reachable even when the on-disk config is invalid —
    // that's the command meant to repair it. Fall back to defaults.
    if (!isSetup) throw err;
    process.stderr.write(
      `Existing config is invalid (${(err as Error).message}); starting setup from defaults.\n`,
    );
    config = defaultConfig();
  }

  // `vibecodr setup` (alias `login`) — (re)run the guided setup on demand, e.g.
  // to switch providers or add an Ollama Cloud key, then exit.
  if (isSetup) {
    const ok = await runOnboarding(config, new ProviderRegistry());
    if (!ok) process.stderr.write("Setup needs an interactive terminal.\n");
    return ok ? 0 : 1;
  }

  // First-run setup: if the interactive user has no key for their model's
  // provider, capture keys and reload config before starting. Skipped for
  // headless (-p, including `-p ""`/`-p -` stdin forms) and `models`, which
  // surface the normal auth error instead. Gate on `=== undefined` so an empty
  // `-p ""` (pipe form) doesn't fall into interactive onboarding.
  const interactive = values.prompt === undefined && positionals[0] !== "models";
  let onboardingRan = false;
  if (interactive) {
    const registry = new ProviderRegistry();
    if (needsOnboarding(config, registry)) {
      const onboarded = await runOnboarding(config, registry);
      if (onboarded) {
        onboardingRan = true;
        // Onboarding just wrote the user's chosen provider + model to disk. A
        // stale `-m` override (whose provider may be exactly the one they
        // couldn't configure) must NOT clobber that fresh choice on reload, or the
        // run fails with "no key" right after a successful setup.
        delete overrides.model;
        config = await loadConfig({ cwd, overrides });
      }
    }
  }

  // Resume a persisted session with --continue (latest) or --resume <id>.
  let resume: PersistedSession | undefined;
  if (values.continue || values.resume) {
    const store = new SessionStore(cwd);
    const id = values.resume ?? (await store.latestId());
    const loaded = id ? await store.load(id) : null;
    if (loaded) {
      resume = loaded;
      for (const warning of loaded.warnings ?? []) {
        process.stderr.write(`Warning: ${warning}\n`);
      }
    } else process.stderr.write("No session to resume; starting fresh.\n");
  }

  // Inject project memory (VIBE.md / AGENTS.md / CLAUDE.md + user-global notes)
  // into every system prompt so the agent knows the project's conventions.
  const projectMemory = await loadProjectMemory(cwd);

  // The shared Engine-construction shape used by every branch below. The TUI
  // path forwards this verbatim to the worker entry (`engine-worker-entry.ts`),
  // which constructs `new Engine({...})` exactly as the in-process branches do
  // — keeping bootstrap/lifecycle identical across hostings. The interactive
  // (-p / `models` excluded) TUI is the only path that BENEFITS from the worker
  // (single-shot-and-list paths are throughput-sensitive and have no real-time
  // consumer to starve — they stay in-process with no serialization tax).
  const engineOpts = {
    config,
    cwd,
    interactive,
    ...(projectMemory ? { projectMemory } : {}),
    ...(resume ? { resume } : {}),
    // Explicit flags override a resumed session's saved model/mode — but NOT when
    // onboarding just configured a (possibly different) provider/model above.
    ...(values.model && !onboardingRan ? { modelOverride: values.model } : {}),
    ...(overrides.mode ? { modeOverride: overrides.mode } : {}),
  };

  // `vibe models` — list available models for configured providers and exit.
  // Stays in-process: it doesn't stream UI events and gains nothing from the
  // worker's freeze fix. Heavy MCP/recon bootstrap is preserved as before.
  if (positionals[0] === "models") {
    const engine = new Engine(engineOpts);
    await engine.bootstrap();
    process.stdout.write(`${formatModelList(await engine.listModels())}\n`);
    await engine.finalize();
    return 0;
  }

  // Headless `-p` path — output only, no real-time consumer to starve. Keep
  // in-process to avoid per-event structured-clone tax on a single-shot run.
  if (values.prompt !== undefined) {
    const engine = new Engine(engineOpts);
    await engine.bootstrap();
    const outputFormat = values["output-format"] === "json" ? "json" : "text";
    // `-p -` (or an empty `-p` with piped input) reads the prompt from stdin,
    // so `cat task.md | vibecodr -p -` works for scripting. On a TTY with no
    // pipe, `Bun.stdin.text()` would block on EOF (looks like a hang) — error
    // with a hint instead, since a `-p ""` typo is the likely trigger.
    const wantsStdin = values.prompt === "-" || values.prompt === "";
    if (wantsStdin && process.stdin.isTTY) {
      process.stderr.write(
        'vibecodr: -p reads the prompt from stdin here, but stdin is a terminal (no piped input). ' +
          'Pipe input (`cat task.md | vibecodr -p -`) or pass the prompt directly (`vibecodr -p "…"`).\n',
      );
      await engine.finalize();
      return 1;
    }
    const prompt = wantsStdin ? (await Bun.stdin.text()).trim() : values.prompt;
    const ok = await runOneShot(engine, prompt, {
      showReasoning: values.reasoning,
      outputFormat,
    });
    // Finalize (write the session digest when enabled, then tear down) before exit.
    await engine.finalize();
    // Propagate failure so `vibecodr -p … && next` and CI behave correctly.
    return ok ? 0 : 1;
  }

  // Quiet, non-blocking update hint — interactive TUI path only. We only READ the
  // 24h cache here (instant, no network) so startup never blocks, then kick off a
  // silent background refresh that seeds the cache for the next launch. Gated by
  // config `update.check` + `$VIBE_NO_UPDATE_CHECK` inside the core helpers.
  await maybePrintUpdateHint(config);

  // Interactive TUI. Default to the worker-host `EngineClient` so an engine
  // burst can never again starve paint/stdin (the freeze root cause — see
  // `engine-worker-client.ts`). `VIBE_NO_WORKER=1` OR a missing worker entry
  // (e.g. an incomplete release tarball) silently fall back to the in-process
  // `Engine` so a packaging hiccup never bricks the CLI. In that mode the
  // cooperative-yield gate on `app.tsx`'s `for await` (Option B) alone bounds
  // the freeze.
  const wantWorker = !process.env.VIBE_NO_WORKER;
  const workerPath = wantWorker ? resolveEngineWorkerPath() : null;

  let client: EngineClient;
  if (workerPath) {
    client = await createWorkerEngineClient({
      workerPath,
      workerData: engineOpts,
      onFatal: (message) => {
        // Workers can't `process.exit` the parent nor restore its raw-mode
        // stdin — defer to the in-process `handleCrash`, which restores the
        // terminal, writes a redacted crash log, and exits 1. Same path a
        // `uncaughtException` on the main thread would take.
        handleCrash("engine-worker-fatal", new Error(message), { version: VERSION });
      },
    });
  } else {
    const engine = new Engine(engineOpts);
    await engine.bootstrap();
    // session-start for first-paint identity; EventBus history (BUG-085)
    // delivers bootstrap notices to the TUI when it later subscribes.
    engine.start();
    client = engine;
  }

  await startTui(client);
  // `client.finalize?.()` covers both: the worker client terminates the
  // Worker and awaits its finalize handshake; the in-process Engine runs its
  // own teardown. Optional `?.()` because the EngineClient interface marks
  // finalize optional (tests pass a mock without it).
  await client.finalize?.();
  return 0;
}

/** Print a one-line "update available" hint from the cached check, then refresh
 * the cache in the background for next time. Never throws, never blocks on IO. */
async function maybePrintUpdateHint(config: Config): Promise<void> {
  // Honor the opt-out exactly as the core check does — the hint is the check's
  // user-visible surface, so it must not print when checking is disabled.
  if (!config.update.check || process.env.VIBE_NO_UPDATE_CHECK) return;
  try {
    const cached = await readUpdateCache();
    if (cached && isNewer(VERSION, cached.latest)) {
      process.stderr.write(
        `\x1b[2mUpdate available: ${VERSION} → ${cached.latest}. Run \`vibe upgrade\` for instructions.\x1b[0m\n`,
      );
    }
  } catch {
    // A missing/corrupt cache is not an error — silently skip the hint.
  }
  // Fire-and-forget: refresh the cache (respects gating + TTL + 3s timeout).
  void checkForUpdate({ current: VERSION, enabled: config.update.check }).catch(() => {});
}

/** Render the saved-session list for `vibecodr sessions`. */
export async function formatSessions(cwd: string): Promise<string> {
  const metas = await new SessionStore(cwd).list();
  // BUG-074: skip incomplete/corrupt meta rows instead of throwing on .length.
  const rows = metas.filter(
    (m): m is typeof m & { id: string; model: string } =>
      typeof m?.id === "string" &&
      m.id.length > 0 &&
      typeof m?.model === "string",
  );
  if (!rows.length) return "No saved sessions.\n";
  // Align the id and model columns so timestamps, costs, and goals line up.
  const idWidth = Math.max(...rows.map((m) => m.id.length));
  const modelWidth = Math.max(...rows.map((m) => m.model.length));
  const lines = rows.map((m) => {
    const when = new Date(m.updatedAt ?? 0).toISOString().replace("T", " ").slice(0, 16);
    const cost = m.usage?.costUSD ? `$${m.usage.costUSD.toFixed(4)}` : "";
    const goal = m.goal ? `  — ${m.goal.slice(0, 60)}` : "";
    return `${m.id.padEnd(idWidth)}  ${when}  ${m.model.padEnd(modelWidth)}  ${cost.padEnd(9)}${goal}`.trimEnd();
  });
  return `${lines.join("\n")}\n`;
}
