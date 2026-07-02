import { join, resolve } from "node:path";
import type { EngineCommand, UIEvent } from "@vibe/shared";
import { ACCENT_PRESETS, THEME_NAMES } from "@vibe/shared";
import type { Config, ModelPrice } from "@vibe/config";
import type { CatalogService, ProviderRegistry, ModelInfo } from "@vibe/providers";
import type { SandboxPolicy, Toolset } from "@vibe/tools";
import type { CommandRegistry, SkillRegistry } from "@vibe/plugins";
import type { Session } from "./session.ts";
import { helpText, formatModelList, initProject } from "./commands.ts";
import {
  formatStatus,
  formatContextUsage,
  formatCost,
  formatConfig,
  formatTools,
  formatMcp,
  formatPermissions,
  formatNamedList,
  formatTranscript,
  formatDoctor,
  type DoctorCheck,
} from "./introspect.ts";
import type { NamedAgent } from "./agents.ts";
import { MAX_SKILL_BODY } from "./session-tools.ts";
import { searchSessions, formatRecall } from "./recall.ts";
import { formatMemoryHits } from "./memory-search.ts";
import type { MemoryService } from "./memory-service.ts";
import { loadMemorySources, formatMemory } from "./memory.ts";
import { reasoningCategory } from "./model-tuning.ts";
import type { CheckpointManager } from "./checkpoints.ts";
import type { SessionStore } from "./store.ts";
import type { GitRunResult } from "./git-info.ts";
import type { McpServerStatus } from "./mcp.ts";
import type { LspStatus } from "./diagnostics.ts";
import { crashDoctorCheck, recentCrashes } from "./crash.ts";
import { readUpdateCache, updateDoctorCheck } from "./update-check.ts";

/** Char cap for a diff embedded into a `/review` prompt — bounds the token cost
 * of reviewing a large working tree (the model reads specific files for more). */
const REVIEW_DIFF_CAP = 20_000;

/**
 * The minimal Engine surface the slash-command handlers need.
 *
 * The Engine keeps ownership of all private state; this handle exposes only the
 * read accessors and operations the command layer actually touches, so the
 * command module stays decoupled from Engine internals. The property accessors
 * return the Engine's *live* references — mutating `config` through the handle
 * mutates the Engine's config, which several handlers (`/model`, `/approvals`,
 * `/reasoning`, `/theme`, `/accent`) rely on.
 */
export interface EngineHandle {
  /** The live, shared config object (handlers mutate it in place). */
  readonly config: Config;
  /** The active session. */
  readonly session: Session;
  /** Workspace root. */
  readonly cwd: string;
  /** Custom + plugin slash commands. */
  readonly commands: CommandRegistry;
  /** Loaded skills (invocable as `/<name>`). */
  readonly skills: SkillRegistry;
  /** models.dev catalog service. */
  readonly catalog: CatalogService;
  /** The active toolset. */
  readonly toolset: Toolset;
  /** Provider registry. */
  readonly registry: ProviderRegistry;
  /** Named-subagent roster (live map). */
  readonly agents: Map<string, NamedAgent>;
  /** Long-term memory service, when available. */
  readonly memory: MemoryService | undefined;
  /** Checkpoint manager (git snapshots) for /undo, /diff, /review, /doctor. */
  readonly checkpoints: CheckpointManager;
  /** Saved-session store for /resume. */
  readonly store: SessionStore;
  /** Resolved OS-sandbox policy (for /doctor). */
  readonly sandbox: SandboxPolicy;

