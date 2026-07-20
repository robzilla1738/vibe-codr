import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutomationCommand } from "./automation-command.ts";

test("automation CLI preserves safe defaults and explicit mutation confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-auto-cli-"));
  const spec = join(root, "spec.json");
  await writeFile(spec, JSON.stringify({ schemaVersion: 1, id: "nightly", workspace: root, action: { prompt: "inspect" }, trigger: { kind: "interval", everyMs: 60000 } }));
  expect((await runAutomationCommand({ args: ["save", spec], root })).exitCode).toBe(0);
  const listed = await runAutomationCommand({ args: ["list"], root });
  expect(listed.stdout).toContain('"mode": "plan"');
  expect((await runAutomationCommand({ args: ["disable", "nightly"], root })).stdout).toContain('"enabled": false');
});
