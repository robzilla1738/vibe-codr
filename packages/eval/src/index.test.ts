import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvalFixture, runEvalMatrix } from "./index.ts";

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-eval-source-"));
  await Bun.$`git init -q ${root}`;
  await writeFile(join(root, "README.md"), "base\n");
  await Bun.$`git -C ${root} add README.md`;
  await Bun.$`git -C ${root} -c user.name=Vibe -c user.email=vibe@example.invalid commit -qm base`;
  return root;
}

describe("eval fixtures", () => {
  test("strictly validates scope and schema", () => {
    expect(() => parseEvalFixture({ schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() => parseEvalFixture({ schemaVersion: 1, id: "x", repository: { source: "." }, prompt: "x", acceptanceCommands: ["true"], allowedScope: ["../bad"], expectedArtifacts: [] })).toThrow("repository-relative");
  });

  test("runs matrix cells in isolated clones and withholds tiny-sample routing stats", async () => {
    const source = await repository();
    const fixture = parseEvalFixture({
      schemaVersion: 1, id: "write-ok", repository: { source }, prompt: "write result",
      acceptanceCommands: ["test -f result.txt"], allowedScope: ["result.txt"], expectedArtifacts: ["result.txt"],
    });
    const result = await runEvalMatrix(fixture, {
      models: ["test/model"], profiles: ["safe"],
      agentCommand: () => ["/bin/sh", "-lc", "printf ok > result.txt; printf '%s\\n' '{\"goalCompletionStatus\":\"verified\",\"inputTokens\":3,\"outputTokens\":2,\"costUSD\":0.01}'"],
    });
    expect(result.results[0]).toMatchObject({ completionStatus: "verified", acceptancePassed: true, scopePassed: true, artifactsPassed: true, changedFiles: ["result.txt"], score: 100 });
    expect(result.strategyStatistics[0]).toEqual({ model: "test/model", profile: "safe", samples: 1, eligibleForRouting: false });
  });
});
