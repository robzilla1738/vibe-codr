import { test, expect } from "bun:test";
import { bunExec } from "./exec.ts";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("bunExec: a passing command returns its combined output and exit code", async () => {
  const exec = bunExec();
  const res = await exec("echo hi; echo err 1>&2", { cwd: process.cwd() });
  expect(res.code).toBe(0);
  expect(res.out).toContain("hi");
  expect(res.out).toContain("err");
});

test("bunExec timeout kills the whole process tree and does NOT hang on an orphaned pipe holder", async () => {
  // A backgrounded grandchild inherits the stdout pipe write-end. If the timeout
  // kills only the `bash -lc` child (the old `proc.kill()`), that grandchild keeps
  // the pipe open, `readBounded` never sees EOF, and bunExec hangs forever —
  // wedging the green-gate. Killing the whole tree closes the pipe and unwinds.
  const exec = bunExec();
  const uniq = 900_000 + Math.floor(Math.random() * 90_000);
  const race = await Promise.race([
    exec(`sleep ${uniq} & wait`, { cwd: process.cwd(), timeoutSec: 0.3 }),
    Bun.sleep(6000).then(() => "HANG" as const),
  ]);
  expect(race).not.toBe("HANG"); // bunExec returned instead of hanging

  // And the grandchild was reaped (not left as an orphan holding the pipe).
  await Bun.sleep(300);
  const survivor = Bun.spawnSync(["pgrep", "-f", `sleep ${uniq}`]);
  const pids = new TextDecoder()
    .decode(survivor.stdout)
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && isAlive(n));
  expect(pids).toEqual([]);
});