  /** Emit a UI notice. */
  notice(message: string, level?: "info" | "warn" | "error"): void;
  /** Emit a raw UI event. */
  emit(event: UIEvent): void;
  /** Route an EngineCommand back through the engine (e.g. /compact). */
  send(command: EngineCommand): void;
  /** Forget all session `always`-allow grants — called when approvals are
   * re-gated to `ask` so a prior "always allow" can't bypass the fresh gate. */
  clearAlwaysAllow(): void;
  /** Persist a config patch to the user-global config file. */
  persistConfig(patch: Record<string, unknown>): Promise<void>;
  /** Run a text prompt through the full turn pipeline. */
  handlePrompt(text: string, opts?: { handoff?: boolean }): Promise<void>;
  /** Reset ALL per-user-prompt budgets — auto-verify retries AND the green-gate /
   * diff-review fix-round counts — plus the diff-review baseline. A slash command
   * that expands into a prompt (custom command, /review, /<skill>) is a fresh
   * user-initiated turn, so it must start each budget clean, exactly like a typed
   * prompt (submit-prompt). Engine-internal fix turns never call this, so the
   * "bounded per user prompt" invariant holds. */
  resetTurnBudgets(): void;
  /** Run the verify command, emitting start/finish events. */
  runVerifyCommand(command: string): Promise<{ ok: boolean; output: string }>;
  /** Re-read project memory into the live session. */
  refreshProjectMemory(): Promise<void>;
  /** Scaffold a new named agent and reload the roster. */
  createAgent(name: string): Promise<void>;
  /** Start/stop a /loop — the loop lifecycle stays owned by the engine. */
  handleLoop(args: string): void;
  /** List models for configured providers, enriched with catalog metadata. */
  listModels(): Promise<ModelInfo[]>;
  /** Resolve a model's real context window (tokens). */
  resolveContextWindow(model: string): Promise<number | undefined>;
  /** Resolve a model's price (USD per 1M tokens). */
  resolvePricing(model: string): Promise<(ModelPrice & { estimated?: boolean }) | undefined>;
  /** Snapshot of connected/failed MCP servers. */
  mcpStatus(): McpServerStatus[];
  /** Per-language LSP server status (empty on the TS-only path). */
  lspStatus(): LspStatus[];
  /** Run a git command in the workspace. */
  git(args: string[]): Promise<GitRunResult>;
}

/** A trailing hint when a model's provider has no usable credentials yet. */
function providerKeyHint(h: EngineHandle, modelId: string): string {
  const provider = modelId.split("/")[0] ?? "";
  if (!provider || h.registry.isConfigured(provider, h.config)) return "";
  return ` — note: no API key for "${provider}" yet; add one with /model key ${provider} <key>`;
}

/** Switch the main model live on the session AND persist it (remembered). */
export async function setMainModel(h: EngineHandle, id: string): Promise<void> {
  h.session.setModel(id);
  h.config.model = id;
  await h.persistConfig({ model: id });
  h.notice(`Model → ${id}${providerKeyHint(h, id)}`);
}

/** Set (or, with a falsy id, clear → inherit main) the dedicated subagent model,
 * persisted. Shared by `/model sub …` and the `set-subagent-model` command. */
export async function setSubagentModel(h: EngineHandle, target: string | null): Promise<void> {
  const id = target?.trim();
  if (!id) {
    h.config.subagent.model = undefined;
    await h.persistConfig({ subagent: { model: null } });
    h.notice(`Subagent model cleared — subagents inherit the main model (${h.session.model}).`);
    return;
  }
  h.config.subagent.model = id;
  await h.persistConfig({ subagent: { model: id } });
  h.notice(`Subagent model → ${id}${providerKeyHint(h, id)}`);
}

/**
 * `/model` router — everything model/provider in one place, all persisted:
 *   /model                       → show main + subagent model and the cheatsheet
 *   /model <provider/id>         → switch the main model (cross-provider)
 *   /model sub <provider/id>     → set the subagent model (any provider)
 *   /model sub clear             → subagents inherit the main model again
 *   /model key <provider> <key>  → save/replace a provider API key
 */
export async function handleModelCommand(h: EngineHandle, args: string): Promise<void> {
  const raw = args.trim();
  if (!raw) {
    const sub = h.config.subagent.model;
    h.notice(
      `Main model:     ${h.session.model}\n` +
        `Subagent model: ${sub ?? `inherits main (${h.session.model})`}\n\n` +
        `Switch main:    /model <provider/id>\n` +
        `Subagent model: /model sub <provider/id>   ·   /model sub clear\n` +
        `Add a key:      /model key <provider> <api-key>\n` +
        `List models:    /models`,
    );
    return;
  }
  const parts = raw.split(/\s+/);
  const verb = (parts[0] ?? "").toLowerCase();

  if (verb === "sub" || verb === "subagent") {
    const target = parts.slice(1).join(" ").trim();
    const clear =
      !target || ["clear", "none", "inherit", "reset", "main"].includes(target.toLowerCase());
    await setSubagentModel(h, clear ? null : target);
    return;
  }

  if (verb === "key") {
    const provider = parts[1];
    const key = parts.slice(2).join(" ").trim();
    if (!provider || !key) {
      h.notice("Usage: /model key <provider> <api-key>", "warn");
      return;
    }
    if (!h.registry.list().some((d) => d.id === provider)) {
      h.notice(
        `Unknown provider "${provider}". Known providers: ${h.registry
          .list()
          .map((d) => d.id)
          .join(", ")}.`,
        "warn",
      );
      return;
    }
    h.config.providers[provider] = {
      ...(h.config.providers[provider] ?? {}),
      apiKey: key,
    };
    await h.persistConfig({ providers: { [provider]: { apiKey: key } } });
    h.notice(`Saved API key for ${provider} (…${key.slice(-4)}) — remembered across sessions.`);
    return;
  }

  // Anything else is a model id for the main model.
  await setMainModel(h, raw);
}

