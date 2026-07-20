import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vibe/core";
import { runShareCommand } from "./share-command.ts";

test("share writes a private local redacted static HTML file and refuses overwrite", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-share-command-"));
  const store = new SessionStore(cwd);
  await store.save(
    { id: "ses_share_cli", model: "mock/x", mode: "execute", goal: null, createdAt: 1, updatedAt: 2 },
    [],
    [{ id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", text: `token=secret-value ${cwd}/app.ts` }] }],
  );
  const output = join(cwd, "share.html");
  const result = await runShareCommand({ cwd, sessionId: "ses_share_cli", output });
  expect(result.path).toBe(output);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  const html = await Bun.file(output).text();
  expect(html).toContain("token=***");
  expect(html).toContain("[workspace]/app.ts");
  await expect(runShareCommand({ cwd, sessionId: "ses_share_cli", output })).rejects.toThrow();
});
