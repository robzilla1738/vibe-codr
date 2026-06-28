import type { Config } from "@vibe/config";
import type { SessionUsage, ToolDefinition } from "@vibe/shared";
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

/** Deep-clone a config value, masking any secret-bearing fields. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) && typeof v === "string" ? "***" : redact(v);
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
    return "No MCP servers configured. Add them under `mcp.servers` in config (stdio or SSE/HTTP).";
  }
  const byName = new Map(status.map((s) => [s.name, s]));
  const lines = configuredNames.map((name) => {
    const s = byName.get(name);
    if (!s) return `  ○ ${name} — not started`;
    if (s.connected) return `  ● ${name} — connected, ${s.toolCount} tool(s)`;
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
