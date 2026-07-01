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

test("latest record wins among matches; malformed lines are skipped", async () => {
  const cwd = tmp();
  const key = { manifestHash: "m1", commandsHash: "c1" };
  appendLedger(cwd, { ...key, at: 1, commands: { test: "old" }, conventions: [] });
  await Bun.write(ledgerPath(cwd), `${await Bun.file(ledgerPath(cwd)).text()}not-json\n`);
  appendLedger(cwd, { ...key, at: 2, commands: { test: "new" }, conventions: [] });
  expect(loadLedger(cwd, key)?.commands.test).toBe("new");
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