/** Handle a built-in or plugin/file slash command. */
export async function handleSlash(h: EngineHandle, name: string, args: string): Promise<void> {
  // Plugin/file commands take precedence over built-ins of the same name —
  // except a small set of safety-critical built-ins, which can't be shadowed
  // (a stray `.vibe/commands/undo.md` must not disable real `/undo`).
  if (RESERVED_SLASH.has(name) && h.commands.get(name)) {
    h.notice(`Ignoring custom /${name}: it shadows a protected built-in.`, "warn");
  }
  const custom = RESERVED_SLASH.has(name) ? undefined : h.commands.get(name);
  if (custom) {
    const result = custom.run(args);
    if (result.kind === "prompt") {
      // Treat an expanded command like a user prompt: checkpoint, hooks,
      // and auto-verify all apply, and it starts a fresh verify budget.
      h.resetTurnBudgets();
      await h.handlePrompt(result.text);
    } else if (result.kind === "command") h.send(result.command);
    else h.notice(result.message);
    return;
  }

  switch (name) {
    case "help":
      h.notice(helpText(h.commands.list()));
      break;
    case "model":
      await handleModelCommand(h, args);
      break;
    case "models": {
      // `/models refresh` force-pulls the models.dev catalog (bypassing the 24h
      // cache) so a just-released model's metadata shows up immediately.
      if (args.trim().toLowerCase() === "refresh") {
        h.notice("Refreshing model catalog…");
        const count = await h.catalog.refresh();
        h.notice(`Model catalog refreshed (${count} models known).`);
      }
      h.notice("Fetching models…");
      h.notice(formatModelList(await h.listModels()));
      break;
    }
    case "plan":
    case "execute":
      // Route through the engine's ONE canonical `set-mode` transition, which
      // owns the full invariant set: a real transition re-gates approvals to
      // `ask` (leaving plan can never inherit a lingering YOLO `auto`), leaving
      // plan right after a presented plan arms the execute handoff (so the
      // documented "/execute to proceed" flow actually proceeds), and returning
      // to plan disarms it. Duplicating half of that here is how the paths
      // drifted apart before.
      h.send({ type: "set-mode", mode: name });
      break;
    case "yolo":
      // Explicit, deliberate YOLO: gated-execute transition first (arming a
      // plan handoff if one was just presented), then approvals off. The warn
      // notice is the transcript-side record of entering the no-prompts state —
      // the red chip alone is easy to miss.
      h.send({ type: "set-mode", mode: "execute" });
      handleApprovals(h, "auto", true);
      h.notice("YOLO — approvals off; tools run without prompting. /execute re-gates.", "warn");
      break;
    case "goal":
      h.session.setGoal(args || null);
      h.notice(args ? `Goal set: ${args}` : "Goal cleared.");
      break;
    case "clear":
    case "new":
      // `session.clear()` already emits the "Conversation cleared." notice —
      // don't emit a second one here (that showed the message twice).
      h.session.clear();
      break;
    case "status":
      h.notice(await statusText(h));
      break;
    case "context": {
      const window = await h.resolveContextWindow(h.session.model);
      const used = h.session.contextTokens;
      const threshold = h.config.compaction.threshold;
      const lines = [
        `Context window for ${h.session.model}:`,
        `  ${formatContextUsage(used, window)}`,
        `  messages: ${h.session.messageCount}`,
        window
          ? `  auto-compaction triggers at ${Math.round(threshold * 100)}% (~${Math.round((threshold * window) / 1000)}k tokens). Run /compact to do it now.`
          : "  context window unknown for this model; using a 128k default for compaction.",
      ];
      h.notice(lines.join("\n"));
      break;
    }
    case "cost":
      h.notice(
        formatCost(
          h.session.snapshot().usage,
          h.session.model,
          await h.resolvePricing(h.session.model),
        ),
      );
      break;
    case "config":
      h.notice(formatConfig(h.config));
      break;
    case "tools":
      h.notice(formatTools(h.toolset.forMode(h.session.mode), h.session.mode));
      break;
    case "skills":
      h.notice(
        formatNamedList(
          "Skills (call /<name> or the model uses use_skill):",
          h.skills.list().map((s) => ({ name: s.name, description: s.description })),
          "No skills. Add .vibe/skills/<name>/SKILL.md to define one.",
        ),
      );
      break;
    case "commands":
      h.notice(
        formatNamedList(
          "Custom commands:",
          h.commands.list().map((c) => ({
            name: c.name,
            description: `${c.description} (${c.source})`,
          })),
          "No custom commands. Add .vibe/commands/<name>.md to define one.",
        ),
      );
      break;
    case "mcp":
      h.notice(formatMcp(h.mcpStatus(), Object.keys(h.config.mcp.servers)));
      break;
    case "permissions":
      h.notice(formatPermissions(h.config.permissions, h.config.approvalMode));
      break;
    case "approvals":
      handleApprovals(h, args);
      break;
    case "reasoning":
      handleReasoning(h, args);
      break;
    case "theme":
      handleTheme(h, args);
      break;
    case "accent":
      handleAccent(h, args);
      break;
    case "diff":
      await handleDiff(h);
      break;
    case "review":
      await handleReview(h);
      break;
    case "resume":
      await handleResume(h);
      break;
    case "export":
      await handleExport(h, args);
      break;
    case "doctor":
      await handleDoctor(h);
      break;
    case "exit":
    case "quit":
      h.notice("Press Ctrl-C (or Ctrl-D) to exit.");
      break;
    case "agents": {
      // `/agents new <name>` scaffolds a new named-agent file; bare `/agents`
      // lists the roster (the TUI opens an interactive menu instead).
      const m = /^\s*new\s+(.+)$/i.exec(args);
      if (m) {
        await h.createAgent(m[1]!);
      } else {
        h.notice(
          h.agents.size
            ? [...h.agents.values()]
                .map((a) => `  ${a.name} — ${a.description}${a.model ? `  (${a.model})` : ""}`)
                .join("\n")
            : "No named agents. Add .vibe/agents/<name>.md or run /agents new <name>.",
        );
      }
      break;
    }
    case "loop":
      h.handleLoop(args);
      break;
    case "undo":
      await handleUndo(h);
      break;
    case "checkpoints":
      await handleCheckpoints(h);
      break;
    case "verify":
      await handleVerify(h);
      break;
    case "compact":
      h.send({ type: "compact" });
      break;
    case "recall": {
      if (!args.trim()) {
        h.notice("Usage: /recall <text to find in saved memory + past sessions>", "warn");
        break;
      }
      if (h.memory) {
        const hits = await h.memory.search(args.trim());
        h.notice(formatMemoryHits(args.trim(), hits));
      } else {
        const hits = await searchSessions(h.cwd, args, { excludeId: h.session.id });
        h.notice(formatRecall(args.trim(), hits));
      }
      break;
    }
    case "memory":
      h.notice(formatMemory(await loadMemorySources(h.cwd)));
      break;
    case "sources": {
      // The web sources gathered this session (harvested from web_search /
      // webfetch / crawl_docs), with the stable [n] indices the model cites.
      const ledger = h.session.sources;
      h.notice(
        ledger.size
          ? `Web sources gathered this session (cite as [n]):\n${ledger.format(8_000)}`
          : "No web sources gathered yet this session. They're collected as the agent uses web_search, webfetch, and crawl_docs.",
      );
      break;
    }
    case "init": {
      const created = await initProject(h.cwd);
      h.notice(created.length ? `Created: ${created.join(", ")}` : "Project already initialized.");
      // Pick up the just-scaffolded VIBE.md immediately — the cached
      // #projectMemory was captured at startup and would otherwise ignore it
      // until restart.
      await h.refreshProjectMemory();
      break;
    }
    default: {
      // A skill can be invoked directly as `/skillname [task]`: load its full
      // body and run it like a prompt (the user-initiated analogue of the
      // model's `use_skill`). Built-ins and custom commands above take
      // precedence, so a skill can't shadow them.
      const skill = h.skills.get(name);
      if (skill) {
        const raw = await skill.load();
        // Cap the injected body (same discipline as the use_skill tool) so a huge
        // SKILL.md can't blow up the prompt; the model reads the file for the rest.
        const body =
          raw.length > MAX_SKILL_BODY
            ? `${raw.slice(0, MAX_SKILL_BODY)}\n\n…(skill body truncated at ${MAX_SKILL_BODY} chars — read ${skill.dir}/SKILL.md for the rest)`
            : raw;
        const task = args.trim() ? `\n\nTask: ${args.trim()}` : "";
        h.resetTurnBudgets();
        await h.handlePrompt(
          `Use the "${skill.name}" skill.${task}\n\n# Skill: ${skill.name}\n\n${body}`,
        );
        break;
      }
      h.notice(`Unknown command: /${name}`, "warn");
    }
  }
}

