import { basename } from "node:path";
import { loadEvalFixture, runEvalMatrix, type EvalMatrixResultV1, type RunEvalOptions } from "@vibe/eval";

export async function runEvalCommand(options: {
  fixturePath?: string;
  models?: string;
  profiles?: string;
  samples?: string;
  keepCheckouts?: boolean;
  agentCommand?: RunEvalOptions["agentCommand"];
}): Promise<EvalMatrixResultV1> {
  if (!options.fixturePath) throw new Error("Usage: vibe eval run <fixture.json> --model <provider/model>");
  const models = csv(options.models);
  if (!models.length) throw new Error("Eval runs require --model <provider/model> (comma-separated matrices are supported)");
  const profiles = csv(options.profiles ?? "default");
  const samples = options.samples === undefined ? 1 : Number(options.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 50) throw new Error("--samples must be an integer from 1 to 50");
  const fixture = await loadEvalFixture(options.fixturePath);
  return runEvalMatrix(fixture, {
    models, profiles, samples, keepCheckouts: options.keepCheckouts,
    agentCommand: options.agentCommand ?? defaultAgentCommand,
  });
}

function defaultAgentCommand(cell: Parameters<RunEvalOptions["agentCommand"]>[0]): string[] {
  const executable = process.execPath;
  const prefix = basename(executable).toLowerCase().startsWith("bun") && process.argv[1]
    ? [executable, process.argv[1]]
    : [executable];
  return [...prefix, "-p", cell.fixture.prompt, "--cwd", cell.cwd, "--model", cell.model,
    "--mode", cell.profile === "plan" ? "plan" : cell.profile === "yolo" ? "yolo" : "execute",
    "--strict-goal", "--output-format", "json"];
}

function csv(value?: string): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}
