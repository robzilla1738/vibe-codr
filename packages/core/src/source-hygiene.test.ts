import { test, expect } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

// A raw NUL byte in a source file makes grep/ripgrep classify the whole file as
// binary and silently skip it — which once hid all of mcp.ts from every search
// (the byte was a hash-separator inside a template literal; it now uses the
// backslash-u0000 escape). Guard the whole workspace so it can't come back.
test("no source file contains a raw NUL byte", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const glob = new Glob("packages/*/src/**/*.{ts,tsx}");
  const offenders: string[] = [];
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
    const bytes = new Uint8Array(await Bun.file(join(root, rel)).arrayBuffer());
    if (bytes.includes(0)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
