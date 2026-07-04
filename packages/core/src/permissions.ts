import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { PermissionResult } from "@vibe/shared";
import type { PermissionRule } from "@vibe/config";

/** A resolver's verdict: plain boolean, or a denial carrying the user's typed
 * feedback — which becomes part of the deny reason the MODEL sees, so "no, use
 * the staging config" actually steers the next attempt. */
export type PermissionReply = boolean | { allowed: false; feedback?: string };

/** Asks the user to approve a tool call. Returns true to allow. */
export type PermissionResolver = (req: {
  toolName: string;
  input: unknown;
  /**
   * True when the `ask` came from an EXPLICIT permission rule (a human-authored
   * gate — `{action:"ask"}`), false when it's the frictionless default/fallback.
   * A non-interactive run fails an explicit gate CLOSED (there is no human to
   * approve) but auto-allows a default ask, so an authored `ask` can't silently
   * become `allow` in headless/CI.
   */
  explicit: boolean;
}) => PermissionReply | Promise<PermissionReply>;

/**
 * Convert a simple glob (only `*`) to an anchored RegExp, with flags chosen by
 * the rule's action so matching is ASYMMETRIC by security posture:
 *
 * - Protective actions (`deny`/`ask`) compile with `s` (dotAll) + `i`
 *   (case-insensitive) so they match BROADLY: a `deny match:"*git push*"` still
 *   catches `"true\ngit push …"` (a `.*` that would otherwise stop at the newline)
 *   and `webfetch match:"*internal.corp*"` still catches `INTERNAL.CORP` (DNS is
 *   case-insensitive). Erring toward matching keeps a kill-switch from being
 *   dodged by whitespace/case/newline tricks.
 * - `allow` compiles STRICTLY (no `s`, no `i`): an allowlist must match exactly,
 *   so `allow match:"git *"` does NOT auto-allow `"git status\nrm -rf /"` — the
 *   trailing command can't be smuggled past a permissive rule. An unmatched
 *   allow simply falls through to the deny/ask/default tiers.
 *
 * Note: command-string globbing over `bash` is best-effort, not a hard sandbox —
 * `git  push` (double space), `;git push`, `/usr/bin/git push` etc. still evade a
 * naive `match`. For real egress control prefer a scoped `deny` plus deny-by-
 * default, or the structured `git_push`/`git_commit` tools (whose synthetic scope
 * is not string-bypassable).
 */
function globToRegExp(glob: string, action: PermissionRule["action"]): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const flags = action === "allow" ? "" : "si";
  return new RegExp(`^${escaped}$`, flags);
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
  // Any tool whose effect is carried in a `command` field is command-scoped, not
  // just the `bash` builtin: an MCP shell/exec server (`mcp__shell__exec
  // {command:"git push …"}`) is always network-gated, so exposing its command
  // lets `match` rules actually govern it instead of being a silent no-op.
  if (typeof o.command === "string") {
    // A command that opts OUT of the OS sandbox (`dangerouslyUnsandboxed`) is a
    // deliberate kernel-backstop bypass, so it gets a distinct "!unsandboxed "
    // scope prefix: a rule can pre-authorize the unsafe variant on purpose
    // (`{match:"!unsandboxed *"}`) without a normal command allow silently
    // covering it (a strict allow like `git *` won't match the prefixed scope).
    return o.dangerouslyUnsandboxed === true ? `!unsandboxed ${o.command}` : o.command;
  }
  // The dedicated git_push/git_commit tools run a real git command with no
  // command/path/url field, so they'd otherwise have NO scope and slip past every
  // `match` rule (incl. the documented `git push*` egress deny). Expose the
  // command form they execute so an egress rule can govern them — either reusing
  // the bash-style glob (`{tool:"git_push", match:"git push*"}`) or a targeted
  // one (`match:"git push origin main*"}`).
  if (toolName === "git_push") {
    const parts = ["git", "push"];
    if (o.setUpstream) parts.push("-u");
    parts.push(typeof o.remote === "string" ? o.remote : "origin");
    if (typeof o.branch === "string") parts.push(o.branch);
    return parts.join(" ");
  }
  if (toolName === "git_commit") {
    return `git commit${o.all ? " -a" : ""} -m ${typeof o.message === "string" ? o.message : ""}`;
  }
  if (typeof o.path === "string") return o.path;
  if (typeof o.url === "string") return o.url;
  if (toolName === "run_check" && typeof o.check === "string") return o.check;
  return undefined;
}

