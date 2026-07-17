import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { EngineSnapshot } from "../../shared/types";

interface ContinuityRoots {
  sourceRoot: string;
  sourceStateRoot: string;
  targetRoot: string;
  targetStateRoot: string;
}

/** Fail closed before ownership crosses from the local engine to Cloud. */
export function assertCloudSessionContinuity(
  local: EngineSnapshot,
  remote: EngineSnapshot,
  roots: ContinuityRoots,
): void {
  if (remote.sessionId !== local.sessionId) {
    throw new Error(`Cloud session continuity failed: expected ${local.sessionId}, received ${remote.sessionId}`);
  }
  if (remote.model !== local.model) {
    throw new Error(`Cloud session continuity failed: model changed from ${local.model} to ${remote.model}`);
  }
  if (remote.subagentModel !== local.subagentModel) {
    throw new Error("Cloud session continuity failed: subagent model changed during handoff");
  }
  if (remote.mode !== local.mode) {
    throw new Error(`Cloud session continuity failed: mode changed from ${local.mode} to ${remote.mode}`);
  }
  if (remote.theme !== local.theme) {
    throw new Error(`Cloud session continuity failed: theme changed from ${local.theme} to ${remote.theme}`);
  }
  if (remote.accentColor !== local.accentColor) {
    throw new Error("Cloud session continuity failed: accent color changed during handoff");
  }
  if (remote.details !== local.details) {
    throw new Error(`Cloud session continuity failed: transcript density changed from ${local.details} to ${remote.details}`);
  }
  const localHistory = historySignature(local.history, [
    [roots.sourceStateRoot, "<state>"],
    [roots.sourceRoot, "<workspace>"],
  ]);
  const remoteHistory = historySignature(remote.history, [
    [roots.targetStateRoot, "<state>"],
    [roots.targetRoot, "<workspace>"],
  ]);
  if (remoteHistory !== localHistory) {
    throw new Error("Cloud session continuity failed: conversation history changed during handoff");
  }
}

export function cloudProjectStateRoot(stateRoot: string, cwd: string): string {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return resolve(stateRoot, hash);
}

function historySignature(history: EngineSnapshot["history"], replacements: Array<[string, string]>): string {
  const normalized = normalizePortableValue(history, replacements
    .map(([from, to]) => [resolve(from), to] as const)
    .sort((a, b) => b[0].length - a[0].length));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizePortableValue(value: unknown, replacements: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") {
    for (const [from, to] of replacements) {
      if (value === from || value.startsWith(`${from}${sep}`)) return to + value.slice(from.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizePortableValue(item, replacements));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizePortableValue(item, replacements)]),
  );
}
