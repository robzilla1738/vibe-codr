import { parseArgs } from "node:util";
import { loadConfig, type Config } from "@vibe/config";
import {
  Engine,
  formatModelList,
  loadProjectMemory,
  SessionStore,
  type PersistedSession,
} from "@vibe/core";
import { ProviderRegistry } from "@vibe/providers";
import { runOneShot, startTui } from "@vibe/tui";
import { needsOnboarding, runOnboarding } from "./onboarding.ts";

export const VERSION = "0.0.0";

const HELP = `vibecodr ${VERSION} — a model-agnostic coding agent for the terminal

USAGE
  vibecodr [options]                 start the interactive TUI
  vibecodr -p "<prompt>" [options]   run one prompt headlessly and print the result
  vibecodr models [options]          list available models for configured providers
  vibecodr sessions                  list saved sessions (resume with --resume <id>)

OPTIONS
  -p, --prompt <text>   run a single prompt (headless / pipeable); use - for stdin
  -m, --model <id>      model string, e.g. anthropic/claude-opus-4-8, lmstudio/<id>
      --mode <mode>     start mode: plan | execute  (default: execute)
      --cwd <dir>       working directory (default: current)
      --output-format   one-shot output: text (default) | json
      --reasoning       print model reasoning to stderr
  -c, --continue        resume the most recent session
      --resume <id>     resume a specific session by id
  -v, --version         print version and exit
  -h, --help            show this help

MODEL STRINGS
  <provider>/<model-id>   anthropic, openai, deepseek, xai, minimax, codex,
                          fireworks, baseten, openrouter, lmstudio

IN-SESSION
  Type /help for slash commands (/model /plan /status /config /diff /review …),
  @file to attach file contents, and /exit to quit. Project notes in VIBE.md,
  AGENTS.md or CLAUDE.md are injected into every prompt.
`;

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
  if (values.mode === "plan" || values.mode === "execute") {
    overrides.mode = values.mode;
  }

  // `vibecodr sessions` — list saved sessions and exit (no engine needed).
  if (positionals[0] === "sessions") {
    process.stdout.write(await formatSessions(cwd));
    return 0;
  }

  let config = await loadConfig({ cwd, overrides });

  // First-run setup: if the interactive user has no key for their model's
  // provider, capture keys and reload config before starting. Skipped for
  // headless (-p) and `models`, which surface the normal auth error instead.
  const interactive = !values.prompt && positionals[0] !== "models";
  if (interactive) {
    const registry = new ProviderRegistry();
    if (needsOnboarding(config, registry)) {
      const onboarded = await runOnboarding(config, registry);
      if (onboarded) config = await loadConfig({ cwd, overrides });
    }
  }

  // Resume a persisted session with --continue (latest) or --resume <id>.
  let resume: PersistedSession | undefined;
  if (values.continue || values.resume) {
    const store = new SessionStore(cwd);
    const id = values.resume ?? (await store.latestId());
    const loaded = id ? await store.load(id) : null;
    if (loaded) resume = loaded;
    else process.stderr.write("No session to resume; starting fresh.\n");
  }

  // Inject project memory (VIBE.md / AGENTS.md / CLAUDE.md + user-global notes)
  // into every system prompt so the agent knows the project's conventions.
  const projectMemory = await loadProjectMemory(cwd);

  const engine = new Engine({
    config,
    cwd,
    interactive,
    ...(projectMemory ? { projectMemory } : {}),
    ...(resume ? { resume } : {}),
  });
  await engine.bootstrap();

  // `vibe models` — list available models for configured providers and exit.
  if (positionals[0] === "models") {
    process.stdout.write(`${formatModelList(await engine.listModels())}\n`);
    return 0;
  }

  if (values.prompt !== undefined) {
    const outputFormat = values["output-format"] === "json" ? "json" : "text";
    // `-p -` (or an empty `-p` with piped input) reads the prompt from stdin,
    // so `cat task.md | vibecodr -p -` works for scripting.
    const prompt =
      values.prompt === "-" || values.prompt === ""
        ? (await Bun.stdin.text()).trim()
        : values.prompt;
    await runOneShot(engine, prompt, {
      showReasoning: values.reasoning,
      outputFormat,
    });
    return 0;
  }

  await startTui(engine);
  return 0;
}

/** Render the saved-session list for `vibecodr sessions`. */
export async function formatSessions(cwd: string): Promise<string> {
  const metas = await new SessionStore(cwd).list();
  if (!metas.length) return "No saved sessions.\n";
  const lines = metas.map((m) => {
    const when = new Date(m.updatedAt).toISOString().replace("T", " ").slice(0, 16);
    const cost = m.usage?.costUSD ? ` $${m.usage.costUSD.toFixed(4)}` : "";
    const goal = m.goal ? ` — ${m.goal.slice(0, 60)}` : "";
    return `${m.id}  ${when}  ${m.model}${cost}${goal}`;
  });
  return `${lines.join("\n")}\n`;
}
