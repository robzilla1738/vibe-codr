import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function stageTree(cwd: string, realIndex: string, seeded: boolean): Promise<{ ms: number; tree: string }> {
  const index = join(tmpdir(), `vibe-checkpoint-bench-${crypto.randomUUID()}`);
  try {
    if (seeded) await copyFile(realIndex, index);
    const started = performance.now();
    await git(cwd, ["add", "-A"], { GIT_INDEX_FILE: index });
    const tree = await git(cwd, ["write-tree"], { GIT_INDEX_FILE: index });
    return { ms: performance.now() - started, tree };
  } finally {
    await rm(index, { force: true });
  }
}

const cwd = await mkdtemp(join(tmpdir(), "vibe-checkpoint-benchmark-"));
try {
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "perf@vibe.local"]);
  await git(cwd, ["config", "user.name", "Vibe Performance"]);
  await Promise.all(Array.from({ length: 3_000 }, (_, index) =>
    Bun.write(join(cwd, "fixture", `${String(index).padStart(4, "0")}.txt`), `base ${index}\n`),
  ));
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-qm", "fixture"]);
  await Promise.all(Array.from({ length: 100 }, (_, index) =>
    Bun.write(join(cwd, "fixture", `${String(index).padStart(4, "0")}.txt`), `dirty ${index}\n`),
  ));
  await Promise.all(Array.from({ length: 25 }, (_, index) =>
    Bun.write(join(cwd, "untracked", `${index}.txt`), `new ${index}\n`),
  ));
  const indexPath = await git(cwd, ["rev-parse", "--git-path", "index"]);
  const realIndex = indexPath.startsWith("/") ? indexPath : join(cwd, indexPath);
  const legacy: number[] = [];
  const seeded: number[] = [];
  let expectedTree = "";
  for (let run = 0; run < 20; run += 1) {
    const old = await stageTree(cwd, realIndex, false);
    const next = await stageTree(cwd, realIndex, true);
    expectedTree ||= old.tree;
    if (old.tree !== expectedTree || next.tree !== expectedTree) throw new Error("private index tree mismatch");
    legacy.push(old.ms);
    seeded.push(next.ms);
  }
  const result = {
    files: 3_025,
    dirtyFiles: 125,
    runs: 20,
    legacyMedianMs: median(legacy),
    seededMedianMs: median(seeded),
    reduction: 1 - median(seeded) / median(legacy),
  };
  console.info("VIBE_CHECKPOINT_RESULT", JSON.stringify(result));
  if (result.reduction < 0.7) throw new Error(`checkpoint reduction ${(result.reduction * 100).toFixed(1)}% is below 70%`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
