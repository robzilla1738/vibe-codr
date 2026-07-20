import { expect, test } from "bun:test";
import { runAcpCommand } from "./acp-command.ts";

test("ACP command delegates stdio and workspace to the canonical adapter", async () => {
  const input = new ReadableStream<Uint8Array>();
  const output = new WritableStream<Uint8Array>();
  let seen: unknown;
  expect(await runAcpCommand("/repo", {
    input,
    output,
    run: async (options) => { seen = options; },
  })).toBe(0);
  expect(seen).toEqual({ cwd: "/repo", input, output });
});
