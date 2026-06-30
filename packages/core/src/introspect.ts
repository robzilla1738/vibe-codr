import type { Config } from "@vibe/config";
import type { Message, SessionUsage, ToolDefinition } from "@vibe/shared";
import type { ModelPrice } from "@vibe/config";
import type { McpServerStatus } from "./mcp.ts";

/** A two-column "key   value" row, aligned to the widest key. */
function rows(pairs: [string, string][]): string {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${k.padEnd(width)}   ${v}`).join("\n");
}

export interface StatusInfo {
  sessionId: string;
  model: string;
  mode: string;
  approvalMode: string;
  goal: string | null;
  cwd: string;
  toolCount: number;
  readOnlyCount: number;
  mcpServerCount: number;
  skillCount: number;
  commandCount: number;
  agentCount: number;
  usage: SessionUsage;
  /** Estimated tokens currently in the model context. */
  contextTokens?: number;
  /** The active model's context window, when known from the catalog. */
  contextWindow?: number;
}

/** Compact "k"-scaled token count, e.g. 90_000 -> "90k". */
function ktok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`;
}

/**
 * Render a context-window fill line: "45% · 90k / 200k" when the window is
 * known, else just the used estimate. Shared by `/status` and `/context`.
 */
export function formatContextUsage(
  used: number | undefined,
  window: number | undefined,
): string {
  if (used === undefined) return "—";
  if (!window) return `~${ktok(used)} tokens (window unknown)`;
  const pct = Math.min(100, Math.round((used / window) * 100));
  return `${pct}% · ~${ktok(used)} / ${ktok(window)}`;
}

/** `/status` — a compact, aligned overview of the live session. */
export function formatStatus(info: StatusInfo): string {
  const u = info.usage;
  const tokens = `${u.inputTokens} in / ${u.outputTokens} out${
    u.cachedInputTokens ? ` (${u.cachedInputTokens} cached)` : ""
  }`;
  const cost = u.costUSD > 0 ? `$${u.costUSD.toFixed(u.costUSD < 1 ? 4 : 2)}` : "—";
  return `vibe-codr session\n${rows([
    ["session", info.sessionId],
    ["model", info.model],
    ["mode", info.mode],
    ["approvals", info.approvalMode],
    ["goal", info.goal ? info.goal : "—"],
    ["cwd", info.cwd],
    ["tools", `${info.toolCount} (${info.readOnlyCount} read-only)`],
    ["mcp", `${info.mcpServerCount} server(s)`],
    ["skills", `${info.skillCount}`],
    ["commands", `${info.commandCount}`],
    ["agents", `${info.agentCount}`],
    ["context", formatContextUsage(info.contextTokens, info.contextWindow)],
    ["tokens", tokens],
    ["cost", cost],
  ])}`;
}

/** `/cost` — token + cost breakdown, with the per-1M rate when known. */
export function formatCost(
  usage: SessionUsage,
  model: string,
  price?: ModelPrice,
): string {
  const lines: [string, string][] = [
    ["model", model],
    ["input tokens", `${usage.inputTokens}`],
    ["output tokens", `${usage.outputTokens}`],
    ["total tokens", `${usage.totalTokens}`],
  ];
  if (usage.cachedInputTokens) {
    lines.push(["cached input", `${usage.cachedInputTokens}`]);
  }
  if (price?.input !== undefined || price?.output !== undefined) {
    lines.push([
      "rate /1M",
      `$${price?.input ?? "?"} in · $${price?.output ?? "?"} out`,
    ]);
  }
  lines.push([
    "cost",
    usage.costUSD > 0
      ? `$${usage.costUSD.toFixed(usage.costUSD < 1 ? 4 : 2)}`
      : "$0 (no pricing for this model)",
  ]);
  return `Session cost\n${rows(lines)}`;
}

const SECRET_KEYS = new Set(["apiKey", "tokenFile", "tokenPath"]);
/** Whole maps whose *values* are sensitive: MCP `env`, and HTTP `headers`
 * (Authorization, account ids, etc). Every value under these is masked. */
const MASK_VALUES_UNDER = new Set(["env", "headers"]);

/** Deep-clone a config value, masking any secret-bearing fields. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k) && typeof v === "string") {
        out[k] = "***";
      } else if (MASK_VALUES_UNDER.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.keys(v).map((kk) => [kk, "***"]));
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/** `/config` — the effective merged config as pretty JSON, secrets masked. */
export function formatConfig(config: Config): string {
  return `Effective config (secrets masked):\n${JSON.stringify(
    redact(config),
    null,
    2,
  )}`;
}