/**
 * The canonical absolute path a file-tool call targets — resolved against `cwd`
 * with `../`/`./` normalized, matching what `edit`/`write` actually open. A
 * path-scoped rule is tested against THIS too, so an absolute deny (`/etc/*`)
 * can't be dodged by an equivalent relative spelling (`../../etc/passwd`).
 * Undefined for command/URL scopes (not filesystem paths). Pure given `cwd`.
 */
function resolvedPathScope(toolName: string, input: unknown, cwd: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (toolName === "bash" || typeof o.command === "string") return undefined;
  if (typeof o.path !== "string") return undefined;
  return resolve(cwd, o.path);
}

/**
 * The symlink-DEREFERENCED absolute path a file-tool call targets — the REAL file
 * the OS writes, not the lexical `resolve()` form. An in-tree symlink `link -> /etc`
 * makes `write link/passwd` lexically resolve to `<cwd>/link/passwd` (evading an
 * `/etc/*` deny) while the write actually lands in `/etc`; judging the realpath
 * closes that hole. Resolves symlinks in the longest EXISTING ancestor and
 * re-appends the not-yet-created tail (a new file doesn't exist yet, but its dir
 * might be a symlink). Best-effort and PURE-ish: any FS error (broken link,
 * permission) returns undefined so the caller falls back to the lexical forms
 * already in `scopes` — nothing regresses. Returns undefined when it adds nothing
 * new (identical to the lexical absolute).
 */
