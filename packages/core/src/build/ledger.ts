import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeCommands } from "@vibe/shared";

/**
 * Cross-run repo memory: after a green gate the engine persists which commands
 * actually ran green (plus observed conventions and flaky tests), keyed by a
 * manifest signature, so the next session's recon starts where this one ended.
 * Project-local (`.vibe/ledger.jsonl`, append-only, malformed-line-tolerant) —
 * the repo IS the identity, so no cross-repo key is needed.
 *
 * Invalidation is deliberately finer than agentswarm's whole-hash discard: a
 * record also carries a hash of just the scripts/manifest section its commands
 * derive from (`commandsHash`), so bumping a dependency (which changes the full
 * manifest hash) does NOT throw away still-valid confirmed commands — only an
 * actual change to how the repo builds does.
 */
export interface LedgerRecord {
  /** Signature of the full build setup (commands + manifests + pm + language). */
  manifestHash: string;
  /** Signature of only the command-bearing manifest content (scripts section). */
  commandsHash: string;
  at: number;
  /** Commands confirmed to run green this session. */
  commands: CodeCommands;
  conventions: string[];
  flakyTests?: string[];
}

export function ledgerPath(cwd: string): string {
  return join(cwd, ".vibe", "ledger.jsonl");
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** A cheap signature of the whole build setup — changes when anything about how
 * the repo builds changes. */
export function manifestHash(parts: {
  commands: CodeCommands;
  manifestFiles: string[];
  packageManager: string | null;
  primaryLanguage: string | null;
}): string {
  return sha1(JSON.stringify(parts));
}

/** Signature of only the command-derivation inputs: the detected command set
 * itself (which is a pure function of the scripts/manifest sections). Two
 * setups that detect identical commands share it — the finer invalidation key. */
export function commandsHash(commands: CodeCommands): string {
  return sha1(JSON.stringify(commands));
}

export function appendLedger(cwd: string, rec: LedgerRecord): void {
  try {
    mkdirSync(join(cwd, ".vibe"), { recursive: true });
    appendFileSync(ledgerPath(cwd), `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* best-effort — repo memory never blocks a session */
  }
}

/**
 * Latest usable facts. An exact `manifestHash` match is authoritative; failing
 * that, a record whose `commandsHash` still matches contributes its confirmed
 * commands (a dep bump changed the full hash but not how the repo builds).
 * Returns null when neither matches — stale facts must not mislead recon.
 */
export function loadLedger(
  cwd: string,
  current: { manifestHash: string; commandsHash: string },
): LedgerRecord | null {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(cwd), "utf8");
  } catch {
    return null;
  }
  let exact: LedgerRecord | null = null;
  let compatible: LedgerRecord | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: LedgerRecord;
    try {
      rec = JSON.parse(line) as LedgerRecord;
    } catch {
      continue;
    }
    if (rec.manifestHash === current.manifestHash) {
      if (!exact || (rec.at ?? 0) > (exact.at ?? 0)) exact = rec;
    } else if (rec.commandsHash === current.commandsHash) {
      if (!compatible || (rec.at ?? 0) > (compatible.at ?? 0)) compatible = rec;
    }
  }
  return exact ?? compatible;
}

/**
 * Merge confirmed facts into a freshly-detected command set: detection wins
 * when it found something; confirmed facts fill the gaps (e.g. a test command
 * recon missed but a prior green run established). Pure.
 */
export function mergeConfirmedCommands(
  detected: CodeCommands,
  confirmed: CodeCommands,
): { commands: CodeCommands; filled: (keyof CodeCommands)[] } {
  const out: CodeCommands = { ...detected };
  const filled: (keyof CodeCommands)[] = [];
  for (const k of ["install", "build", "typecheck", "test", "lint"] as (keyof CodeCommands)[]) {
    if (!out[k] && confirmed[k]) {
      out[k] = confirmed[k];
      filled.push(k);
    }
  }
  return { commands: out, filled };
}