/** `/status` — render the live session overview. */
async function statusText(h: EngineHandle): Promise<string> {
  const tools = h.toolset.all();
  const contextWindow = await h.resolveContextWindow(h.session.model);
  return formatStatus({
    contextTokens: h.session.contextTokens,
    ...(contextWindow ? { contextWindow } : {}),
    sessionId: h.session.id,
    model: h.session.model,
    mode: h.session.mode,
    approvalMode: h.config.approvalMode,
    goal: h.session.goal,
    cwd: h.cwd,
    toolCount: tools.length,
    readOnlyCount: tools.filter((t) => t.readOnly).length,
    mcpServerCount: Object.keys(h.config.mcp.servers).length,
    skillCount: h.skills.list().length,
    commandCount: h.commands.list().length,
    agentCount: h.agents.size,
    usage: h.session.snapshot().usage,
  });
}

/** `/approvals [ask|auto]` — show or switch the default approval mode. */
export function handleApprovals(h: EngineHandle, args: string, quiet = false): void {
  const next = args.trim().toLowerCase();
  if (!next) {
    h.notice(`Approval mode: ${h.config.approvalMode}. Use /approvals <ask|auto>.`);
    return;
  }
  if (next !== "ask" && next !== "auto") {
    h.notice("Usage: /approvals <ask|auto>", "warn");
    return;
  }
  // Re-gating to `ask` forgets prior `always`-allow grants — BEFORE the no-op
  // early-return, so accepting a plan (or `/plan`/`/execute`) from a session
  // that's already in `ask` still clears grants that would otherwise bypass the
  // fresh gate ("nothing runs unprompted after re-gating"). Clearing when already
  // in `ask` is safe: it only means the next matching tool call prompts again.
  if (next === "ask") h.clearAlwaysAllow();
  // No-op if unchanged — avoids spamming the transcript when Shift+Tab cycles
  // through modes that resolve to the same approval setting.
  if (next === h.config.approvalMode) return;
  // Mutating the shared config object is picked up on the next turn, where the
  // PermissionChecker's default action is derived from approvalMode.
  h.config.approvalMode = next;
  h.emit({ type: "approvals-changed", mode: next });
  // `quiet` (the Shift+Tab mode toggle) relies on the header pill + input
  // border for feedback; an explicit `/approvals <v>` gets a one-line confirm.
  if (!quiet) h.notice(`Approvals: ${next}`);
}

