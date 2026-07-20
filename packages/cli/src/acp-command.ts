import { Readable, Writable } from "node:stream";
import { runAcpStdio, type RunAcpStdioOptions } from "@vibe/acp";

export interface AcpCommandDependencies {
  run?: (options: RunAcpStdioOptions) => Promise<void>;
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
}

export async function runAcpCommand(
  cwd: string,
  dependencies: AcpCommandDependencies = {},
): Promise<number> {
  await (dependencies.run ?? runAcpStdio)({
    cwd,
    input: dependencies.input ?? (Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>),
    output: dependencies.output ?? (Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>),
  });
  return 0;
}
