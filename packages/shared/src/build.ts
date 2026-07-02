/**
 * Build-intelligence data types shared across packages (tools ← core ← cli).
 * Pure data — no behavior — so they can ride UIEvents and cross the core/TUI
 * boundary without dragging implementation along.
 */

/** The repo's real, detected commands. A field is absent when nothing
 * trustworthy was detected — never guessed. */
export interface CodeCommands {
  install?: string;
  build?: string;
  test?: string;
  typecheck?: string;
  lint?: string;
}

export type CheckName = keyof CodeCommands;

/** Deterministic recon of a working directory: how this repo actually builds,
 * tests, and lints itself. Produced by one batched probe; any probe failure
 * degrades its field to null rather than failing the run. */
export interface RepoProfile {
  /** Directory is effectively empty (only dotfiles/README/LICENSE). */
  greenfield: boolean;
  primaryLanguage: string | null;
  packageManager: string | null;
  framework: string | null;
  commands: CodeCommands;
  monorepo: { tool: string | null; packages: string[] };
  git: { isRepo: boolean; branch: string | null; dirty: boolean };
  /** Detected conventions worth telling agents ("formatted with prettier"…). */
  conventions: string[];
  /** Which manifest files were found (package.json, pyproject.toml, …). */
  manifestFiles: string[];
}

/** A check's raw output distilled to a compact verdict the model reads in one
 * step: pass/fail, counts, and the first few failures — never a log dump. */
export interface CheckSignal {
  check: CheckName;
  command: string;
  pass: boolean;
  failed: number;
  total: number;
  firstFailures: string[];
  durationMs: number;
}

/** The green-gate's overall outcome for one gated turn. */
export interface GateSummary {
  /** "green" = every check passed; "red" = at least one failed;
   * "unverified" = no trustworthy check command exists to run;
   * "aborted" = the run was interrupted (Esc / timeout) before it reached a
   * verdict — a terminal NON-verdict that must never be read as green or red
   * (a check killed mid-run exits nonzero, which would otherwise scan as a false
   * RED; a break between checks would otherwise bucket as a false GREEN). */
  outcome: "green" | "red" | "unverified" | "aborted";
  checks: CheckSignal[];
  /** Which fix round produced this result (0 = the original turn). */
  round: number;
}

/** Structured handoff a subagent/task reports for its dependents: the
 * load-bearing facts propagate verbatim; the full report is pull-only. */
export interface Handoff {
  keyFacts: string[];
  filesTouched: string[];
  openQuestions: string[];
}

/** A deterministic "this looks like dead/unfinished code" signal in a diff. */
export interface StubFinding {
  file: string;
  line: number;
  kind: string;
  snippet: string;
}
