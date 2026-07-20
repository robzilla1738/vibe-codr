import { chmod, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  listRunTraces,
  readRunTrace,
  renderRunTraceHtml,
  runEventLedgerDir,
} from "@vibe/runtime";

export interface TraceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runTraceCommand(input: {
  cwd: string;
  args: string[];
  output?: string;
  includeRedacted?: boolean;
}): Promise<TraceCommandResult> {
  const [action, runId, ...extra] = input.args;
  try {
    if (action === "list") {
      if (runId || extra.length) throw new Error("usage: vibe trace list [--cwd DIR]");
      if (input.output) throw new Error("--output is available only for trace export");
      if (input.includeRedacted) {
        throw new Error("--include-redacted is available only for trace show/export");
      }
      const result = await listRunTraces(runEventLedgerDir(input.cwd));
      return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
    }
    if (action === "show") {
      if (!runId || extra.length) throw new Error("usage: vibe trace show <run-id> [--include-redacted]");
      if (input.output) throw new Error("--output is available only for trace export");
      const result = await readRunTrace(runEventLedgerDir(input.cwd), runId, {
        includeRedacted: input.includeRedacted,
      });
      return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
    }
    if (action === "export") {
      if (!runId || extra.length) {
        throw new Error("usage: vibe trace export <run-id> [--output FILE] [--include-redacted]");
      }
      const html = await renderRunTraceHtml(runEventLedgerDir(input.cwd), runId, {
        includeRedacted: input.includeRedacted,
      });
      const requested = input.output ?? `vibe-trace-${runId}.html`;
      const path = isAbsolute(requested) ? resolve(requested) : resolve(join(input.cwd, requested));
      await writeFile(path, html, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return { exitCode: 0, stdout: `${path}\n`, stderr: "" };
    }
    throw new Error("usage: vibe trace <list|show|export> [run-id]");
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `vibecodr: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
