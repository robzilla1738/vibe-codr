import type { PlanGateVerdict } from "@vibe/shared";

/**
 * Plan-readiness gate — the code-enforced half of the grounded planning
 * pipeline. The PLAN_MODE prompt asks the model to research before presenting;
 * this gate makes that a contract instead of a suggestion: a deterministic
 * triage of the user's request decides what evidence the plan must be grounded
 * in, the session's observed tool telemetry decides whether that evidence was
 * actually gathered, and `present_plan` is REJECTED (with concrete, actionable
 * instructions) until it was. Weak local models that skip straight to
 * presenting get bounced back into GATHER instead of shipping a 20-second
 * hallucinated plan.
 *
 * Evidence, not effort: a fast plan grounded in real sources passes; a slow
 * plan grounded in nothing doesn't. Self-contained requests ("rename this
 * function") triage lightly and are never taxed with research theater. After
 * {@link MAX_REJECTIONS} bounces the plan is allowed through with
 * `ungrounded: true` so a model that genuinely can't drive the research tools
 * (or an offline session) is warned about, never deadlocked.
 */

/** What a plan request must be grounded in, per deterministic triage. */
export interface PlanTriage {
  /** Time-sensitive / current-events / real-world-target facts → web research. */
  needsWeb: boolean;
  /** Names a stack/package or scaffolds a new app → real version lookups. */
  needsVersions: boolean;
  /** References the existing codebase → at least one file actually read. */
  needsCode: boolean;
  /** Human/model-readable one-liners explaining each triggered requirement. */
  reasons: string[];
}

/** Research counters observed from the session's tool stream during plan mode. */
export interface ResearchTelemetry {
  webSearches: number;
  webFetches: number;
  packageLookups: number;
  fileReads: number;
  scoutSpawns: number;
}

/** Payload shape `present_plan` may pass into the gate (beyond sources). */
export interface PlanPresentPayload {
  plan?: string;
  sources?: { url: string }[];
  assumptions?: string[];
  /** Areas/files the plan will touch (or "greenfield"). */
  files?: string[];
  /** How success will be verified (checks, manual steps). */
  verification?: string;
  /** Key decisions with one-line rationales. */
  decisions?: string[];
}

/** Rejections allowed before an ungrounded plan is let through with a warning. */
const MAX_REJECTIONS = 2;

/** Minimum distinct code-touch tool calls when `needsCode` (or one scout). */
export const MIN_CODE_TOUCHES = 3;

/** Options that tune thoroughness floors (from config.plan, overridable in tests). */
export interface PlanGateOptions {
  greenfield?: boolean;
  minCodeTouches?: number;
  requireWebFetch?: boolean;
  requirePackageInfo?: boolean;
  allowUngrounded?: boolean;
  maxRejections?: number;
}

/** Relative-date / currency words: the request is anchored to the real clock.
 * Deliberately excludes bare `breaking`/`ongoing` (code words: "breaking change",
 * "ongoing connection"); keeps `current`/`latest`/`live` (the false positives
 * they cause — "current directory", "latest commit" — cost only a bounce, while
 * missing "current price"/"latest version" ships a stale plan). */
const TIME_SENSITIVE =
  /\b(today|tonight|tomorrow|yesterday|this (week|weekend|month|morning|evening)|latest|newest|(most )?recent|current(ly)?|up[- ]to[- ]date|live|right now|as of)\b/i;

/** Current-events domains where facts move faster than any training set. Bare
 * dev-vocabulary words (`match`, `score`, `release`, `launch`, `announce`) were
 * dropped — they fire constantly on ordinary code and almost never mean a real
 * current event in a plan; the unambiguous sports/politics/market signals stay,
 * and "today's world cup match" is still caught by `world cup`. */
const CURRENT_EVENTS =
  /\b(news|world cup|olympics|playoffs?|super ?bowl|world series|grand prix|nba finals|tournament|standings|scoreboard|election|stock price|price of|weather|forecast)\b/i;

/** Named stacks/registries → versions must come from package_info/docs, not
 * memory. Excludes bare English/CS-overloaded names (`node`, `react`, `solid`,
 * `spring`, `express`) — they false-fire on "tree node", "react component",
 * "SOLID principles", "spring animation", "express the result". A greenfield
 * BUILD_REQUEST ("build a react app") still triggers needsVersions, so the real
 * signal is preserved without taxing every mention of a common word. The
 * UNAMBIGUOUS spellings that carry no false-positive risk (`node.js`/`nodejs`,
 * `spring boot`, `react 19`) ARE kept — only the bare English-overloaded forms
 * (`node`, `react`, `spring`, `express`, `solid` alone) were dropped. The
 * `react <digit>` version clause requires TWO digits (`\d{2}\b`): real React
 * majors are all ≥15, so "React 18/19" match while the SINGLE-digit verb sense
 * ("make it react 2 seconds", "react 3 times", "react 500 ms") no longer
 * false-fires. Two-digit English after "react" ("react 24 hours", "react 99
 * problems") can still trigger — accepted: it costs only one bounce (this
 * module's cheap direction), it isn't cleanly separable from a real "react 24"
 * that a future major will be, and MISSING a named React version ships a
 * stale-version plan (the expensive failure). See the P4-2 DECISION in the
 * audit ledger. */
