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
 * The tool-specific string a rule's `match` glob runs against — what the call
 * actually DOES, not just which tool: the command for bash, the path for file
 * tools, the URL for network tools. Undefined for tools with no natural scope
 * (a `match` rule then simply never applies to them).
 */
export function scopeString(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (toolName === "bash" && typeof o.command === "string") return o.command;
  if (typeof o.path === "string") return o.path;
  if (typeof o.url === "string") return o.url;
  if (toolName === "run_check" && typeof o.check === "string") return o.check;
  return undefined;
}

/**
 * Evaluates tool calls against the configured allow/deny/ask rules.
 *
 * Rules may scope by tool name (glob) and optionally by the call's CONTENT via
 * `match` — a glob over the command/path/URL (`{tool:"bash", match:"git commit*",
 * action:"allow"}`). Among the rules that match a call, precedence is
 * **deny > ask > allow** regardless of order — a broad allow can never shadow a
 * targeted deny (order-dependent first-match was too easy to misconfigure).
 *
 * With no matching rule a tool falls back to `defaultAction` (side-effecting
 * tools: the approvalMode; network read-only tools: allow — see the adapter).
 * For `ask`, a resolver is consulted; non-interactive runs auto-allow upstream.
 */
export class PermissionChecker {
  #rules: { tool: RegExp; match?: RegExp; action: PermissionRule["action"] }[];
  #resolve: PermissionResolver;
  #defaultAction: PermissionRule["action"];

  constructor(
    rules: PermissionRule[],
    resolver?: PermissionResolver,
    defaultAction: PermissionRule["action"] = "allow",
  ) {
    this.#rules = rules.map((r) => ({
      tool: globToRegExp(r.tool),
      ...(r.match ? { match: globToRegExp(r.match) } : {}),
      action: r.action,
    }));
    this.#resolve = resolver ?? (() => true);
    this.#defaultAction = defaultAction;
  }

  async check(
    toolName: string,
    input: unknown,
    opts: { fallback?: PermissionRule["action"] } = {},
  ): Promise<PermissionResult> {
    const scope = scopeString(toolName, input);
    const applicable = this.#rules.filter((r) => {
      if (!r.tool.test(toolName)) return false;
      // A content-scoped rule applies only when the call HAS that scope and it
      // matches; a name-only rule applies to every call of the tool.
      if (r.match) return scope !== undefined && r.match.test(scope);
      return true;
    });
    // Specificity first: content-scoped rules decide before name-only rules —
    // an allowlist entry like {tool:"bash", match:"git *"} must beat a generic
    // {tool:"bash", action:"ask"} for matching commands, or allowlists would
    // still prompt. Within a tier, deny > ask > allow, order-independent.
    const decide = (rules: typeof applicable): "allow" | "deny" | "ask" | undefined =>
      rules.some((r) => r.action === "deny")
        ? "deny"
        : rules.some((r) => r.action === "ask")
          ? "ask"
          : rules.length
            ? "allow"
            : undefined;
    const action =
      decide(applicable.filter((r) => r.match)) ??
      decide(applicable.filter((r) => !r.match)) ??
      opts.fallback ??
      this.#defaultAction;
    if (action === "allow") return { allowed: true };
    if (action === "deny") return { allowed: false, reason: "denied by policy" };
    const ok = await this.#resolve({ toolName, input });
    return ok ? { allowed: true } : { allowed: false, reason: "denied by user" };
  }
}