/** `/reasoning [low|medium|high|off]` — show or set the reasoning effort. */
function handleReasoning(h: EngineHandle, args: string): void {
  const next = args.trim().toLowerCase();
  if (!next) {
    h.notice(
      `Reasoning effort: ${h.config.reasoning.effort ?? "default"}. Use /reasoning <low|medium|high|off>.`,
    );
    return;
  }
  if (next === "off" || next === "none") {
    delete h.config.reasoning.effort;
    void h.persistConfig({ reasoning: { effort: null } });
    h.notice("Reasoning effort cleared (provider default).");
    return;
  }
  if (next !== "low" && next !== "medium" && next !== "high") {
    h.notice("Usage: /reasoning <low|medium|high|off>", "warn");
    return;
  }
  h.config.reasoning.effort = next;
  void h.persistConfig({ reasoning: { effort: next } });
  // Tell the truth about whether the effort actually reaches the model: only
  // forwarded providers (anthropic, openai) send the hint. A natively-reasoning
  // model on an openai-compatible transport (xai, openrouter, codex, deepseek)
  // reasons regardless but never sees the hint, so an affirmative confirmation
  // there would be a fabricated success.
  switch (reasoningCategory(h.session.model)) {
    case "forwarded":
      h.notice(`Reasoning effort: ${next}.`);
      break;
    case "native":
      h.notice(
        `Reasoning effort: ${next}. Note: ${h.session.model} reasons natively — the effort hint is not forwarded on this transport.`,
      );
      break;
    default:
      h.notice(
        `Reasoning effort: ${next}. Note: ${h.session.model} likely ignores it (local/non-reasoning model).`,
        "warn",
      );
      break;
  }
}

/** The `/theme` help list, derived from the known set (never drifts from it). */
function themeList(): string {
  return [...KNOWN_THEMES].filter((n) => n !== "dark").join(", ");
}