const STACK_NAMES =
  /\b(next\.?js|node\.?js|nodejs|vue|svelte|angular|astro|nuxt|remix|vite|tailwind|typescript|bun|deno|fastify|spring ?boot|django|flask|fastapi|rails|laravel|npm|pypi|pip|cargo|crates?\.io|framer[- ]motion|prisma|drizzle|postgres|supabase|firebase)\b|\breact\s+v?\d{2}\b/i;

/** Greenfield build verbs + artifact nouns → stack choices are being made. */
const BUILD_REQUEST =
  /\b(build|create|make|scaffold|set ?up|bootstrap|generate)\b[\s\S]{0,80}\b(app|application|website|web ?site|web ?app|site|page|service|micro-?service|server|project|api|backend|frontend|dashboard|cli|tool)\b/i;

/** References to the existing workspace → the plan must have read real code. */
const CODE_REFERENCE =
  /\b(this (code(base)?|repo(sitory)?|project|file|function|class|module|component|test)|refactor|rename|fix the|the existing|our (code|app|api|service)|in (the )?src\b)\b/i;

/**
 * Deterministic, rules-first triage of one or more plan-mode user prompts.
 * Conservative on purpose: a false "needs research" taxes a trivial plan with
 * a bounced present; a false "self-contained" only loses the gate (the prompt
 * doctrine still asks for research), so triggers lean on explicit signals.
 */
export function triagePlanRequest(text: string): PlanTriage {
  const reasons: string[] = [];
  const timeSensitive = TIME_SENSITIVE.test(text);
  const currentEvents = CURRENT_EVENTS.test(text);
  const needsWeb = timeSensitive || currentEvents;
  if (timeSensitive) {
    reasons.push(
      "the request is anchored to the current date (\"today/latest/current\") — facts must come from a fresh web search, not training data",
    );
  } else if (currentEvents) {
    reasons.push(
      "the request references real-world events/data that move faster than training data — verify on the web",
    );
  }
  const namesStack = STACK_NAMES.test(text);
  const buildsNew = BUILD_REQUEST.test(text);
  const needsVersions = namesStack || buildsNew;
  if (namesStack) {
    reasons.push(
      "the request names a framework/package — get the real latest versions via package_info, never from memory",
    );
  } else if (buildsNew) {
    reasons.push(
      "the request scaffolds something new — ground the stack choice (versions, current APIs) via package_info or a web search",
    );
  }
  const needsCode = CODE_REFERENCE.test(text);
  if (needsCode) {
    reasons.push("the request references the existing codebase — read the relevant files first");
  }
  return { needsWeb, needsVersions, needsCode, reasons };
}

/** Tool-name → telemetry-counter routing for {@link PlanGate.recordToolUse}. */
const WEB_SEARCH_TOOLS = new Set(["web_search"]);
const WEB_FETCH_TOOLS = new Set(["webfetch", "crawl_docs"]);
const PACKAGE_TOOLS = new Set(["package_info"]);
const FILE_READ_TOOLS = new Set(["read", "grep", "glob", "ls", "repo_map"]);
const SCOUT_TOOLS = new Set(["spawn_subagent", "continue_subagent", "spawn_tasks"]);

/**
 * Per-plan-cycle gate state, owned by the Session and reset when the session
 * leaves plan mode. Prompts accumulate into a UNION triage (a revision round
 * inherits the original request's requirements) and telemetry accumulates
 * across the whole cycle (research done two turns ago still grounds the plan).
 */
