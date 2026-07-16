import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CodeCommands } from "@vibe/shared";

/**
 * Cross-run repo memory: after a green gate the engine persists which commands
 * actually ran green (plus observed conventions and flaky tests), keyed by a
 * manifest signature, so the next session's recon starts where this one ended.
 * Project-local (`.vibe/ledger/`, atomic per-record, malformed-record-tolerant)
 * — the repo IS the identity, so no cross-repo key is needed.
 *
 * Invalidation is deliberately finer than agentswarm's whole-hash discard: a
 * record also carries a hash of just the scripts/manifest section its commands
 * derive from (`commandsHash`), so bumping a dependency (which changes the full
 * manifest hash) does NOT throw away still-valid confirmed commands — only an
 * actual change to how the repo builds does.
 *
 * Crash safety (BUG-049): each record is written as its own temp+rename file
 * under `.vibe/ledger/`, mirroring the orchestration journal fix. A crash
 * mid-write can leave only an ignored `.tmp` file (the durable `.json` never
 * landed), never a torn JSONL line. The loader reads sorted dir entries and
 * still tolerates a half-written record via per-file JSON parsing. Legacy
 * `.vibe/ledger.jsonl` is still read (a single migration pass) so the upgrade
 * doesn't drop pre-fix state; latest-by-`at` wins across both stores.
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

/** Pre-fix (BUG-049) append-only JSONL ledger — kept for one-time migration. */
export function ledgerPath(cwd: string): string {
  return join(cwd, ".vibe", "ledger.jsonl");
}

/** Crash-safe per-record ledger dir (post BUG-049). */
function ledgerDir(cwd: string): string {
  return join(cwd, ".vibe", "ledger");
}

let ledgerWriteSeq = 0;

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
    const dir = ledgerDir(cwd);
    mkdirSync(dir, { recursive: true });
    const seq = ledgerWriteSeq++;
    // Stable sort key: zero-padded timestamp (latest writes sort last), then pid
    // + a per-process counter + random tail so two records in the same
    // millisecond never collide (the same trick the orchestration journal uses).
    const stamp = String(rec.at ?? Date.now()).padStart(13, "0");
    const base = `${stamp}-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`;
    const tmp = join(dir, `${base}.tmp`);
    const final = join(dir, `${base}.json`);
    writeFileSync(tmp, JSON.stringify(rec), "utf8");
    renameSync(tmp, final);
  } catch {
    /* best-effort — repo memory never blocks a session */
  }
}

/** Read every per-record ledger file (sorted by filename) — newer records come
 * last because the filename stamp is zero-padded. A torn `.tmp` (crash before
 * rename) is skipped by the `.json` filter; a corrupted `.json` (disk error, not
 * a torn write — temp+rename makes the latter impossible) is skipped via the
 * per-file JSON parse, never throwing on a bad record. */
function readPerFileRecords(cwd: string): LedgerRecord[] {
  const dir = ledgerDir(cwd);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const recs: LedgerRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      recs.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as LedgerRecord);
    } catch {
      // skip malformed record
    }
  }
  return recs;
}

/** Read the legacy in-place JSONL ledger (BUG-049 migration). Malformed lines
 * are skipped, never parsing the whole stream as one JSON. Same tolerance the
 * loader always had, so a torn last line from a pre-fix crash still loads the
 * valid prefix. */
function readLegacyJsonlRecords(cwd: string): LedgerRecord[] {
  const path = ledgerPath(cwd);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const recs: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // skip malformed line
    }
  }
  return recs;
}

/**
 * Latest usable facts. An exact `manifestHash` match is authoritative; failing
 * that, a record whose `commandsHash` still matches contributes its confirmed
 * commands (a dep bump changed the full hash but not how the repo builds).
 * Returns null when neither matches — stale facts must not mislead recon. Reads
 * BOTH the post-fix per-record dir (the source of truth) and the legacy JSONL
 * (one-time migration); latest-by-`at` wins across the union.
 */
export function loadLedger(
  cwd: string,
  current: { manifestHash: string; commandsHash: string },
): LedgerRecord | null {
  const recs = [...readLegacyJsonlRecords(cwd), ...readPerFileRecords(cwd)];
  let exact: LedgerRecord | null = null;
  let compatible: LedgerRecord | null = null;
  for (const rec of recs) {
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
