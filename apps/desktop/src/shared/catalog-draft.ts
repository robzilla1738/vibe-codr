/**
 * Catalog draft detectors + option builders — TUI-faithful picker semantics
 * ported from vibe-codr/packages/tui (app.tsx + commands-catalog).
 * Enhanced with opencode-inspired grouping: favorites, recent, provider buckets.
 */

import type {
  AgentInfo,
  McpServerInfo,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
} from "./types";

/* ── Favorites / recent — localStorage backed, opencode-style ─────────── */

const FAV_KEY = "vibe.models.favorites";
const RECENT_KEY = "vibe.models.recent";
const MAX_RECENTS = 8;
const MAX_FAVORITES = 24;
const MAX_STORED_MODEL_ID_CHARS = 512;

export function normalizeStoredModelIds(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > MAX_STORED_MODEL_ID_CHARS) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function safeReadJsonStringArray(key: string, maxItems: number): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStoredModelIds(parsed, maxItems);
  } catch {
    return [];
  }
}

function safeWriteJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota or no storage — ignore
  }
}

export function getModelFavorites(): string[] {
  if (typeof localStorage === "undefined") return [];
  return safeReadJsonStringArray(FAV_KEY, MAX_FAVORITES);
}

export function getModelRecents(): string[] {
  if (typeof localStorage === "undefined") return [];
  return safeReadJsonStringArray(RECENT_KEY, MAX_RECENTS);
}

export function toggleModelFavorite(fullId: string): boolean {
  const list = getModelFavorites();
  const next = list.includes(fullId)
    ? list.filter((v) => v !== fullId)
    : [fullId, ...list].slice(0, MAX_FAVORITES);
  safeWriteJson(FAV_KEY, next);
  return next.includes(fullId);
}

export function pushModelRecent(fullId: string): void {
  const list = getModelRecents().filter((v) => v !== fullId);
  list.unshift(fullId);
  safeWriteJson(RECENT_KEY, list.slice(0, MAX_RECENTS));
}

export function isModelFree(model: ModelSummary): boolean {
  const hay = `${model.id} ${model.name} ${(model as { variant?: string }).variant ?? ""}`.toLowerCase();
  return hay.includes("free") || hay.includes(":free");
}

export function isSectionOption(opt: CatalogOption): boolean {
  return Boolean(opt.section) || opt.key.startsWith("__section__");
}

export interface LimitedCatalogOptions {
  options: CatalogOption[];
  omitted: number;
  totalItems: number;
}

/** Bound mounted catalog rows while preserving group labels and the current model. */
export function limitCatalogOptions(
  options: readonly CatalogOption[],
  maxActionable = 400,
): LimitedCatalogOptions {
  const limit = Math.max(0, Math.floor(maxActionable));
  const totalItems = options.reduce(
    (count, option) => count + (isSectionOption(option) ? 0 : 1),
    0,
  );
  if (totalItems <= limit) {
    return { options: [...options], omitted: 0, totalItems };
  }

  const visible: CatalogOption[] = [];
  let currentSection: CatalogOption | null = null;
  let emittedSectionKey: string | null = null;
  let ordinaryShown = 0;
  let itemsShown = 0;
  for (const option of options) {
    if (isSectionOption(option)) {
      currentSection = option;
      continue;
    }
    if (ordinaryShown >= limit && !option.current) continue;
    if (currentSection && emittedSectionKey !== currentSection.key) {
      visible.push(currentSection);
      emittedSectionKey = currentSection.key;
    }
    visible.push(option);
    itemsShown += 1;
    if (!option.current || ordinaryShown < limit) ordinaryShown += 1;
  }

  return {
    options: visible,
    omitted: Math.max(0, totalItems - itemsShown),
    totalItems,
  };
}

/** Format a context window as a compact label: `1M` / `400k` / `128k` (TUI parity: fmtContext). */
function fmtContext(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/** Model picker target: main session, shared subagent default, or a named agent. */
export type ModelPickerTarget = "main" | "sub" | { agent: string };

export type ModelPick = { query: string; target: ModelPickerTarget };

/**
 * Detect when the draft opens the `/model` picker and which agent it configures.
 * Returns null for `/model key …`, `/model refresh`, and `/model agent` without a name.
 */
export function modelPicker(draft: string, target: "main" | "sub" = "main"): ModelPick | null {
  const am = /^\/model\s+agent\s+(\S+)\s*(.*)$/is.exec(draft);
  if (am) return { query: (am[2] ?? "").trim(), target: { agent: am[1]! } };
  const m = /^\/models?(?:\s+(.*))?$/is.exec(draft);
  if (!m) return null;
  const q = (m[1] ?? "").trim();
  const first = q.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "key" || first === "refresh" || first === "agent") return null;
  // `/model sub [filter]` — TUI uses Tab for sub; Electron also accepts typed `sub`.
  if (first === "sub") {
    const rest = q.slice(3).trim();
    return { query: rest, target: "sub" };
  }
  return { query: q, target };
}