/** `/theme [name]` — show or set the UI theme. */
function handleTheme(h: EngineHandle, args: string): void {
  const next = args.trim();
  if (!next) {
    h.notice(
      `Theme: ${h.config.theme}. Available: ${themeList()} (dark = default). Use /theme <name>.`,
    );
    return;
  }
  // Validate before confirming so we don't report success for a name that
  // silently falls back to the default palette. The known set IS the shared
  // `THEME_NAMES` (see KNOWN_THEMES) — the TUI renders the matching palette.
  if (!KNOWN_THEMES.has(next)) {
    h.notice(`Unknown theme "${next}". Available: ${themeList()}.`, "warn");
    return;
  }
  h.config.theme = next;
  void h.persistConfig({ theme: next });
  h.emit({ type: "theme-changed", theme: next });
  h.notice(`Theme set to "${next}".`);
}

/** `/accent [name|hex]` — show or set the UI accent color. Accepts a named
 * preset (`/accent orange`) or any 6-digit hex (`/accent #fab283`). */
function handleAccent(h: EngineHandle, args: string): void {
  const next = args.trim();
  const names = Object.keys(ACCENT_PRESETS).join(", ");
  if (!next) {
    const cur = h.config.accentColor || "theme default (Blue 300 #70cbf4)";
    h.notice(`Accent: ${cur}. Use /accent <name|hex> — ${names}, or e.g. /accent #fab283.`);
    return;
  }
  const preset = ACCENT_PRESETS[next.toLowerCase()];
  if (!preset && !/^#?[0-9a-fA-F]{6}$/.test(next)) {
    h.notice(`Unknown accent "${next}". Use one of ${names}, or a 6-digit hex like #fab283.`, "warn");
    return;
  }
  const hex = preset ?? (next.startsWith("#") ? next : `#${next}`);
  h.config.accentColor = hex;
  void h.persistConfig({ accentColor: hex });
  h.emit({ type: "accent-changed", accent: hex });
  h.notice(`Accent set to ${preset ? `${next.toLowerCase()} (${hex})` : hex}.`);
}

/** `/diff` — show the working-tree diff (git). */
async function handleDiff(h: EngineHandle): Promise<void> {
  if (!(await h.checkpoints.isGitRepo())) {
    h.notice("Not a git repository; nothing to diff.", "warn");
    return;
  }
  const out = await h.git(["--no-pager", "diff", "--stat", "HEAD"]);
  const full = await h.git(["--no-pager", "diff", "HEAD"]);
  const body = full.stdout.trim();
  if (!body) {
    h.notice("No changes in the working tree.");
    return;
  }
  const capped = body.length > 8000 ? `${body.slice(0, 8000)}\n…(diff truncated)` : body;
  h.notice(`${out.stdout.trim()}\n\n${capped}`);
}

/** `/review` — ask the model to review the current working-tree changes. */
async function handleReview(h: EngineHandle): Promise<void> {
  if (!(await h.checkpoints.isGitRepo())) {
    h.notice("Not a git repository; nothing to review.", "warn");
    return;
  }
  const raw = (await h.git(["--no-pager", "diff", "HEAD"])).stdout.trim();
  if (!raw) {
    h.notice("No changes in the working tree to review.");
    return;
  }
  // Cap the embedded diff so a large working tree can't blow up the prompt (and
  // token bill) — the model reviews the head of the diff and can read specific
  // files for the rest. Same bound the diff-review path uses.
  const diff =
    raw.length > REVIEW_DIFF_CAP
      ? `${raw.slice(0, REVIEW_DIFF_CAP)}\n…(diff truncated at ${REVIEW_DIFF_CAP} chars — read specific files for the rest)`
      : raw;
  h.resetTurnBudgets();
  await h.handlePrompt(
    "Review the current working-tree changes for correctness, bugs, missed edge " +
      "cases, and style consistency with the surrounding code. Be concrete and " +
      "cite file/line where possible. Here is the diff:\n\n```diff\n" +
      diff +
      "\n```",
  );
}

/** `/resume` — list saved sessions (resume one with `--resume <id>`). */
async function handleResume(h: EngineHandle): Promise<void> {
  const metas = await h.store.list();
  if (!metas.length) {
    h.notice("No saved sessions yet.");
    return;
  }
  const lines = metas.slice(0, 20).map((m) => {
    const when = new Date(m.updatedAt).toISOString().replace("T", " ").slice(0, 16);
    const goal = m.goal ? ` — ${m.goal.slice(0, 50)}` : "";
    return `  ${m.id}  ${when}  ${m.model}${goal}`;
  });
  h.notice(`Saved sessions (restart with \`vibecodr --resume <id>\`):\n${lines.join("\n")}`);
}