function realpathScope(toolName: string, input: unknown, cwd: string): string | undefined {
  const abs = resolvedPathScope(toolName, input, cwd);
  if (abs === undefined) return undefined;
  try {
    let dir = abs;
    const tail: string[] = [];
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the root, nothing exists
      tail.unshift(basename(dir));
      dir = parent;
    }
    const real = realpathSync(dir);
    const resolved = tail.length ? join(real, ...tail) : real;
    return resolved === abs ? undefined : resolved; // only add it when it differs
  } catch {
    return undefined;
  }
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
  #rules: {
    tool: RegExp;
    match?: RegExp;
    /** Literal-equality scope (no glob). Mutually exclusive with `match` in
     * practice; compared with `===` against the same scope forms `match` tests. */
    matchExact?: string;
    action: PermissionRule["action"];
  }[];
  #resolve: PermissionResolver;
  #defaultAction: PermissionRule["action"];
  #cwd: string;
  /** `#cwd` with its OWN symlinks resolved — the base for making a symlink-
   * dereferenced target relative. Using raw `#cwd` would leave `relative()` dirty
   * when cwd itself sits under a symlinked ancestor (macOS `/var`→`/private/var`,
   * an autofs `/home`), wrongly un-matching a legit relative allow. */
  #realCwd: string;

  constructor(
    rules: PermissionRule[],
    resolver?: PermissionResolver,
    defaultAction: PermissionRule["action"] = "allow",
    // Base for canonicalizing path-scoped rules (the session cwd `edit`/`write`
    // resolve against); defaults to the process cwd for the common single-root run.
    cwd: string = process.cwd(),
  ) {
    this.#rules = rules.map((r) => ({
      // The tool-name glob governs WHICH tool; a name-only rule is as protective
      // as its action, so compile it with the same action-aware flags (a
      // name-only `deny` on `mcp__*` should catch `MCP__x` too).
      tool: globToRegExp(r.tool, r.action),
      ...(r.match ? { match: globToRegExp(r.match, r.action) } : {}),
      // Exact rules carry the literal string (no glob compile) — the check
      // compares it with `===` against the same scope forms `match` tests.
      ...(r.matchExact !== undefined ? { matchExact: r.matchExact } : {}),
      action: r.action,
    }));
    this.#resolve = resolver ?? (() => true);
    this.#defaultAction = defaultAction;
    this.#cwd = cwd;
    this.#realCwd = (() => {
      try {
        return realpathSync(cwd);
      } catch {
        return cwd; // cwd doesn't exist yet (fresh/tests) — lexical base is fine
      }
    })();
  }

  async check(
    toolName: string,
    input: unknown,
    opts: { fallback?: PermissionRule["action"] } = {},
  ): Promise<PermissionResult> {
    const scope = scopeString(toolName, input);
    const canonical = resolvedPathScope(toolName, input, this.#cwd);
    // Path-scope forms, matched NEVER against the raw input (unnormalized: a
    // `src/../out.ts` spelling would match `src/*` though it resolves outside).
    // Two sets, because a SYMLINK makes the lexical path and the REAL target
    // diverge and the safe form differs by action:
    //   - `allowScopes` (the REAL target only) — an allow-LIST must CONFINE to the
    //     real path, so a planted `src/escape -> /outside` symlink can't match a
    //     `src/*` allow and write outside the sandbox.
    //   - `protectScopes` (lexical AND real) — a DENY/ASK must fire however the path
    //     is spelled OR wherever it really lands, so neither a `./`/`../`/absolute
    //     spelling nor a symlink can dodge a kill-switch.
    // A command/URL tool has no `canonical` (resolvedPathScope → undefined); there
    // the RAW scope (the bash command / URL / synthetic git command) IS the scope.
    let allowScopes: string[];
    let protectScopes: string[];
    if (canonical !== undefined) {
      const canonicalRel = relative(this.#cwd, canonical);
      const real = realpathScope(toolName, input, this.#cwd);
      // Real target forms; fall back to the lexical when no symlink diverges them.
      // The relative form is based on the REAL cwd so a project under a symlinked
      // ancestor still yields a clean `src/app.ts` (not `../../private/…/src/app.ts`).
      const realForms =
        real !== undefined ? [real, relative(this.#realCwd, real)] : [canonical, canonicalRel];
      allowScopes = realForms;
      protectScopes = [...new Set([canonical, canonicalRel, ...realForms])];
    } else {
      allowScopes = scope !== undefined ? [scope] : [];
      protectScopes = allowScopes;
    }
    const applicable = this.#rules.filter((r) => {
      if (!r.tool.test(toolName)) return false;
      // A content-scoped rule applies only when the call HAS a scope and one of the
      // action-appropriate forms matches; a name-only rule applies to every call.
      if (r.match) {
        const s = r.action === "allow" ? allowScopes : protectScopes;
        return s.some((x) => r.match!.test(x));
      }
      // An exact rule mirrors `match` but compares literally (`===`) against the
      // SAME action-appropriate scope forms — no glob broadening, so an approved
      // `rm build/*` matches ONLY the literal `rm build/*`, not `rm build/../x`.
      if (r.matchExact !== undefined) {
        const s = r.action === "allow" ? allowScopes : protectScopes;
        return s.some((x) => x === r.matchExact);
      }
      return true;
    });
    // DENY is an absolute kill-switch: any matching deny — scoped OR name-only —
    // wins over everything, so a blanket `{tool:"bash", action:"deny"}` can never
    // be punched through by a scoped `{tool:"bash", match:"git *", action:"allow"}`.
    // (Deny-with-exceptions is expressed by SCOPING the deny, not by allow-listing
    // past a broad deny — see the DECISIONS note in docs/audit-ledger.md.)
    const explicitDeny = applicable.some((r) => r.action === "deny");
    // Below deny, specificity decides allow-vs-ask: a content-scoped rule beats a
    // name-only one — an allowlist entry like {tool:"bash", match:"git *"} must
    // beat a generic {tool:"bash", action:"ask"} for matching commands, or
    // allowlists would still prompt. Within a tier, ask > allow.
    const decideAllowAsk = (rules: typeof applicable): "allow" | "ask" | undefined =>
      rules.some((r) => r.action === "ask")
        ? "ask"
        : rules.some((r) => r.action === "allow")
          ? "allow"
          : undefined;
    // A `matchExact` rule is content-scoped exactly like `match`, so it shares the
    // scoped tier (and its specificity edge over a name-only rule).
    const isScoped = (r: (typeof applicable)[number]): boolean =>
      !!r.match || r.matchExact !== undefined;
    const action = explicitDeny
      ? "deny"
      : (decideAllowAsk(applicable.filter(isScoped)) ??
        decideAllowAsk(applicable.filter((r) => !isScoped(r))) ??
        opts.fallback ??
        this.#defaultAction);
    // Whether the ask came from an EXPLICIT rule (a human-authored gate) vs the
    // default/fallback — the resolver treats the two differently when no human is
    // present (an explicit gate fails closed; a frictionless default auto-allows).
    let finalAction = action;
    let explicitAsk = action === "ask" && applicable.some((r) => r.action === "ask");
    // OS-sandbox escape hatch (dangerouslyUnsandboxed): a deliberate kernel
    // backstop bypass must never be silently green-lit. Unless a matching DENY
    // wins (absolute) or an applicable ALLOW rule SPECIFICALLY pre-authorizes the
    // "!unsandboxed " sentinel scope (`{match:"!unsandboxed *"}`), force an
    // EXPLICIT ask. "Specifically" is load-bearing: a sentinel-targeting allow
    // matches the `!unsandboxed <cmd>` form but NOT the bare command, whereas a
    // BLANKET allow (`match:"*"`, `match:"*npm*"`) matches both — the sentinel
    // scope IS applicable to it, but the user never wrote it to authorize the
    // UNSAFE variant, so it must NOT bypass the gate. Otherwise the call FAILS
    // CLOSED under auto/yolo and headless (the resolver denies an explicit gate
    // with no human). Reuses the existing explicit-ask path.
    const flagged =
      !!input &&
      typeof input === "object" &&
      (input as Record<string, unknown>).dangerouslyUnsandboxed === true;
    const bareCommand = flagged ? (input as Record<string, unknown>).command : undefined;
    // An applicable allow rule already matches the "!unsandboxed <cmd>" scope; it
    // deliberately pre-authorizes the unsafe variant only when it does NOT also
    // match the bare command — that gap is what separates a sentinel-targeting
    // rule from a blanket allow that merely happens to span the prefixed scope.
    const sentinelAuthorized =
      typeof bareCommand === "string" &&
      applicable.some(
        (r) =>
          r.action === "allow" &&
          ((!!r.match && !r.match.test(bareCommand)) ||
            (r.matchExact !== undefined && r.matchExact !== bareCommand)),
      );
    if (flagged && finalAction !== "deny" && !sentinelAuthorized) {
      finalAction = "ask";
      explicitAsk = true;
    }
    if (finalAction === "allow") return { allowed: true };
    if (finalAction === "deny") return { allowed: false, reason: "denied by policy" };
    const reply = await this.#resolve({ toolName, input, explicit: explicitAsk });
    if (reply === true) return { allowed: true };
    // A denial may carry the user's typed feedback; folding it into the reason
    // puts it in the tool-error the model reads, so the denial steers rather
    // than just blocks.
    const feedback = typeof reply === "object" ? reply.feedback?.trim() : undefined;
    return {
      allowed: false,
      reason: feedback ? `denied by user — ${feedback}` : "denied by user",
    };
  }
}