/** `/providers [filter]` → provider list menu. */
export function providersPickerQuery(draft: string): string | null {
  const m = /^\/providers?(?:\s+(.*))?$/is.exec(draft);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * `/agents [filter]` → named-agents menu.
 * `/agents new …` is a create command, not the picker.
 */
export function agentsPickerQuery(draft: string): string | null {
  const m = /^\/agents?(?:\s+(.*))?$/is.exec(draft);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (/^new(\s|$)/i.test(rest)) return null;
  return rest;
}

/**
 * `/skills [filter]` only — singular `/skill` is the invocation the menu prefills.
 */
export function skillsPickerFilter(draft: string): string | null {
  const m = /^\/skills(?:\s+(.*))?$/is.exec(draft);
  return m ? (m[1] ?? "").trim() : null;
}

/** Bare `/mcp` opens the roster (optional filter after space). */
export function mcpPickerQuery(draft: string): string | null {
  const m = /^\/mcp(?:\s+(.*))?$/is.exec(draft);
  return m ? (m[1] ?? "").trim() : null;
}

export interface CatalogOption {
  /** When true, this row is the currently selected model for the picker target. */
  current?: boolean;
  key: string;
  primary: string;
  secondary: string;
  /** Render as non-actionable group header (section). */
  section?: boolean;
  /** True when model is free-tier — shows Free badge. */
  free?: boolean;
  /** Provider bucket for grouping (model list). */
  providerId?: string;
  /** Submit this line to the engine (or via EngineCommand path). */
  line?: string;
  /** Prefill composer draft without submitting. */
  prefill?: string;
  /** Open models picker after choose (agents → model agent). */
  openModelsForAgent?: string;
  /** Open guided provider setup instead of asking users to type a key command. */
  setupProviderId?: string;
  /** Send typed EngineCommand instead of a slash line. */
  command?:
    | { type: "set-model"; model: string }
    | { type: "set-subagent-model"; model: string | null }
    | { type: "set-agent-model"; name: string; model: string | null };
}

export function mcpSecondary(server: McpServerInfo): string {
  const status = server.error
    ? "error"
    : server.connected
      ? "connected"
      : server.configured
        ? "disconnected"
        : "not configured";
  const bits = [status];
  if (server.connected || server.toolCount > 0) {
    bits.push(`${server.toolCount} tools`);
  }
  if (server.resourceCount > 0) bits.push(`${server.resourceCount} resources`);
  if (server.promptCount > 0) bits.push(`${server.promptCount} prompts`);
  if (server.error) bits.push(server.error);
  return bits.join(" · ");
}

function finiteCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeMcpServer(raw: Record<string, unknown>): McpServerInfo {
  const connected = Boolean(raw.connected);
  const configured = raw.configured != null ? Boolean(raw.configured) : true;
  return {
    name: String(raw.name ?? ""),
    connected,
    configured,
    toolCount: finiteCount(raw.toolCount ?? raw.tools ?? 0),
    resourceCount: finiteCount(raw.resourceCount),
    promptCount: finiteCount(raw.promptCount),
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

export function modelCatalogOptions(
  items: ModelSummary[],
  target: ModelPickerTarget,
  current?: string | null,
): CatalogOption[] {
  const byFull = new Map<string, ModelSummary>();
  for (const m of items) byFull.set(`${m.providerId}/${m.id}`, m);

  const makeRow = (model: ModelSummary): CatalogOption => {
    const full = `${model.providerId}/${model.id}`;
    const isCurrent = current != null && current !== "" && full === current;
    const secParts = [model.name, fmtContext(model.contextWindow)];
    if (isCurrent) secParts.unshift("current");
    const sec = secParts.filter(Boolean).join(" · ");
    const free = isModelFree(model);
    if (typeof target === "object") {
      return {
        key: full,
        primary: full,
        secondary: sec,
        free,
        providerId: model.providerId,
        current: isCurrent,
        command: { type: "set-agent-model", name: target.agent, model: full },
      };
    }
    if (target === "sub") {
      return {
        key: full,
        primary: full,
        secondary: sec,
        free,
        providerId: model.providerId,
        current: isCurrent,
        command: { type: "set-subagent-model", model: full },
      };
    }
    return {
      key: full,
      primary: full,
      secondary: isCurrent ? `current · ${model.name ?? ""}`.replace(/ · $/, "") : (model.name ?? ""),
      free,
      providerId: model.providerId,
      current: isCurrent,
      command: { type: "set-model", model: full },
    };
  };

  // Agent/sub targets keep flat list + clear — no favorites/recent grouping
  if (typeof target === "object" || target === "sub") {
    const rows: CatalogOption[] = items.map(makeRow);
    rows.unshift({
      key: "__clear__",
      primary: "Clear → inherit",
      secondary:
        typeof target === "object"
          ? `Agent "${target.agent}" uses session model`
          : "Subagents use main session model",
      command:
        typeof target === "object"
          ? { type: "set-agent-model", name: target.agent, model: null }
          : { type: "set-subagent-model", model: null },
    });
    return rows;
  }

  // Main model picker — opencode-inspired grouping: Favorites, Recent, by provider
  const favFulls = getModelFavorites();
  const recentFulls = getModelRecents().filter((f) => !favFulls.includes(f));

  const favRows: CatalogOption[] = [];
  for (const full of favFulls) {
    const m = byFull.get(full);
    if (m) favRows.push(makeRow(m));
  }

  const recentRows: CatalogOption[] = [];
  for (const full of recentFulls) {
    const m = byFull.get(full);
    if (m) recentRows.push(makeRow(m));
  }

  // Remaining grouped by provider (opencode first, then alpha)
  const seen = new Set([...favFulls, ...recentFulls]);
  const byProvider = new Map<string, ModelSummary[]>();
  for (const m of items) {
    const full = `${m.providerId}/${m.id}`;
    if (seen.has(full)) continue;
    const arr = byProvider.get(m.providerId) ?? [];
    arr.push(m);
    byProvider.set(m.providerId, arr);
  }

  const providerKeys = [...byProvider.keys()].sort((a, b) => {
    if (a === "opencode") return -1;
    if (b === "opencode") return 1;
    return a.localeCompare(b);
  });

  const out: CatalogOption[] = [];
  if (favRows.length) {
    out.push({ key: "__section__fav", primary: "Favorites", secondary: "", section: true });
    out.push(...favRows);
  }
  if (recentRows.length) {
    out.push({ key: "__section__recent", primary: "Recent", secondary: "", section: true });
    out.push(...recentRows);
  }
  for (const pid of providerKeys) {
    const models = byProvider.get(pid)!;
    if (providerKeys.length > 1) {
      out.push({ key: `__section__${pid}`, primary: pid, secondary: "", section: true });
    }
    for (const m of models) out.push(makeRow(m));
  }

  out.unshift({
    key: "__setup_provider__",
    primary: "Set up another provider…",
    secondary: "API key, subscription, or custom endpoint",
    setupProviderId: "",
  });

  // Fallback: if no grouping produced anything (empty fav/recent only)
  if (out.length === 0) return items.map(makeRow);
  return out;
}

export function providerCatalogOptions(items: ProviderInfo[]): CatalogOption[] {
  return items.map((provider) => {
    const ready = provider.configured || provider.keyless;
    return {
      key: provider.id,
      primary: provider.id,
      secondary: ready
        ? provider.keyless
          ? "keyless · local"
          : `key set · ${provider.env[0] ?? ""}`
        : `no key — set ${provider.env[0] ?? "key"}`,
      ...(ready
        ? { prefill: `/model ${provider.id}/` }
        : { setupProviderId: provider.id }),
    };
  });
}

export function agentCatalogOptions(items: AgentInfo[]): CatalogOption[] {
  return [
    {
      key: "new-agent",
      primary: "New agent",
      secondary: "Create a file in .vibe/agents",
      prefill: "/agents new ",
    },
    ...items.map((agent) => ({
      key: agent.name,
      primary: agent.name,
      secondary: `${agent.model ?? "Inherit model"} · ${agent.description}`,
      prefill: `/model agent ${agent.name} `,
      openModelsForAgent: agent.name,
    })),
  ];
}

export function skillCatalogOptions(items: SkillInfo[]): CatalogOption[] {
  return items.map((skill) => ({
    key: skill.name,
    primary: skill.name,
    secondary: skill.description,
    prefill: `/skill ${skill.name} `,
  }));
}

export function mcpCatalogOptions(items: McpServerInfo[]): CatalogOption[] {
  return items.map((server) => ({
    key: server.name,
    primary: server.name,
    secondary: mcpSecondary(server),
  }));
}

export function modelTargetLabel(target: ModelPickerTarget): string {
  if (typeof target === "object") return `Agent: ${target.agent}`;
  return target === "sub" ? "Subagents" : "Main session";
}

export function currentModelForTarget(
  target: ModelPickerTarget,
  main: string,
  subagentModel: string | undefined,
  agents: AgentInfo[],
): string | undefined {
  if (typeof target === "object") {
    return agents.find((a) => a.name === target.agent)?.model ?? undefined;
  }
  if (target === "sub") return subagentModel;
  return main || undefined;
}
