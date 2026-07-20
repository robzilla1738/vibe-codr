import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface EvalFixtureV1 {
  schemaVersion: 1;
  id: string;
  repository: { source: string; revision?: string; setupCommands?: string[] };
  prompt: string;
  acceptanceCommands: string[];
  allowedScope: string[];
  expectedArtifacts: string[];
  timeoutMs?: number;
}

export interface EvalCellV1 {
  fixtureId: string;
  model: string;
  profile: string;
  startedAt: number;
  durationMs: number;
  completionStatus: "verified" | "met-unverified" | "paused" | "unmet" | "runtime-failure";
  acceptancePassed: boolean;
  scopePassed: boolean;
  artifactsPassed: boolean;
  changedFiles: string[];
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  traceRunId?: string;
  score: number;
  error?: string;
}

export interface EvalMatrixResultV1 {
  schemaVersion: 1;
  fixtureId: string;
  results: EvalCellV1[];
  strategyStatistics: Array<{
    model: string;
    profile: string;
    samples: number;
    meanScore?: number;
    eligibleForRouting: false;
  }>;
}

export interface RunEvalOptions {
  models: string[];
  profiles?: string[];
  samples?: number;
  keepCheckouts?: boolean;
  agentCommand: (cell: { cwd: string; fixture: EvalFixtureV1; model: string; profile: string }) => string[];
  now?: () => number;
}

const MAX_OUTPUT = 1_048_576;
const MIN_STRATEGY_SAMPLES = 5;

export async function loadEvalFixture(path: string): Promise<EvalFixtureV1> {
  return parseEvalFixture(JSON.parse(await readFile(path, "utf8")));
}

export function parseEvalFixture(value: unknown): EvalFixtureV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Eval fixture must be an object");
  const input = value as Record<string, unknown>;
  const exact = ["schemaVersion", "id", "repository", "prompt", "acceptanceCommands", "allowedScope", "expectedArtifacts", "timeoutMs"];
  rejectUnknown(input, exact, "fixture");
  if (input.schemaVersion !== 1) throw new Error("Unsupported eval fixture schemaVersion");
  const repository = object(input.repository, "repository");
  rejectUnknown(repository, ["source", "revision", "setupCommands"], "repository");
  const fixture: EvalFixtureV1 = {
    schemaVersion: 1,
    id: boundedString(input.id, "id", 120),
    repository: {
      source: boundedString(repository.source, "repository.source", 4_096),
      ...(repository.revision === undefined ? {} : { revision: boundedString(repository.revision, "repository.revision", 240) }),
      ...(repository.setupCommands === undefined ? {} : { setupCommands: strings(repository.setupCommands, "repository.setupCommands", 32, 4_096) }),
    },
    prompt: boundedString(input.prompt, "prompt", 100_000),
    acceptanceCommands: strings(input.acceptanceCommands, "acceptanceCommands", 64, 4_096),
    allowedScope: paths(input.allowedScope, "allowedScope"),
    expectedArtifacts: paths(input.expectedArtifacts, "expectedArtifacts"),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: boundedInt(input.timeoutMs, "timeoutMs", 1_000, 3_600_000) }),
  };
  if (!fixture.acceptanceCommands.length && !fixture.expectedArtifacts.length) {
    throw new Error("Eval fixture needs an acceptance command or expected artifact");
  }
  return Object.freeze(fixture);
}

export async function runEvalMatrix(fixture: EvalFixtureV1, options: RunEvalOptions): Promise<EvalMatrixResultV1> {
  const models = uniqueNonEmpty(options.models, "models");
  const profiles = uniqueNonEmpty(options.profiles ?? ["default"], "profiles");
  const samples = boundedInt(options.samples ?? 1, "samples", 1, 50);
  const results: EvalCellV1[] = [];
  for (const model of models) for (const profile of profiles) for (let sample = 0; sample < samples; sample++) {
    results.push(await runCell(fixture, model, profile, options));
  }
  const strategyStatistics = [...new Set(results.map((item) => `${item.model}\0${item.profile}`))].map((key) => {
    const [model, profile] = key.split("\0");
    const cells = results.filter((item) => item.model === model && item.profile === profile);
    return {
      model: model!, profile: profile!, samples: cells.length,
      ...(cells.length < MIN_STRATEGY_SAMPLES ? {} : { meanScore: cells.reduce((sum, item) => sum + item.score, 0) / cells.length }),
      eligibleForRouting: false as const,
    };
  });
  return { schemaVersion: 1, fixtureId: fixture.id, results, strategyStatistics };
}

