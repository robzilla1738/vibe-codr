import type { PermissionResult } from "@vibe/shared";
import type { PermissionRule } from "@vibe/config";

/** Asks the user to approve a tool call. Returns true to allow. */
export type PermissionResolver = (req: {
  toolName: string;
  input: unknown;
}) => boolean | Promise<boolean>;

/** Convert a simple glob (only `*`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Evaluates tool calls against the configured allow/deny/ask rules. Permissions
 * are opt-in restrictions: with no matching rule a tool is allowed (plan-mode
 * gating already removes dangerous capabilities up front). For `ask`, a
 * resolver is consulted; in non-interactive runs the default resolver allows
 * and the decision is surfaced as a notice by the caller.
 */
export class PermissionChecker {
  #rules: { test: RegExp; action: PermissionRule["action"] }[];
  #resolve: PermissionResolver;

  constructor(rules: PermissionRule[], resolver?: PermissionResolver) {
    this.#rules = rules.map((r) => ({
      test: globToRegExp(r.tool),
      action: r.action,
    }));
    this.#resolve = resolver ?? (() => true);
  }

  async check(toolName: string, input: unknown): Promise<PermissionResult> {
    const rule = this.#rules.find((r) => r.test.test(toolName));
    const action = rule?.action ?? "allow";
    if (action === "allow") return { allowed: true };
    if (action === "deny") return { allowed: false, reason: "denied by policy" };
    const ok = await this.#resolve({ toolName, input });
    return ok ? { allowed: true } : { allowed: false, reason: "denied by user" };
  }
}
