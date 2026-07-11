/**
 * Natural-language + dotted-key config mutations for goal / loop / plan (and a
 * few related knobs). Used by `/config …`, `/goal max …`, and `/loop defaults …`
 * so users can say "set goal max rounds to 15" without editing JSON.
 *
 * Deliberately small surface: only the settings we introduced for thoroughness
 * and bounds — not a free-form JSON patch language.
 */

export type ConfigNlShow = {
  kind: "show";
  /** Optional subsection key (`goal` | `loop` | `plan`), or whole config. */
  section?: "goal" | "loop" | "plan";
};

export type ConfigNlSet = {
  kind: "set";
  /** Nested patch suitable for writeGlobalConfig / live Object.assign. */
  patch: Record<string, unknown>;
  /** One-line confirmation for the notice. */
  description: string;
};

export type ConfigNlResult = ConfigNlShow | ConfigNlSet | { kind: "error"; message: string };

/** Normalize filler words so "set the goal max rounds to 15" ≈ "goal max rounds 15". */
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/[:=]+/g, " ")
    .replace(/\b(please|set|the|a|an|to|as|is|of|for|default|defaults)\b/gi, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseBool(token: string): boolean | null {
  if (/^(on|true|yes|1|enable|enabled)$/i.test(token)) return true;
  if (/^(off|false|no|0|disable|disabled)$/i.test(token)) return false;
  return null;
}

function parseIntToken(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Parse a free-form config fragment. Returns null when the text is empty
 * (caller should show full config). Non-empty garbage → `{ kind: "error" }`.
 */
export function parseConfigNatural(args: string): ConfigNlResult | null {
  const raw = args.trim();
  if (!raw) return null;

  // Explicit show / help
  if (/^(show|get|list|help|\?)$/i.test(raw)) return { kind: "show" };
  if (/^(show|get|list)\s+(goal|loop|plan)\b/i.test(raw)) {
    const sec = raw.match(/\b(goal|loop|plan)\b/i)![1]!.toLowerCase() as "goal" | "loop" | "plan";
    return { kind: "show", section: sec };
  }
  if (/^(goal|loop|plan)$/i.test(raw)) {
    return { kind: "show", section: raw.toLowerCase() as "goal" | "loop" | "plan" };
  }

  const n = normalize(raw);

  // ── goal ──────────────────────────────────────────────────────────────
  // goal max [rounds] N | goal rounds N | goal.maxRounds N
  {
    const m =
      n.match(/^goal\s+(?:max\s+)?(?:rounds?|maxrounds?)?\s*(\d+)$/) ??
      n.match(/^goal\s+maxrounds?\s+(\d+)$/);
    if (m) {
      const v = parseIntToken(m[1]!, 1, 100);
      if (v === null) {
        return { kind: "error", message: "goal.maxRounds must be an integer 1–100." };
      }
      return {
        kind: "set",
        patch: { goal: { maxRounds: v } },
        description: `goal.maxRounds = ${v}`,
      };
    }
  }
  // goal plan first on|off | goal planFirst false
  {
    const m = n.match(/^goal\s+plan\s*first\s+(\w+)$/);
    if (m) {
      const b = parseBool(m[1]!);
      if (b === null) {
        return { kind: "error", message: "goal.planFirst expects on/off (or true/false)." };
      }
      return {
        kind: "set",
        patch: { goal: { planFirst: b } },
        description: `goal.planFirst = ${b}`,
      };
    }
  }

  // ── loop ──────────────────────────────────────────────────────────────
  // loop [default] max N | loop max unlimited|off|0
  {
    const m = n.match(/^loop\s+(?:default\s+)?max\s+(\w+)$/);
    if (m) {
      const tok = m[1]!;
      if (/^(unlimited|off|none|inf(inite)?)$/i.test(tok)) {
        return {
          kind: "set",
          patch: { loop: { defaultMax: 0 } },
          description: "loop.defaultMax = 0 (unlimited by default)",
        };
      }
      const v = parseIntToken(tok, 0, 1000);
      if (v === null) {
        return {
          kind: "error",
          message: "loop.defaultMax must be 0–1000 (0 = unlimited default).",
        };
      }
      return {
        kind: "set",
        patch: { loop: { defaultMax: v } },
        description:
          v === 0 ? "loop.defaultMax = 0 (unlimited by default)" : `loop.defaultMax = ${v}`,
      };
    }
  }
  // loop until fail[ures] N | loop max until eval failures N
  {
    const m = n.match(/^loop\s+(?:until\s+)?(?:eval\s+)?fail(?:ure)?s?\s+(\d+)$/);
    if (m) {
      const v = parseIntToken(m[1]!, 1, 50);
      if (v === null) {
        return { kind: "error", message: "loop.maxUntilEvalFailures must be 1–50." };
      }
      return {
        kind: "set",
        patch: { loop: { maxUntilEvalFailures: v } },
        description: `loop.maxUntilEvalFailures = ${v}`,
      };
    }
  }

  // ── plan ──────────────────────────────────────────────────────────────
  {
    const m = n.match(/^plan\s+min\s+(?:code\s+)?touches?\s+(\d+)$/);
    if (m) {
      const v = parseIntToken(m[1]!, 1, 20);
      if (v === null) {
        return { kind: "error", message: "plan.minCodeTouches must be 1–20." };
      }
      return {
        kind: "set",
        patch: { plan: { minCodeTouches: v } },
        description: `plan.minCodeTouches = ${v}`,
      };
    }
  }
  {
    const m = n.match(/^plan\s+require\s+web(?:\s*fetch)?\s+(\w+)$/);
    if (m) {
      const b = parseBool(m[1]!);
      if (b === null) {
        return { kind: "error", message: "plan.requireWebFetch expects on/off." };
      }
      return {
        kind: "set",
        patch: { plan: { requireWebFetch: b } },
        description: `plan.requireWebFetch = ${b}`,
      };
    }
  }
  {
    const m = n.match(/^plan\s+require\s+package(?:\s*info)?\s+(\w+)$/);
    if (m) {
      const b = parseBool(m[1]!);
      if (b === null) {
        return { kind: "error", message: "plan.requirePackageInfo expects on/off." };
      }
      return {
        kind: "set",
        patch: { plan: { requirePackageInfo: b } },
        description: `plan.requirePackageInfo = ${b}`,
      };
    }
  }
  {
    const m = n.match(/^plan\s+allow\s+ungrounded\s+(\w+)$/);
    if (m) {
      const b = parseBool(m[1]!);
      if (b === null) {
        return { kind: "error", message: "plan.allowUngrounded expects on/off." };
      }
      return {
        kind: "set",
        patch: { plan: { allowUngrounded: b } },
        description: `plan.allowUngrounded = ${b}`,
      };
    }
  }
  {
    const m = n.match(/^plan\s+max\s+rejections?\s+(\d+)$/);
    if (m) {
      const v = parseIntToken(m[1]!, 0, 10);
      if (v === null) {
        return { kind: "error", message: "plan.maxRejections must be 0–10." };
      }
      return {
        kind: "set",
        patch: { plan: { maxRejections: v } },
        description: `plan.maxRejections = ${v}`,
      };
    }
  }

  // Dotted keys: goal.maxRounds 15 | plan.requireWebFetch false
  {
    const m = raw
      .trim()
      .match(
        /^(?:set\s+)?(goal|loop|plan)\.(maxRounds|planFirst|defaultMax|maxUntilEvalFailures|minCodeTouches|requireWebFetch|requirePackageInfo|allowUngrounded|maxRejections)\s*[:=]?\s*(\S+)\s*$/i,
      );
    if (m) {
      const section = m[1]!.toLowerCase();
      const key = m[2]!;
      const val = m[3]!;
      const boolKeys = new Set([
        "planFirst",
        "requireWebFetch",
        "requirePackageInfo",
        "allowUngrounded",
      ]);
      if (boolKeys.has(key)) {
        const b = parseBool(val);
        if (b === null) {
          return { kind: "error", message: `${section}.${key} expects on/off (true/false).` };
        }
        return {
          kind: "set",
          patch: { [section]: { [key]: b } },
          description: `${section}.${key} = ${b}`,
        };
      }
      const ranges: Record<string, [number, number]> = {
        maxRounds: [1, 100],
        defaultMax: [0, 1000],
        maxUntilEvalFailures: [1, 50],
        minCodeTouches: [1, 20],
        maxRejections: [0, 10],
      };
      const range = ranges[key];
      if (!range) {
        return { kind: "error", message: `Unknown key ${section}.${key}.` };
      }
      const v = parseIntToken(val, range[0], range[1]);
      if (v === null) {
        return {
          kind: "error",
          message: `${section}.${key} must be an integer ${range[0]}–${range[1]}.`,
        };
      }
      return {
        kind: "set",
        patch: { [section]: { [key]: v } },
        description: `${section}.${key} = ${v}`,
      };
    }
  }

  return {
    kind: "error",
    message:
      "Could not parse config phrase. Examples:\n" +
      "  /config goal max rounds 15\n" +
      "  /config goal plan first off\n" +
      "  /config loop default max 20\n" +
      "  /config plan min code touches 5\n" +
      "  /config plan require webfetch on\n" +
      "  /config plan.allowUngrounded false\n" +
      "  /config show goal",
  };
}

/**
 * Goal-slash settings only (so `/goal max 15` configures without starting a run).
 * Returns null when the args should be treated as goal text.
 */
export function parseGoalSettings(args: string): ConfigNlResult | null {
  const t = args.trim();
  if (/^(settings|config|show)$/i.test(t)) return { kind: "show", section: "goal" };

  // Unambiguous settings shapes — never steal real goal prose.
  if (
    /^(?:max(?:\s+rounds?)?|rounds?|maxRounds)\s+\d+$/i.test(t) ||
    /^(?:plan[- ]?first|planFirst)\s+\w+$/i.test(t) ||
    /^goal\./i.test(t)
  ) {
    // Reuse the full parser by prefixing "goal " when missing.
    const prefixed = /^goal\b/i.test(t) ? t : `goal ${t}`;
    return parseConfigNatural(prefixed);
  }
  return null;
}

/**
 * Loop defaults settings: `/loop defaults`, `/loop default max 20`.
 * Returns null when args should start a loop.
 */
export function parseLoopSettings(args: string): ConfigNlResult | null {
  const t = args.trim();
  if (/^(defaults?|settings|config|show)$/i.test(t)) {
    return { kind: "show", section: "loop" };
  }
  if (/^defaults?\b/i.test(t) || /^(?:default\s+)?max\s+\w+$/i.test(t)) {
    const body = t.replace(/^defaults?\s*/i, "").trim() || t;
    const prefixed = /^loop\b/i.test(body) ? body : `loop ${body}`;
    return parseConfigNatural(prefixed);
  }
  // "max until failures 3" style without starting a prompt loop
  if (/^(?:until\s+)?(?:eval\s+)?fail(?:ure)?s?\s+\d+$/i.test(t)) {
    return parseConfigNatural(`loop ${t}`);
  }
  return null;
}

/** Format the goal/loop/plan subsection for notices. */
export function formatConfigSection(
  config: {
    goal: { maxRounds: number; planFirst: boolean };
    loop: { defaultMax: number; maxUntilEvalFailures: number };
    plan: {
      minCodeTouches: number;
      requireWebFetch: boolean;
      requirePackageInfo: boolean;
      allowUngrounded: boolean;
      maxRejections: number;
    };
  },
  section?: "goal" | "loop" | "plan",
): string {
  const goal = [
    `goal.maxRounds = ${config.goal.maxRounds}`,
    `goal.planFirst = ${config.goal.planFirst}`,
  ].join("\n");
  const loop = [
    `loop.defaultMax = ${config.loop.defaultMax}${config.loop.defaultMax === 0 ? " (unlimited)" : ""}`,
    `loop.maxUntilEvalFailures = ${config.loop.maxUntilEvalFailures}`,
  ].join("\n");
  const plan = [
    `plan.minCodeTouches = ${config.plan.minCodeTouches}`,
    `plan.requireWebFetch = ${config.plan.requireWebFetch}`,
    `plan.requirePackageInfo = ${config.plan.requirePackageInfo}`,
    `plan.allowUngrounded = ${config.plan.allowUngrounded}`,
    `plan.maxRejections = ${config.plan.maxRejections}`,
  ].join("\n");
  if (section === "goal")
    return `Goal settings:\n${goal}\n\nChange: /goal max 15 · /config goal plan first off`;
  if (section === "loop") {
    return (
      `Loop defaults:\n${loop}\n\n` +
      "Change: /loop default max 20 · /loop default max unlimited · /config loop until failures 5"
    );
  }
  if (section === "plan") {
    return (
      `Plan thoroughness:\n${plan}\n\n` +
      "Change: /config plan min code touches 5 · /config plan require webfetch on"
    );
  }
  return (
    `Steering settings:\n${goal}\n${loop}\n${plan}\n\n` +
    "Natural language: /config goal max rounds 15 · /config loop default max 20 · /config plan min code touches 5"
  );
}

/** Deep-merge a small nested patch into a live Config-like object. */
export function applyConfigPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const cur = (target[k] ??= {}) as Record<string, unknown>;
      Object.assign(cur, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
