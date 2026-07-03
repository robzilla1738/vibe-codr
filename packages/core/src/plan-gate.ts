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
 * Evidence, not effort: a fast plan grounded in six fetched sources passes; a
 * slow plan grounded in nothing doesn't. Self-contained requests ("rename this
 * function") triage to no requirements and are never taxed with research
 * theater. After {@link MAX_REJECTIONS} bounces the plan is allowed through
 * with `ungrounded: true` so a model that genuinely can't drive the research
 * tools (or an offline session) is warned about, never deadlocked.
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

/** Rejections allowed before an ungrounded plan is let through with a warning. */
const MAX_REJECTIONS = 2;

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
  /** True in a workspace with no real code yet — a code-read requirement would
   * be unsatisfiable, so it's waived. */
  #greenfield: boolean;

  constructor(opts: { greenfield?: boolean } = {}) {
    this.#greenfield = opts.greenfield ?? false;
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

  /**
   * Gate a `present_plan` call. Missing evidence → reject with instructions
   * (bounded by {@link MAX_REJECTIONS}, then allow with `ungrounded: true`).
   */
  evaluate(plan: { sources?: { url: string }[] }): PlanGateVerdict {
    const missing: string[] = [];
    const t = this.#telemetry;
    // Only real http(s) URLs count as cited evidence — a junk string like
    // `{url:"appease"}` or a `data:` URL must not satisfy the sources requirement.
    const validSources = (plan.sources ?? []).filter((s) => /^https?:\/\/\S+\.\S+/i.test(s?.url ?? ""));
    if (this.#triage.needsWeb) {
      if (t.webSearches === 0) {
        missing.push(
          "run web_search now (use recencyDays for anything time-sensitive) and read the results — this request depends on current real-world facts your training data cannot know",
        );
      } else if (!validSources.length) {
        missing.push(
          "pass the real web page URLs your plan's facts rest on in present_plan's `sources` array (http(s) links) — a researched plan must show its evidence",
        );
      }
    }
    if (this.#triage.needsVersions && t.packageLookups === 0 && t.webSearches === 0) {
      missing.push(
        "look up the real latest versions with package_info (npm/PyPI) before naming any framework or dependency version",
      );
    }
    if (this.#triage.needsCode && !this.#greenfield && t.fileReads === 0 && t.scoutSpawns === 0) {
      missing.push(
        "read the relevant files (read/grep/glob/repo_map) — this plan is about the existing codebase and must be grounded in what's actually there",
      );
    }
    if (!missing.length) return { allow: true };
    if (this.#rejections >= MAX_REJECTIONS) {
      return { allow: true, ungrounded: true };
    }
    this.#rejections++;
    const attemptsLeft = MAX_REJECTIONS - this.#rejections + 1;
    return {
      allow: false,
      reason:
        `Plan NOT presented — required grounding is missing. Do the following, then call present_plan again:\n` +
        missing.map((m) => `- ${m}`).join("\n") +
        `\n(Why: ${this.#triage.reasons.join("; ") || "the request needs real evidence"}.` +
        ` ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before the plan is shown with an "ungrounded" warning.)`,
    };
  }
}
