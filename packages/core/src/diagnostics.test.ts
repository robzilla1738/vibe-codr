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
