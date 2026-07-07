import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  loadLedger,
  manifestHash,
  commandsHash,
  mergeConfirmedCommands,
  ledgerPath,
} from "./ledger.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "vibe-ledger-"));

test("round-trip: append then load by exact manifest hash", () => {
  const cwd = tmp();
  const mh = manifestHash({ commands: { test: "bun test" }, manifestFiles: ["package.json"], packageManager: "bun", primaryLanguage: "TypeScript" });
  const ch = commandsHash({ test: "bun test" });
  appendLedger(cwd, { manifestHash: mh, commandsHash: ch, at: 1, commands: { test: "bun test" }, conventions: ["biome"] });
  const rec = loadLedger(cwd, { manifestHash: mh, commandsHash: ch });
  expect(rec?.commands.test).toBe("bun test");
  expect(rec?.conventions).toEqual(["biome"]);
});

test("latest record wins among matches; malformed records are skipped", async () => {
  const cwd = tmp();
  const key = { manifestHash: "m1", commandsHash: "c1" };
  appendLedger(cwd, { ...key, at: 1, commands: { test: "old" }, conventions: [] });
  // Drop a malformed record file directly between two real writes (mirrors the
  // pre-BUG-049 torn-line test): a corrupted .json (disk error, not a torn
  // write — temp+rename now makes the latter impossible) must be skipped, and
  // the loader still surfaces the latest valid record by `at`.
  await Bun.write(join(cwd, ".vibe", "ledger", "0000000000001-z-corrupt.json"), "not-json");
  appendLedger(cwd, { ...key, at: 2, commands: { test: "new" }, conventions: [] });
  expect(loadLedger(cwd, key)?.commands.test).toBe("new");
});

test("a torn .tmp file (crash before rename) is ignored and never loses the prior record", async () => {
  // BUG-049: per-record temp+rename makes a crash mid-write leave ONLY an
  // ignored .tmp file — the durable .json either all-landed or never existed.
  const cwd = tmp();
  const key = { manifestHash: "m1", commandsHash: "c1" };
  appendLedger(cwd, { ...key, at: 5, commands: { test: "real" }, conventions: [] });
  await Bun.write(join(cwd, ".vibe", "ledger", "0000000000009-aborted.tmp"), JSON.stringify({ ...key, at: 9 }));
  expect(loadLedger(cwd, key)?.commands.test).toBe("real");
});

test("legacy in-cwd ledger.jsonl still loads after the upgrade (backward compatibility)", async () => {
  // An existing pre-BUG-049 repo has a .vibe/ledger.jsonl file; the loader must
  // still read it on the first run after upgrading (the per-record dir is
  // empty), so no confirmed command is silently dropped across the migration.
  const cwd = tmp();
  const key = { manifestHash: "legacy", commandsHash: "c1" };
  await Bun.write(join(cwd, ".vibe", "ledger.jsonl"), `${JSON.stringify({ ...key, at: 7, commands: { test: "legacy-cmd" }, conventions: [] })}\n`);
  expect(loadLedger(cwd, key)?.commands.test).toBe("legacy-cmd");
});

test("a dep bump (manifestHash changed, commandsHash same) keeps confirmed commands", () => {
  const cwd = tmp();
  appendLedger(cwd, { manifestHash: "before-bump", commandsHash: "same", at: 1, commands: { test: "npm test" }, conventions: [] });
  const rec = loadLedger(cwd, { manifestHash: "after-bump", commandsHash: "same" });
  expect(rec?.commands.test).toBe("npm test");
});

test("a real build change (both hashes differ) discards stale facts", () => {
  const cwd = tmp();
  appendLedger(cwd, { manifestHash: "old", commandsHash: "old-cmds", at: 1, commands: { test: "jest" }, conventions: [] });
  expect(loadLedger(cwd, { manifestHash: "new", commandsHash: "new-cmds" })).toBeNull();
});

test("exact manifest match beats a merely commands-compatible newer record", () => {
  const cwd = tmp();
  appendLedger(cwd, { manifestHash: "exact", commandsHash: "cc", at: 1, commands: { test: "exact-cmd" }, conventions: [] });
  appendLedger(cwd, { manifestHash: "other", commandsHash: "cc", at: 5, commands: { test: "compat-cmd" }, conventions: [] });
  expect(loadLedger(cwd, { manifestHash: "exact", commandsHash: "cc" })?.commands.test).toBe("exact-cmd");
});

test("mergeConfirmedCommands: detection wins, confirmed fills gaps", () => {
  const { commands, filled } = mergeConfirmedCommands(
    { build: "bun run build" },
    { build: "npm run build", test: "bun test", lint: "biome lint" },
  );
  expect(commands.build).toBe("bun run build");
  expect(commands.test).toBe("bun test");
  expect(filled.sort()).toEqual(["lint", "test"]);
});

test("missing ledger file loads null; append never throws on bad dir", () => {
  expect(loadLedger(tmp(), { manifestHash: "x", commandsHash: "y" })).toBeNull();
  appendLedger("/nonexistent/definitely/not/writable", {
    manifestHash: "m",
    commandsHash: "c",
    at: 1,
    commands: {},
    conventions: [],
  });
});
