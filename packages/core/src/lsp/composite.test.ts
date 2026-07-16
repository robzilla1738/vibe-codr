import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspConfigSchema } from "@vibe/config";
import type { Diagnostics, LspStatus } from "../diagnostics.ts";
import { CompositeDiagnostics } from "./composite.ts";

const config = LspConfigSchema.parse({});

function fakeDiag(opts: { result?: string; status?: LspStatus[] } = {}) {
  const rec = { calls: [] as string[], disposeCalls: 0 };
  const diag: Diagnostics = {
    async diagnose(p) {
      rec.calls.push(p);
      return opts.result;
    },
    async available() {
      return true;
    },
    status() {
      return opts.status ?? [];
    },
    dispose() {
      rec.disposeCalls++;
    },
  };
  return { diag, rec };
}

function tsProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-composite-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
  );
  return dir;
}

test(".ts routes to the in-process TS fast path (real TsDiagnostics), NOT the LSP layer", async () => {
  const dir = tsProject();
  const file = join(dir, "broken.ts");
  writeFileSync(file, 'const n: number = "not a number";\nexport { n };\n');

  const lsp = fakeDiag({ result: "should not be used" });
  const composite = new CompositeDiagnostics(config, () => dir, undefined, { lsp: lsp.diag });

  const out = await composite.diagnose(file);
  expect(out).toContain("TypeScript diagnostics");
  expect(out).toContain("TS2322");
  // The LSP layer was never consulted for a TS file.
  expect(lsp.rec.calls).toEqual([]);
});

test("non-TS routes to the LSP layer; TS/JS never reaches it", async () => {
  const ts = fakeDiag({ result: "  ts fast path" });
  const lsp = fakeDiag({ result: "  LSP diagnostics (python) — fix before moving on:\n  x" });
  const composite = new CompositeDiagnostics(config, () => "/root", undefined, {
    ts: ts.diag,
    lsp: lsp.diag,
  });

  const py = await composite.diagnose("/proj/app.py");
  expect(py).toContain("LSP diagnostics (python)");
  expect(lsp.rec.calls).toEqual(["/proj/app.py"]);
  expect(ts.rec.calls).toEqual([]); // TS layer untouched by a .py

  const tsFile = await composite.diagnose("/proj/app.ts");
  expect(tsFile).toContain("ts fast path");
  expect(ts.rec.calls).toEqual(["/proj/app.ts"]);
});

test("a missing/clean LSP server degrades to undefined (never a false clean)", async () => {
  const lsp = fakeDiag({ result: undefined }); // no server / clean → undefined
  const composite = new CompositeDiagnostics(config, () => "/root", undefined, { lsp: lsp.diag });
  expect(await composite.diagnose("/proj/main.go")).toBeUndefined();
  expect(lsp.rec.calls).toEqual(["/proj/main.go"]);
});

test("status aggregates both layers; dispose tears both down", async () => {
  const ts = fakeDiag({ status: [] });
  const lsp = fakeDiag({
    status: [{ language: "py", command: "basedpyright-langserver", state: "running" }],
  });
  const composite = new CompositeDiagnostics(config, () => "/root", undefined, {
    ts: ts.diag,
    lsp: lsp.diag,
  });

  const status = composite.status();
  expect(status).toEqual([
    { language: "py", command: "basedpyright-langserver", state: "running" },
  ]);

  composite.dispose();
  expect(ts.rec.disposeCalls).toBe(1);
  expect(lsp.rec.disposeCalls).toBe(1);
});