/** `/export [path]` — write the conversation as a Markdown transcript. */
async function handleExport(h: EngineHandle, args: string): Promise<void> {
  const snap = h.session.snapshot();
  if (!snap.history.length) {
    h.notice("Nothing to export yet — the conversation is empty.");
    return;
  }
  const md = formatTranscript(snap.history, {
    sessionId: snap.sessionId,
    model: snap.model,
    goal: snap.goal,
  });
  const path = args.trim()
    ? resolve(h.cwd, args.trim())
    : join(h.cwd, `vibe-export-${snap.sessionId}.md`);
  try {
    await Bun.write(path, md);
    h.notice(`Exported ${snap.history.length} message(s) to ${path}`);
  } catch (err) {
    h.notice(`Export failed: ${(err as Error).message}`, "error");
  }
}

/** `/doctor` — environment health check (keys, git, MCP, verify, search). */
async function handleDoctor(h: EngineHandle): Promise<void> {
  const checks: DoctorCheck[] = [];

  const providerId = h.session.model.split("/")[0] ?? "";
  const def = h.registry.get(providerId);
  const configured = h.registry.isConfigured(providerId, h.config);
  const envHint = def?.auth.env.length
    ? def.auth.env.join(" or ")
    : `${providerId.toUpperCase()}_API_KEY`;
  checks.push({
    label: "provider",
    ok: configured,
    detail: configured
      ? `${providerId}: credentials found`
      : `${providerId}: no API key (set ${envHint} or providers.${providerId}.apiKey)`,
  });

  // The provider SDKs are optional peer deps that only fail at first call.
  // Probe that the active provider's SDK actually resolves so /doctor doesn't
  // show all-green and then throw "install @ai-sdk/…" on the first turn.
  if (def) {
    let sdkOk = true;
    let sdkDetail = `${providerId} SDK loaded`;
    try {
      await def.create("__doctor_probe__", { apiKey: "probe" });
    } catch (err) {
      sdkOk = false;
      sdkDetail = (err as Error).message;
    }
    checks.push({ label: "provider sdk", ok: sdkOk, detail: sdkDetail });
  }

  const configuredProviders = h.registry
    .list()
    .filter((p) => h.registry.isConfigured(p.id, h.config))
    .map((p) => p.id);
  checks.push({
    label: "providers",
    ok: configuredProviders.length > 0,
    detail: configuredProviders.length
      ? `configured: ${configuredProviders.join(", ")}`
      : "no providers configured",
  });

  const isGit = await h.checkpoints.isGitRepo();
  checks.push({
    label: "git",
    ok: isGit,
    detail: isGit
      ? "repository detected (checkpoints/undo enabled)"
      : "not a git repo (no checkpoints)",
  });

  const mcpNames = Object.keys(h.config.mcp.servers);
  if (mcpNames.length) {
    const failed = h.mcpStatus().filter((s) => !s.connected);
    checks.push({
      label: "mcp",
      ok: failed.length === 0,
      detail: failed.length
        ? `${failed.length}/${mcpNames.length} server(s) failed`
        : `${mcpNames.length} server(s) connected`,
    });
  } else {
    checks.push({ label: "mcp", ok: null, detail: "no servers configured" });
  }

  checks.push({
    label: "verify",
    ok: h.config.verify.command ? true : null,
    detail: h.config.verify.command ?? "no verify command set",
  });

  checks.push(searchDoctorCheck(h.config.search.enabled, h.config.search.apiKey || process.env.TINYFISH_API_KEY));
  checks.push(lspDoctorCheck(h.config.lsp.enabled, h.lspStatus()));
  checks.push(sandboxDoctorCheck(h.sandbox));

  // Update status (read from the cached startup check — no network here) and
  // recent-crash visibility, so a silent crash or a stale build surfaces here.
  checks.push(updateDoctorCheck(await readUpdateCache()));
  checks.push(crashDoctorCheck(recentCrashes(7)));

  h.notice(formatDoctor(checks));
}

/**
 * The `/doctor` web-search health line. Search is KEYLESS by default (DuckDuckGo
 * et al.); a TinyFish key only prepends an extra engine — so "enabled" is healthy
 * WITHOUT a key. Reporting it broken (the old behavior) told users searches would
 * fail when they work fine. Pure + exported so the honesty invariant is tested.
 */
export function searchDoctorCheck(enabled: boolean, key: string | undefined): DoctorCheck {
  return {
    label: "web search",
    ok: enabled ? true : null,
    detail: !enabled
      ? "disabled"
      : key
        ? "enabled (keyless engines + TinyFish key)"
        : "enabled (keyless engines; set TINYFISH_API_KEY to add TinyFish)",
  };
}

/**
 * The `/doctor` multi-language LSP line. Honest by design (LSP is advisory,
 * never a gate): `ok:null` when off or when nothing is active yet (no non-TS file
 * has been diagnosed and nothing is configured-but-missing — a neutral `○`, not a
 * failure); `ok:false` only when a server crashed (restart gave up) or a
 * configured/edited language has no server binary; else `ok:true` with the running
 * servers. Pure over the status snapshot so the honesty invariant is tested.
 */