async function runCell(fixture: EvalFixtureV1, model: string, profile: string, options: RunEvalOptions): Promise<EvalCellV1> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const root = await mkdtemp(join(tmpdir(), `vibe-eval-${safeName(fixture.id)}-`));
  const cwd = join(root, "repo");
  let completionStatus: EvalCellV1["completionStatus"] = "runtime-failure";
  let acceptancePassed = false;
  let scopePassed = false;
  let artifactsPassed = false;
  let changedFiles: string[] = [];
  let toolErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let traceRunId: string | undefined;
  let error: string | undefined;
  try {
    await checked(["git", "clone", "--quiet", "--no-hardlinks", fixture.repository.source, cwd], root, fixture.timeoutMs);
    if (fixture.repository.revision) await checked(["git", "checkout", "--quiet", fixture.repository.revision], cwd, fixture.timeoutMs);
    for (const command of fixture.repository.setupCommands ?? []) await checked(shell(command), cwd, fixture.timeoutMs);
    await checked(["git", "add", "-A"], cwd, fixture.timeoutMs);
    await checked(["git", "-c", "user.name=Vibe Eval", "-c", "user.email=eval@vibe.invalid", "commit", "--quiet", "--allow-empty", "-m", "vibe eval setup"], cwd, fixture.timeoutMs);
    const agent = await checked(options.agentCommand({ cwd, fixture, model, profile }), cwd, fixture.timeoutMs ?? 30 * 60_000, true);
    const evidence = lastJsonObject(agent.stdout);
    completionStatus = completion(evidence?.goalCompletionStatus, agent.exitCode);
    toolErrors = numberField(evidence, "toolErrors");
    inputTokens = numberField(evidence, "inputTokens");
    outputTokens = numberField(evidence, "outputTokens");
    costUSD = numberField(evidence, "costUSD");
    traceRunId = stringField(evidence, "runId");
    changedFiles = statusPaths((await checked(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd, fixture.timeoutMs)).stdout);
    scopePassed = changedFiles.every((path) => fixture.allowedScope.some((scope) => matchesScope(path, scope)));
    artifactsPassed = (await Promise.all(fixture.expectedArtifacts.map((path) => stat(join(cwd, path)).then(() => true, () => false)))).every(Boolean);
    acceptancePassed = true;
    for (const command of fixture.acceptanceCommands) {
      const result = await checked(shell(command), cwd, fixture.timeoutMs, true);
      if (result.exitCode !== 0) { acceptancePassed = false; error = bounded(result.stderr || result.stdout || "acceptance command failed"); break; }
    }
  } catch (cause) {
    error = bounded(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (!options.keepCheckouts) await rm(root, { recursive: true, force: true });
  }
  const score = Math.round((completionStatus === "verified" ? 40 : completionStatus === "met-unverified" ? 15 : 0)
    + (acceptancePassed ? 25 : 0) + (scopePassed ? 20 : 0) + (artifactsPassed ? 15 : 0));
  return {
    fixtureId: fixture.id, model, profile, startedAt, durationMs: Math.max(0, now() - startedAt),
    completionStatus, acceptancePassed, scopePassed, artifactsPassed, changedFiles, toolErrors,
    inputTokens, outputTokens, costUSD, ...(traceRunId ? { traceRunId } : {}), score,
    ...(error ? { error } : {}),
  };
}

async function checked(command: string[], cwd: string, timeoutMs = 120_000, allowFailure = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!command.length) throw new Error("Empty eval command");
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const timer = setTimeout(() => child.kill(), Math.min(Math.max(timeoutMs, 1_000), 3_600_000));
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = { stdout: bounded(stdout), stderr: bounded(stderr), exitCode };
    if (!allowFailure && exitCode !== 0) throw new Error(`${basename(command[0]!)} exited ${exitCode}: ${result.stderr || result.stdout}`);
    return result;
  } finally { clearTimeout(timer); }
}

function shell(command: string): string[] { return [process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? "/d" : "-lc", command]; }
function completion(value: unknown, exitCode: number): EvalCellV1["completionStatus"] {
  if (["verified", "met-unverified", "paused", "unmet"].includes(String(value))) return value as EvalCellV1["completionStatus"];
  return exitCode === 0 ? "met-unverified" : "runtime-failure";
}
function matchesScope(path: string, scope: string): boolean { const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope; return path === prefix || (scope.endsWith("/**") && path.startsWith(`${prefix}/`)); }
function lastJsonObject(output: string): Record<string, unknown> | undefined { for (const line of output.trim().split(/\r?\n/).reverse()) try { const value = JSON.parse(line); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {} return undefined; }
function numberField(value: Record<string, unknown> | undefined, key: string): number { const direct = value?.[key]; return typeof direct === "number" && Number.isFinite(direct) && direct >= 0 ? direct : 0; }
function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined { const direct = value?.[key]; return typeof direct === "string" && direct.length <= 240 ? direct : undefined; }
function lines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort(); }
function statusPaths(value: string): string[] { return value.split(/\r?\n/).filter(Boolean).map((line) => { const raw = line.slice(3); const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw; return renamed.replace(/^"|"$/g, ""); }).sort(); }
function bounded(value: string): string { return value.slice(0, MAX_OUTPUT); }
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "task"; }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown>; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`${name} has unknown fields: ${unknown.join(", ")}`); }
function boundedString(value: unknown, name: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string up to ${max} characters`); return value; }
function boundedInt(value: unknown, name: string, min: number, max: number): number { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`); return value as number; }
function strings(value: unknown, name: string, maxItems: number, maxLength: number): string[] { if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array of at most ${maxItems} strings`); return value.map((item, i) => boundedString(item, `${name}[${i}]`, maxLength)); }
function paths(value: unknown, name: string): string[] { return strings(value, name, 256, 1_024).map((path) => { if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`${name} paths must remain repository-relative`); return path.replaceAll("\\", "/").replace(/^\.\//, ""); }); }
function uniqueNonEmpty(values: string[], name: string): string[] { const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))]; if (!result.length) throw new Error(`${name} must not be empty`); return result; }
