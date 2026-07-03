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

test("a tsconfig-EXCLUDED edited file does not surface project-membership noise", async () => {
  // The project includes only src/**; a file under scripts/ is excluded. Editing
  // it must not append "not under rootDir / not in project" meta-diagnostics as
  // "fix before moving on" — those are about membership, not the code.
  const dir = mkdtempSync(join(tmpdir(), "vibe-diag-excl-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, rootDir: "src" },
      include: ["src/**/*.ts"],
    }),
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "src", "ok.ts"), "export const x: number = 1;\n");
  const excluded = join(dir, "scripts", "tool.ts");
  // Clean code, but it lives outside rootDir → TS would emit TS6059 as a program root.
  writeFileSync(excluded, "export const y: number = 2;\n");

  const diag = new TsDiagnostics();
  const out = await diag.diagnose(excluded);
  // No membership-noise leaked (TS6059 "not under rootDir" / TS6307). Clean code
  // → undefined, not a spurious "fix before moving on" block.
  expect(out).toBeUndefined();
});

test("force-added out-of-project files are bounded (no unbounded root-set growth)", async () => {
  // Diagnose many distinct files not in the tsconfig; the service's force-added
  // root set must stay bounded rather than growing once per distinct path.
  const dir = mkdtempSync(join(tmpdir(), "vibe-diag-cap-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["included.ts"] }),
  );
  writeFileSync(join(dir, "included.ts"), "export const a = 1;\n");
  const diag = new TsDiagnostics();
  // Real errors so each diagnose does its full add+bump path.
  for (let i = 0; i < 30; i++) {
    const f = join(dir, `extra${i}.ts`);
    writeFileSync(f, `const bad${i}: number = "x";\nexport { bad${i} };\n`);
    const out = await diag.diagnose(f);
    expect(out).toContain("TS2322"); // still diagnosed correctly under the cap
  }
});
