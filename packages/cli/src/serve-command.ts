import { type LoopbackServerHandle, startLoopbackServer } from "@vibe/server";

export interface ServeCommandOptions {
  cwd: string;
  hostname?: string;
  port?: string;
}

export interface ServeCommandDependencies {
  start?: (options: {
    cwd: string;
    hostname?: string;
    port?: number;
  }) => Promise<LoopbackServerHandle>;
  waitForShutdown?: () => Promise<void>;
  stdout?: (text: string) => void;
}

export function parseServePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("--port must be an integer between 0 and 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

export async function runServeCommand(
  options: ServeCommandOptions,
  dependencies: ServeCommandDependencies = {},
): Promise<number> {
  if (options.hostname !== undefined && options.hostname !== "127.0.0.1") {
    throw new Error("--host must be 127.0.0.1; non-loopback binds are forbidden");
  }
  const start = dependencies.start ?? startLoopbackServer;
  const handle = await start({
    cwd: options.cwd,
    hostname: options.hostname,
    port: parseServePort(options.port),
  });
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  stdout(`Vibe API v1 listening on ${handle.url}\nBearer token: ${handle.tokenPath}\n`);
  try {
    await (dependencies.waitForShutdown ?? waitForServeShutdown)();
  } finally {
    await handle.stop();
  }
  return 0;
}

export function waitForServeShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
