import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalCommand } from "./eval-command.ts";

test("eval command drives a model/profile matrix from a versioned fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-eval-cli-"));
  const source = join(root, "source");
  await Bun.$`git init -q ${source}`;
  await writeFile(join(source, "base.txt"), "base\n");
  await Bun.$`git -C ${source} add base.txt`;
  await Bun.$`git -C ${source} -c user.name=Vibe -c user.email=vibe@example.invalid commit -qm base`;
  const fixture = join(root, "fixture.json");
  await writeFile(fixture, JSON.stringify({ schemaVersion: 1, id: "cli", repository: { source }, prompt: "write", acceptanceCommands: ["test -f out.txt"], allowedScope: ["out.txt"], expectedArtifacts: ["out.txt"] }));
  const result = await runEvalCommand({
    fixturePath: fixture, models: "a/one,b/two", profiles: "plan", samples: "1",
    agentCommand: () => ["/bin/sh", "-lc", "echo ok > out.txt; echo '{\"goalCompletionStatus\":\"verified\"}'"],
  });
  expect(result.results).toHaveLength(2);
  expect(result.results.every((item) => item.score === 100)).toBe(true);
});
