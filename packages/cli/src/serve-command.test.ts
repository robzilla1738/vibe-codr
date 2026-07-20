import { expect, test } from "bun:test";
import type { LoopbackServerHandle } from "@vibe/server";
import { run } from "./index.ts";
import { parseServePort, runServeCommand } from "./serve-command.ts";

test("serve starts, reports the token path, waits, and shuts down cleanly", async () => {
  let stopped = false;
  let output = "";
  const handle: LoopbackServerHandle = {
    hostname: "127.0.0.1",
    port: 3210,
    url: "http://127.0.0.1:3210",
    token: "secret",
    tokenPath: "/machine/state/token",
    async stop() {
      stopped = true;
    },
  };
  const code = await runServeCommand(
    { cwd: "/repo", port: "3210" },
    {
      start: async (options) => {
        expect(options).toEqual({ cwd: "/repo", hostname: undefined, port: 3210 });
        return handle;
      },
      waitForShutdown: async () => undefined,
      stdout: (text) => {
        output += text;
      },
    },
  );
  expect(code).toBe(0);
  expect(stopped).toBe(true);
  expect(output).toContain(handle.url);
  expect(output).toContain(handle.tokenPath);
  expect(output).not.toContain(handle.token);
});

test("serve port parser and host policy fail closed", async () => {
  expect(parseServePort("0")).toBe(0);
  expect(parseServePort("65535")).toBe(65535);
  expect(() => parseServePort("65536")).toThrow("65535");
  expect(() => parseServePort("3.14")).toThrow("integer");
  await expect(
    runServeCommand(
      { cwd: "/repo", hostname: "0.0.0.0" },
      {
        start: async () => {
          throw new Error("must not start");
        },
        waitForShutdown: async () => undefined,
      },
    ),
  ).rejects.toThrow("forbidden");
});

test("CLI routes serve before config loading or runtime startup", async () => {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((value: string) => {
    stderr += value;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run(["serve", "--cwd", "/definitely/not/a/project", "--host", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("non-loopback binds are forbidden");
    expect(stderr).not.toContain("config");
  } finally {
    process.stderr.write = original;
  }
});
