import { parseArgs } from "node:util";
import { loadConfig, type Config } from "@vibe/config";
import { Engine, formatModelList } from "@vibe/core";
import { runOneShot, startTui } from "@vibe/tui";

export const VERSION = "0.0.0";

const HELP = `vibe-codr ${VERSION} — a model-agnostic coding agent for the terminal

USAGE
  vibe [options]                 start the interactive TUI
  vibe -p "<prompt>" [options]   run one prompt headlessly and print the result
  vibe models [options]          list available models for configured providers

OPTIONS
  -p, --prompt <text>   run a single prompt (headless / pipeable)
  -m, --model <id>      model string, e.g. anthropic/claude-opus-4-8, lmstudio/<id>
      --mode <mode>     start mode: plan | execute  (default: execute)
      --cwd <dir>       working directory (default: current)
      --reasoning       print model reasoning to stderr
  -v, --version         print version and exit
  -h, --help            show this help

MODEL STRINGS
  <provider>/<model-id>   anthropic, openai, deepseek, xai, fireworks,
                          baseten, openrouter, lmstudio
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
      reasoning: { type: "boolean" },
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

  const config = await loadConfig({ cwd, overrides });
  const engine = new Engine({ config, cwd });
  await engine.bootstrap();

  // `vibe models` — list available models for configured providers and exit.
  if (positionals[0] === "models") {
    process.stdout.write(`${formatModelList(await engine.listModels())}\n`);
    return 0;
  }

  if (values.prompt) {
    await runOneShot(engine, values.prompt, { showReasoning: values.reasoning });
    return 0;
  }

  await startTui(engine);
  return 0;
}
