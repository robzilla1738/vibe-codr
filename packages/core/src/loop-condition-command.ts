import {
  type ReadOnlyCommandOptions,
  type ReadOnlyCommandResult,
  runSandboxedReadOnlyCommand,
} from "@vibe/tools";

export type LoopConditionCommandRunner = (
  command: string,
  cwd: string,
  opts?: ReadOnlyCommandOptions,
) => Promise<ReadOnlyCommandResult>;

export interface EvaluateLoopCommandConditionOptions {
  cwd: string;
  command: string;
  signal: AbortSignal;
  /** Dependency injection for focused controller/unit tests. */
  run?: LoopConditionCommandRunner;
}

/** Exit zero means satisfied. An ordinary nonzero exit is a healthy "not yet"
 * verdict; containment/start/timeout/abort failures throw so LoopController's
 * bounded evaluator-failure policy applies. Command output stays internal: it
 * is capped by the runner and is not copied into transcript notices. */
export async function evaluateLoopCommandCondition(
  opts: EvaluateLoopCommandConditionOptions,
): Promise<{ done: boolean; reason: string }> {
  const result = await (opts.run ?? runSandboxedReadOnlyCommand)(opts.command, opts.cwd, {
    signal: opts.signal,
  });
  return result.code === 0
    ? { done: true, reason: "command exited 0" }
    : { done: false, reason: `command exited ${result.code}` };
}