export class PlanGate {
  #triage: PlanTriage = { needsWeb: false, needsVersions: false, needsCode: false, reasons: [] };
  #telemetry: ResearchTelemetry = {
    webSearches: 0,
    webFetches: 0,
    packageLookups: 0,
    fileReads: 0,
    scoutSpawns: 0,
  };
  #rejections = 0;
  /** True once a present_plan call was allowed this plan cycle (grounded or
   * ungrounded escape). The engine uses this for the end-of-turn present nudge:
   * a non-trivial cycle that never successfully presented gets a bounded push
   * to call present_plan instead of ending on free-form chat. */
  #presented = false;
  /** True in a workspace with no real code yet — a code-read requirement would
   * be unsatisfiable, so it's waived. */
  #greenfield: boolean;
  #minCodeTouches: number;
  #requireWebFetch: boolean;
  #requirePackageInfo: boolean;
  #allowUngrounded: boolean;
  #maxRejections: number;

  constructor(opts: PlanGateOptions = {}) {
    this.#greenfield = opts.greenfield ?? false;
    this.#minCodeTouches = opts.minCodeTouches ?? MIN_CODE_TOUCHES;
    this.#requireWebFetch = opts.requireWebFetch ?? true;
    this.#requirePackageInfo = opts.requirePackageInfo ?? true;
    this.#allowUngrounded = opts.allowUngrounded ?? true;
    this.#maxRejections = opts.maxRejections ?? MAX_REJECTIONS;
  }

  /** Fold a plan-mode user prompt into the (union) triage. */
  noteRequest(text: string): void {
    const t = triagePlanRequest(text);
    this.#triage = {
      needsWeb: this.#triage.needsWeb || t.needsWeb,
      needsVersions: this.#triage.needsVersions || t.needsVersions,
      needsCode: this.#triage.needsCode || t.needsCode,
      reasons: [...new Set([...this.#triage.reasons, ...t.reasons])],
    };
    // Each user prompt re-arms the rejection budget. Without this, one plan
    // that exhausted its bounces would permanently disarm the gate for every
    // later request in the same plan-mode stay — grounding enforcement would
    // silently degrade to prompt-only exactly where it's needed most.
    this.#rejections = 0;
    // A revision / new request must present again — a prior present_plan does
    // not cover the revised plan.
    this.#presented = false;
  }

  /** Count one successful tool call toward the research telemetry. */
  recordToolUse(toolName: string): void {
    if (WEB_SEARCH_TOOLS.has(toolName)) this.#telemetry.webSearches++;
    else if (WEB_FETCH_TOOLS.has(toolName)) this.#telemetry.webFetches++;
    else if (PACKAGE_TOOLS.has(toolName)) this.#telemetry.packageLookups++;
    else if (FILE_READ_TOOLS.has(toolName)) this.#telemetry.fileReads++;
    else if (SCOUT_TOOLS.has(toolName)) this.#telemetry.scoutSpawns++;
  }

  get triage(): PlanTriage {
    return this.#triage;
  }

  get telemetry(): ResearchTelemetry {
    return { ...this.#telemetry };
  }

  /** True when any triage requirement is active (structure checks apply). */
  get nonTrivial(): boolean {
    const t = this.#triage;
    return t.needsWeb || t.needsVersions || t.needsCode;
  }

  /** True when a present_plan call was allowed this cycle. */
  get presented(): boolean {
    return this.#presented;
  }

  /**
   * True when the engine should nudge the model to call present_plan: the
   * request needs grounding AND no successful present has landed yet.
   */
  needsPresentNudge(): boolean {
    return this.nonTrivial && !this.#presented;
  }

  /**
   * Gate a `present_plan` call. Missing evidence → reject with instructions
   * (bounded by {@link MAX_REJECTIONS}, then allow with `ungrounded: true`).
   */
  evaluate(
    plan: PlanPresentPayload = {},
    opts: { isHarvested?: (url: string) => boolean } = {},
  ): PlanGateVerdict {
    const missing: string[] = [];
    const t = this.#telemetry;
    // Only real http(s) URLs count as cited evidence — a junk string like
    // `{url:"appease"}` or a `data:` URL must not satisfy the sources requirement.
    const shapedSources = (plan.sources ?? []).filter((s) => /^https?:\/\/\S+\.\S+/i.test(s?.url ?? ""));
    // And a well-shaped URL only counts if it was ACTUALLY gathered this session
    // (the caller verifies against the source ledger) — otherwise one unrelated
    // web_search plus a fabricated link would present as fully grounded.
    const validSources = opts.isHarvested
      ? shapedSources.filter((s) => opts.isHarvested!(s.url))
      : shapedSources;
    if (this.#triage.needsWeb) {
      // Thorough web grounding: search OR fetch must happen, and (when configured)
      // at least one webfetch/crawl of an authoritative page, plus cited sources.
      if (t.webSearches === 0 && t.webFetches === 0) {
        missing.push(
          "run web_search or webfetch now (use recencyDays for anything time-sensitive) and read the results — this request depends on current real-world facts your training data cannot know",
        );
      } else if (this.#requireWebFetch && t.webFetches === 0) {
        missing.push(
          "webfetch (or crawl_docs) at least one authoritative page from your search results — snippet-only research is not enough for a thorough plan",
        );
      } else if (!validSources.length) {
        missing.push(
          shapedSources.length
            ? "the URLs in `sources` were never surfaced by this session's research — cite the actual URLs from your web_search/webfetch results, not links recalled from memory"
            : "pass the real web page URLs your plan's facts rest on in present_plan's `sources` array (http(s) links) — a researched plan must show its evidence",
        );
      }
    }
    if (this.#triage.needsVersions) {
      // package_info is the authoritative path; bare web_search is not enough
      // when requirePackageInfo is on (default).
      if (this.#requirePackageInfo && t.packageLookups === 0) {
        missing.push(
          t.webSearches > 0 || t.webFetches > 0
            ? "look up the real latest versions with package_info (npm/PyPI) — a web search alone is not authoritative for package versions"
            : "look up the real latest versions with package_info (npm/PyPI) before naming any framework or dependency version",
        );
      } else if (!this.#requirePackageInfo && t.packageLookups === 0 && t.webSearches === 0) {
        missing.push(
          "look up the real latest versions with package_info (npm/PyPI) or a web search before naming any framework or dependency version",
        );
      }
    }
    if (this.#triage.needsCode && !this.#greenfield) {
      // Thorough code grounding: one accidental `ls` is not enough. Either fan
      // out a scout or touch the tree enough times to have actually looked.
      if (t.scoutSpawns === 0 && t.fileReads < this.#minCodeTouches) {
        missing.push(
          `read the relevant code thoroughly (at least ${this.#minCodeTouches} read/grep/glob/repo_map calls, or spawn an explore scout) — this plan is about the existing codebase and must be grounded in what's actually there`,
        );
      }
    }

    // Structure contract for non-trivial plans: checklist steps + verification
    // path so approval has something executable, not a vague essay.
    if (this.nonTrivial) {
      const body = plan.plan ?? "";
      const checklist =
        (body.match(/^[ \t]{0,3}[-*]\s+\[ ?\]\s+\S+/gm) ?? []).length +
        (body.match(/^[ \t]{0,3}\d+\.\s+\S+/gm) ?? []).length;
      if (checklist < 2) {
        missing.push(
          "format the plan as at least two concrete ordered steps (`- [ ] step` checklist preferred, or `1. step`) so execution can seed a task list",
        );
      }
      const hasVerification =
        !!plan.verification?.trim() ||
        /\b(verif|test|typecheck|lint|check|acceptance|done when|success crit)/i.test(body);
      if (!hasVerification) {
        missing.push(
          "state how the result will be verified — pass present_plan's `verification` field, or include a verification/success-criteria section in the plan body",
        );
      }
      if (this.#triage.needsVersions) {
        const hasDecisions =
          (plan.decisions?.length ?? 0) > 0 ||
          /\b(decision|chose|choose|rationale|because|instead of|over )\b/i.test(body);
        if (!hasDecisions) {
          missing.push(
            "name key stack/version decisions with a one-line rationale each (present_plan `decisions` array, or a Decisions section in the plan)",
          );
        }
      }
      // If web/version facts are claimed without cited sources, assumptions
      // must be explicit so the user can see what is unverified.
      if ((this.#triage.needsWeb || this.#triage.needsVersions) && !validSources.length) {
        if (!(plan.assumptions && plan.assumptions.length > 0)) {
          missing.push(
            "pass non-empty `assumptions` for anything not backed by a harvested source URL — do not present unverified claims with the same confidence as researched fact",
          );
        }
      }
    }

    if (!missing.length) {
      this.#presented = true;
      return { allow: true };
    }
    if (this.#rejections >= this.#maxRejections) {
      if (this.#allowUngrounded) {
        this.#presented = true;
        return { allow: true, ungrounded: true };
      }
      // Hard block: keep rejecting with the same instructions (no silent pass).
      return {
        allow: false,
        reason:
          `Plan NOT presented — required grounding is still missing (ungrounded plans are disabled).\n` +
          missing.map((m) => `- ${m}`).join("\n") +
          `\n(Why: ${this.#triage.reasons.join("; ") || "the request needs real evidence"}. ` +
          `Enable plan.allowUngrounded via /config if you need the escape hatch.)`,
      };
    }
    this.#rejections++;
    const attemptsLeft = this.#maxRejections - this.#rejections + 1;
    const budgetHint =
      this.#allowUngrounded && attemptsLeft > 0
        ? ` ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before the plan is shown with an "ungrounded" warning.`
        : this.#allowUngrounded
          ? " Next present will be shown with an \"ungrounded\" warning."
          : " Ungrounded plans are disabled — keep gathering evidence.";
    return {
      allow: false,
      reason:
        `Plan NOT presented — required grounding is missing. Do the following, then call present_plan again:\n` +
        missing.map((m) => `- ${m}`).join("\n") +
        `\n(Why: ${this.#triage.reasons.join("; ") || "the request needs real evidence"}.` +
        `${budgetHint})`,
    };
  }
}
