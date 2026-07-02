import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TsDiagnostics } from "./diagnostics.ts";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-diag-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
  );
  return dir;
}

test("reports real type errors with file:line and caps the list", async () => {
  const dir = makeProject();
  const file = join(dir, "broken.ts");
  writeFileSync(file, 'const n: number = "not a number";\nexport { n };\n');

  const diag = new TsDiagnostics();
  expect(await diag.available()).toBe(true); // typescript is a dev dep here
  const out = await diag.diagnose(file);
  expect(out).toContain("TypeScript diagnostics");
  expect(out).toContain("broken.ts:1:");
  expect(out).toContain("TS2322");
});

test("a clean file yields undefined; edits are re-read (version bump)", async () => {
  const dir = makeProject();
  const file = join(dir, "clean.ts");
  writeFileSync(file, "export const ok: number = 1;\n");
  const diag = new TsDiagnostics();
  expect(await diag.diagnose(file)).toBeUndefined();

  // Break it on disk — the service must see the NEW content, not a cached copy.
  writeFileSync(file, 'export const ok: number = "broken";\n');
  const out = await diag.diagnose(file);
  expect(out).toContain("TS2322");

  // Fix it again — diagnostics clear.
  writeFileSync(file, "export const ok: number = 2;\n");
  expect(await diag.diagnose(file)).toBeUndefined();
});

test("a file created AFTER the service was built still gets diagnosed", async () => {
  const dir = makeProject();
  const existing = join(dir, "existing.ts");
  writeFileSync(existing, "export const ok: number = 1;\n");
  const diag = new TsDiagnostics();
  // The first diagnose builds + caches the service; its fileNames are frozen from
  // the disk state THEN (existing.ts only).
  expect(await diag.diagnose(existing)).toBeUndefined();

  // Now the model writes a brand-new file with a type error. It wasn't in the
  // tsconfig's resolved fileNames when the service was built, but must still be
  // diagnosed — this is exactly the freshly-authored-code case that matters most.
  const created = join(dir, "created.ts");
  writeFileSync(created, 'export const n: number = "nope";\n');
  const out = await diag.diagnose(created);
  expect(out).toContain("created.ts:1:");
  expect(out).toContain("TS2322");
});

test("editing tsconfig.json rebuilds the service so new options take effect", async () => {
  const dir = makeProject();
  const file = join(dir, "unused.ts");
  // An unused local — clean under the default config…
  writeFileSync(file, "export function f(): number {\n  const spare = 1;\n  return 2;\n}\n");
  const diag = new TsDiagnostics();
  expect(await diag.diagnose(file)).toBeUndefined();

  // …but flagged once tsconfig enables noUnusedLocals. The cached service must
  // rebuild against the new compilerOptions instead of reusing the stale ones.
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, noUnusedLocals: true }, include: ["*.ts"] }),
  );
  const out = await diag.diagnose(file);
  expect(out).toContain("TS6133"); // 'spare' is declared but never read
});

test("non-TS files and files outside any tsconfig are ignored", async () => {
  const diag = new TsDiagnostics();
  expect(await diag.diagnose("/tmp/whatever.md")).toBeUndefined();
  const orphanDir = mkdtempSync(join(tmpdir(), "vibe-diag-orphan-"));
  const orphan = join(orphanDir, "loose.ts");
  writeFileSync(orphan, 'const x: number = "broken";\n');
  // No tsconfig anywhere above the temp dir root → no service → undefined.
  // (If the host machine has a tsconfig at /tmp or /, this still returns a
  // string safely — so assert only that it doesn't throw.)
  await diag.diagnose(orphan);
});
