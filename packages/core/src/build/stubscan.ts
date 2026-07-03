import type { StubFinding } from "@vibe/shared";

/**
 * Pure, deterministic scan of a unified git diff for ADDED lines that look like
 * dead or unfinished code — empty click handlers, `href="#"`, TODO/FIXME,
 * `throw new Error("not implemented")`, "coming soon" placeholders, alert-only
 * handlers, and (in route/handler files) a bare `return null`. A green gate
 * only proves build/typecheck/test pass; a button with no onClick compiles
 * cleanly, so this catches the "renders but does nothing" class the gate can't.
 * Findings are ADVISORY — fed to the diff reviewer to verify and drive a fix,
 * never used to hard-block (heuristics false-positive). Never throws.
 * (Ported from agentswarm codeintel.)
 */

/** Source files worth scanning; skip generated/lockfiles/tests/markdown noise. */
function scannablePath(p: string): boolean {
  const f = p.toLowerCase();
  if (/(^|\/)(node_modules|dist|build|out|\.next|vendor|target|__snapshots__)\//.test(f)) return false;
  if (/\.(lock|md|mdx|txt|json|lockb|snap|map|svg|png|jpe?g|gif|ico|woff2?|ttf)$/.test(f)) return false;
  if (/\.(test|spec)\.([mc][tj]s|[tj]sx?)$/.test(f) || /(^|\/)(tests?|__tests__|e2e|fixtures?)\//.test(f)) return false;
  // `[mc][tj]s` covers the ESM/CJS variants (.mjs/.cjs/.mts/.cts) that `tsx?`/`jsx?` alone miss.
  return /\.([mc][tj]s|tsx?|jsx?|vue|svelte|py|rs|go|rb|java|kt|swift|php|cs|c|cc|cpp|h|hpp)$/.test(f);
}

/** Path looks like server/route/handler code where a bare `return null` is a likely stub. */
function isHandlerPath(p: string): boolean {
  return /(route|router|controller|handler|service|api|endpoint|action|resolver|usecase|use-case)/i.test(p);
}

const STUB_RULES: { kind: string; re: RegExp }[] = [
  // explicit unfinished markers
  { kind: "todo-marker", re: /\b(TODO|FIXME|XXX|HACK)\b/ },
  // not-implemented across languages
  {
    kind: "not-implemented",
    re: /not[\s_-]?implemented|NotImplementedError|unimplemented!|todo!\s*\(|panic!?\s*\(\s*["'`](todo|not implemented)/i,
  },
  {
    kind: "not-implemented",
    re: /throw\s+new\s+Error\s*\(\s*["'`][^"'`]*\b(not\s+implemented|unimplemented|stub|todo)\b/i,
  },
  // dead/empty event handlers — renders but does nothing
  {
    kind: "dead-handler",
    re: /\bon[A-Z]\w*\s*=\s*\{\s*(?:\(\s*[^)]*\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)|undefined|null)\s*\}/,
  },
  // console-only event handler — matches only when the ENTIRE handler is one
  // console.* call, so a real handler that also logs is never flagged.
  {
    kind: "stub-console",
    re: /\bon[A-Z]\w*\s*=\s*\{\s*\(\s*[^)]*\)\s*=>\s*(?:console\.\w+\s*\([^{};]*\)|\{\s*console\.\w+\s*\([^{};]*\)\s*;?\s*\})\s*\}/,
  },
  // placeholder dead links / buttons
  { kind: "dead-link", re: /href\s*=\s*\{?\s*["'`]#["'`]\s*\}?/ },
  // generic placeholder language in code (not prose)
  {
    kind: "placeholder",
    re: /\b(coming soon|placeholder for|stubbed out|not yet (implemented|wired|hooked)|fake (data|response|impl)|hard[\s-]?coded for now)\b/i,
  },
  // alert-only handler standing in for real behavior
  { kind: "stub-alert", re: /=>\s*alert\s*\(/ },
  // empty-bodied NAMED function declaration on one line — `function save() {}`,
  // `async function handle(): void {}`. Scoped to `function` declarations (not
  // arrow `() => {}`, which is a common intentional no-op) to keep false
  // positives down while catching the "declared but never implemented" stub the
  // gate can't see (an empty function compiles clean).
  {
    kind: "empty-body",
    re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+\w+\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*\}/,
  },
];

export function scanStubs(diff: string, opts: { max?: number } = {}): StubFinding[] {
  const max = opts.max ?? 50;
  const out: StubFinding[] = [];
  if (!diff) return out;
  const seen = new Set<string>();
  let file = "";
  let scan = false;
  let newLine = 0;
  const push = (kind: string, snippet: string) => {
    const key = `${file}:${kind}:${snippet.trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line: newLine, kind, snippet: snippet.trim().slice(0, 160) });
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(raw);
      file = m?.[1] ?? "";
      scan = file !== "" && file !== "/dev/null" && scannablePath(file);
      newLine = 0;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("@@")) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m?.[1] !== undefined ? Number(m[1]) : newLine;
      continue;
    }
    if (!scan) continue;
    if (raw.startsWith("-")) continue; // removed line — doesn't advance new-file counter
    if (!raw.startsWith("+")) {
      newLine++; // context line
      continue;
    }
    const content = raw.slice(1);
    for (const rule of STUB_RULES) {
      if (rule.re.test(content)) {
        push(rule.kind, content);
        break;
      }
    }
    // bare placeholder return only in server/handler-ish files (too noisy elsewhere)
    if (isHandlerPath(file) && /^\s*return\s*(null|\[\s*\]|\{\s*\}|""|''|``)\s*;?\s*$/.test(content)) {
      push("empty-return", content);
    }
    if (out.length >= max) break;
    newLine++;
  }
  return out.slice(0, max);
}

/** Group stub findings into a compact block for the reviewer prompt. */
export function formatStubFindings(findings: StubFinding[]): string {
  if (!findings.length) return "";
  const byKind = new Map<string, StubFinding[]>();
  for (const f of findings) {
    const arr = byKind.get(f.kind) ?? [];
    arr.push(f);
    byKind.set(f.kind, arr);
  }
  const lines: string[] = [];
  for (const [kind, fs] of byKind) {
    lines.push(`- ${kind} (${fs.length}):`);
    for (const f of fs.slice(0, 8)) lines.push(`    ${f.file}:${f.line}  ${f.snippet}`);
  }
  return lines.join("\n");
}