export function lspDoctorCheck(enabled: boolean, servers: LspStatus[]): DoctorCheck {
  if (!enabled) {
    return { label: "lsp", ok: null, detail: "off (set lsp.enabled to use multi-language diagnostics)" };
  }
  if (servers.length === 0) {
    return { label: "lsp", ok: null, detail: "no language servers active (no non-TS files diagnosed)" };
  }
  const crashed = servers.filter((s) => s.state === "crashed");
  const missing = servers.filter((s) => s.state === "missing");
  const live = servers.filter((s) => s.state === "running" || s.state === "starting" || s.state === "idle");
  const parts: string[] = [];
  if (live.length) {
    parts.push(live.map((s) => `${s.language}→${s.command ?? "?"}`).join(", "));
  }
  if (missing.length) parts.push(`no server for: ${missing.map((s) => s.language).join(", ")}`);
  if (crashed.length) parts.push(`crashed: ${crashed.map((s) => s.language).join(", ")}`);
  return {
    label: "lsp",
    // A missing server for a language actually edited/configured is a real gap
    // worth flagging (✗); a crash is a ✗. Otherwise the running set is ✓.
    ok: crashed.length === 0 && missing.length === 0,
    detail: parts.join(" · ") || "no language servers active",
  };
}

/**
 * The `/doctor` OS-sandbox line. `off` and `unavailable` are honestly `ok:null`
 * (a neutral `○`, not a failure — off is the shipped default and an unsupported
 * platform is expected); an active backstop is `ok:true`. Pure + exported so the
 * honesty invariant is tested.
 */
export function sandboxDoctorCheck(policy: SandboxPolicy): DoctorCheck {
  if (policy.mode === "off") {
    return {
      label: "sandbox",
      ok: null,
      detail: "off (opt-in — set sandbox.mode to workspace-write or read-only)",
    };
  }
  if (!policy.available) {
    return { label: "sandbox", ok: null, detail: policy.warning ?? "unavailable on this platform" };
  }
  return {
    label: "sandbox",
    ok: true,
    detail: `${policy.backend} · mode:${policy.mode} · network:${policy.network}`,
  };
}

/** `/verify` — run the verify command on demand. */
async function handleVerify(h: EngineHandle): Promise<void> {
  const command = h.config.verify.command;
  if (!command) {
    h.notice(
      'No verify command configured. Set `verify.command` (e.g. "bun run typecheck && bun test").',
      "warn",
    );
    return;
  }
  const result = await h.runVerifyCommand(command);
  h.notice(result.ok ? "Verification passed." : "Verification failed.");
}

/** `/undo` — restore the most recent checkpoint. */
async function handleUndo(h: EngineHandle): Promise<void> {
  if (!(await h.checkpoints.isGitRepo())) {
    h.notice("Checkpoints need a git repository; nothing to undo.", "warn");
    return;
  }
  const cp = await h.checkpoints.undo();
  if (!cp) {
    h.notice("No checkpoint to undo.");
    return;
  }
  // Roll the conversation back to match the restored files so the model no
  // longer believes the undone edits exist.
  if (cp.conversation) h.session.rewindConversation(cp.conversation);
  h.emit({ type: "checkpoint-restored", id: cp.id, label: cp.label });
  h.notice(`Reverted to checkpoint: ${cp.label}`);
}

/** `/checkpoints` — list saved checkpoints. */
async function handleCheckpoints(h: EngineHandle): Promise<void> {
  const list = await h.checkpoints.list();
  h.notice(
    list.length
      ? `Checkpoints (newest last):\n${list.map((c) => `  ${c.label}`).join("\n")}`
      : "No checkpoints yet. One is taken before each edit turn (git repos).",
  );
}

/** Selectable UI theme names — the single source of truth is `@vibe/shared`'s
 * `THEME_NAMES` (the TUI keeps the matching palettes; `ACCENT_PRESETS` is shared
 * likewise). Core validates `/theme` against this set so a name that would fall
 * back to the default palette is rejected instead of silently confirmed. */
const KNOWN_THEMES = new Set(THEME_NAMES);

/** Safety-critical built-in slash commands a custom command must not shadow.
 * Only names with a real built-in handler belong here — listing a phantom (there
 * is no `/redo`) would block a user's own `/redo` while offering no replacement. */
const RESERVED_SLASH = new Set(["undo", "clear", "new", "compact", "exit", "quit"]);
