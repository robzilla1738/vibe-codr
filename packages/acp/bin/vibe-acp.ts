#!/usr/bin/env bun
import { Readable, Writable } from "node:stream";
import { runAcpStdio } from "../src/runtime-agent.ts";

await runAcpStdio({
  cwd: process.cwd(),
  input: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  output: Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
});