/** `/tools` — tools available in the current mode, grouped by side-effect. */
export function formatTools(tools: ToolDefinition[], mode: string): string {
  if (!tools.length) return "No tools available.";
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const readOnly = sorted.filter((t) => t.readOnly);
  const writes = sorted.filter((t) => !t.readOnly);
  const fmt = (t: ToolDefinition) =>
    `  ${t.name} — ${firstLine(t.description)}`;
  const sections: string[] = [`Tools available in ${mode} mode:`];
  if (readOnly.length) {
    sections.push(`read-only:\n${readOnly.map(fmt).join("\n")}`);
  }
  if (writes.length) {
    sections.push(`side-effecting:\n${writes.map(fmt).join("\n")}`);
  }
  return sections.join("\n");
}

/** `/mcp` — connection status for each configured server. */
export function formatMcp(
  status: McpServerStatus[],
  configuredNames: string[],
): string {
  if (!configuredNames.length) {
    return "No MCP servers configured. Add them under `mcp.servers` in config (stdio command, or a url with transport http/sse).";
  }
  const byName = new Map(status.map((s) => [s.name, s]));
  const lines = configuredNames.map((name) => {
    const s = byName.get(name);
    if (!s) return `  ○ ${name} — not started`;
    if (s.connected) {
      const extra =
        (s.resourceCount ? `, ${s.resourceCount} resource(s)` : "") +
        (s.promptCount ? `, ${s.promptCount} prompt(s)` : "");
      return `  ● ${name} — connected, ${s.toolCount} tool(s)${extra}`;
    }
    return `  ✗ ${name} — failed${s.error ? `: ${s.error}` : ""}`;
  });
  return `MCP servers:\n${lines.join("\n")}`;
}

/** `/permissions` — default approval mode plus any explicit rules. */
export function formatPermissions(
  rules: { tool: string; action: string }[],
  approvalMode: string,
): string {
  const head = `Permissions (default for unmatched side-effecting tools: ${approvalMode}):`;
  if (!rules.length) {
    return `${head}\n  (no explicit rules — read-only tools always run; others follow the default)`;
  }
  const lines = rules.map((r) => `  ${r.action.padEnd(5)} ${r.tool}`);
  return `${head}\n${lines.join("\n")}`;
}

/** A simple `name — description` list, or a fallback when empty. */
export function formatNamedList(
  title: string,
  items: { name: string; description: string }[],
  empty: string,
): string {
  if (!items.length) return empty;
  const lines = items
    .map((i) => `  ${i.name} — ${firstLine(i.description)}`)
    .join("\n");
  return `${title}\n${lines}`;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/** `/export` — render the conversation history as a Markdown transcript. */
export function formatTranscript(
  history: Message[],
  meta: { sessionId: string; model: string; goal: string | null },
): string {
  const lines: string[] = [
    `# vibe-codr transcript`,
    "",
    `- session: ${meta.sessionId}`,
    `- model: ${meta.model}`,
    ...(meta.goal ? [`- goal: ${meta.goal}`] : []),
    "",
  ];
  for (const msg of history) {
    const heading =
      msg.role === "user"
        ? "## User"
        : msg.role === "assistant"
          ? "## Assistant"
          : msg.role === "tool"
            ? "### Tool"
            : "## System";
    const body: string[] = [];
    for (const part of msg.parts) {
      if (part.type === "text" && part.text.trim()) body.push(part.text.trim());
      else if (part.type === "reasoning" && part.text.trim()) {
        body.push(`_(reasoning)_ ${part.text.trim()}`);
      } else if (part.type === "tool-call") {
        body.push(`\`${part.toolName}(${firstLine(JSON.stringify(part.input ?? {}))})\``);
      } else if (part.type === "tool-result") {
        const out =
          typeof part.output === "string" ? part.output : JSON.stringify(part.output);
        body.push(`> ${firstLine(out)}`);
      }
    }
    if (body.length) lines.push(heading, "", body.join("\n\n"), "");
  }
  return lines.join("\n");
}

/** One line of the `/doctor` report: ok=true ✓, false ✗, null ○ (n/a). */
export interface DoctorCheck {
  label: string;
  ok: boolean | null;
  detail: string;
}

/** `/doctor` — render the environment health checklist. */
export function formatDoctor(checks: DoctorCheck[]): string {
  const glyph = (ok: boolean | null) => (ok === true ? "✓" : ok === false ? "✗" : "○");
  const width = Math.max(0, ...checks.map((c) => c.label.length));
  const lines = checks.map(
    (c) => `  ${glyph(c.ok)} ${c.label.padEnd(width)}  ${c.detail}`,
  );
  const problems = checks.filter((c) => c.ok === false).length;
  const summary =
    problems === 0
      ? "All checks passed."
      : `${problems} issue(s) found — see ✗ above.`;
  return `vibe-codr doctor\n${lines.join("\n")}\n\n${summary}`;
}
