import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RunEventV1Schema } from "@vibe/protocol";
import { runEventLedgerDir } from "@vibe/runtime";
import { runTraceCommand } from "./trace-command.ts";

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-trace-cli-"));
  const directory = runEventLedgerDir(cwd);
  await mkdir(directory, { recursive: true });
  const event = RunEventV1Schema.parse({
    schemaVersion: 1,
    runId: "run-cli",
    seq: 1,
    at: 1,
    type: "file-changed",
    action: "write",
    content: { path: "/private/project/secret.ts" },
  });
  writeFileSync(join(directory, "run-cli-000001.jsonl"), `${JSON.stringify(event)}\n`);
  return cwd;
}

test("trace list/show are bounded JSON and content-free unless explicitly requested", async () => {
  const cwd = await fixture();
  const listed = await runTraceCommand({ cwd, args: ["list"] });
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout).traces[0].runId).toBe("run-cli");
  const shown = await runTraceCommand({ cwd, args: ["show", "run-cli"] });
  expect(shown.stdout).not.toContain("/private/project");
  const optedIn = await runTraceCommand({ cwd, args: ["show", "run-cli"], includeRedacted: true });
  expect(optedIn.stdout).toContain("/private/project");
});

test("trace export writes a private static escaped HTML file", async () => {
  const cwd = await fixture();
  const result = await runTraceCommand({
    cwd,
    args: ["export", "run-cli"],
    output: "evidence.html",
  });
  expect(result.exitCode).toBe(0);
  const path = join(cwd, "evidence.html");
  const html = readFileSync(path, "utf8");
  expect(html).toContain("<!doctype html>");
  expect(html).not.toContain("/private/project");
  expect(html).not.toContain("<script");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("trace command rejects traversal ids and option misuse", async () => {
  const cwd = await fixture();
  expect((await runTraceCommand({ cwd, args: ["show", "../run"] })).exitCode).toBe(1);
  expect((await runTraceCommand({ cwd, args: ["list"], output: "x" })).stderr).toContain(
    "only for trace export",
  );
});
