import { test, expect } from "bun:test";
import { scanStubs, formatStubFindings } from "./stubscan.ts";

const diff = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,0 +1,5 @@",
    ...added.map((l) => `+${l}`),
  ].join("\n");

test("flags dead handlers, dead links, alert-only, TODO, not-implemented", () => {
  const findings = scanStubs(
    [
      diff("src/App.tsx", [
        "<button onClick={() => {}}>Save</button>",
        '<a href="#">Docs</a>',
        "<button onClick={() => alert('hi')}>Send</button>",
        "// TODO: wire this up",
        'throw new Error("not implemented yet");',
      ]),
    ].join("\n"),
  );
  const kinds = findings.map((f) => f.kind);
  expect(kinds).toContain("dead-handler");
  expect(kinds).toContain("dead-link");
  expect(kinds).toContain("stub-alert");
  expect(kinds).toContain("todo-marker");
  expect(kinds).toContain("not-implemented");
});

test("a real handler that also logs is not flagged as console-only", () => {
  const findings = scanStubs(
    diff("src/Form.tsx", ["<button onClick={() => { console.log('x'); submit(); }}>Go</button>"]),
  );
  expect(findings.filter((f) => f.kind === "stub-console")).toEqual([]);
});

test("console-only handler IS flagged", () => {
  const findings = scanStubs(
    diff("src/Form.tsx", ["<button onClick={() => console.log('todo')}>Go</button>"]),
  );
  expect(findings.map((f) => f.kind)).toContain("stub-console");
});

test("bare return null flagged only in handler-ish paths", () => {
  const inHandler = scanStubs(diff("src/api/users/route.ts", ["  return null;"]));
  expect(inHandler.map((f) => f.kind)).toContain("empty-return");
  const elsewhere = scanStubs(diff("src/utils/math.ts", ["  return null;"]));
  expect(elsewhere.filter((f) => f.kind === "empty-return")).toEqual([]);
});

test("empty-bodied function declarations are flagged, arrow no-ops and real bodies are not", () => {
  const findings = scanStubs(
    diff("src/save.ts", [
      "export function save() {}", // stub → flagged
      "async function handle(): Promise<void> {}", // stub → flagged
      "const noop = () => {};", // intentional no-op → not flagged
      "function real() { return 1; }", // real body → not flagged
    ]),
  );
  const empties = findings.filter((f) => f.kind === "empty-body").map((f) => f.snippet);
  expect(empties).toContain("export function save() {}");
  expect(empties).toContain("async function handle(): Promise<void> {}");
  expect(empties.length).toBe(2); // arrow no-op and real body excluded
});

test("tests, markdown, and vendored paths are not scanned; removed lines ignored", () => {
  const noise = [
    diff("src/App.test.tsx", ["// TODO: assert more"]),
    diff("README.md", ["TODO: docs"]),
    diff("node_modules/x/index.js", ["// TODO"]),
    [
      `diff --git a/src/x.ts b/src/x.ts`,
      `--- a/src/x.ts`,
      `+++ b/src/x.ts`,
      "@@ -1,2 +1,1 @@",
      "-// TODO old",
    ].join("\n"),
  ].join("\n");
  expect(scanStubs(noise)).toEqual([]);
});

test("scans ESM/CJS module extensions (.mjs/.cjs/.mts/.cts) — adversarial P5-1", () => {
  // The allow-list's `tsx?`/`jsx?` covered only .ts/.tsx/.js/.jsx; a stub added to
  // a .mjs/.cjs/.mts/.cts file slipped past the deterministic backstop entirely.
  for (const ext of ["mjs", "cjs", "mts", "cts"]) {
    const d = diff(`src/thing.${ext}`, ['throw new Error("not implemented");']);
    expect([ext, scanStubs(d).length]).toEqual([ext, 1]);
  }
  // …but a TEST file in a module extension is still excluded from scanning.
  expect(scanStubs(diff("src/thing.test.mts", ["// TODO later"]))).toEqual([]);
  expect(scanStubs(diff("src/thing.spec.cjs", ["// TODO later"]))).toEqual([]);
});

test("line numbers track hunk headers and context lines", () => {
  const d = [
    "diff --git a/src/app/page.tsx b/src/app/page.tsx",
    "--- a/src/app/page.tsx",
    "+++ b/src/app/page.tsx",
    "@@ -10,3 +10,4 @@",
    " const a = 1;",
    '+<a href="#">broken</a>',
  ].join("\n");
  const [finding] = scanStubs(d);
  expect(finding?.line).toBe(11);
});

test("formatStubFindings groups by kind; empty input yields empty string", () => {
  expect(formatStubFindings([])).toBe("");
  const out = formatStubFindings([
    { file: "a.tsx", line: 3, kind: "dead-link", snippet: 'href="#"' },
    { file: "b.tsx", line: 9, kind: "dead-link", snippet: 'href="#"' },
  ]);
  expect(out).toContain("dead-link (2)");
  expect(out).toContain("a.tsx:3");
});
