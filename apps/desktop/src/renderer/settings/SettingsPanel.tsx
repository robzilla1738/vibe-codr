/**
 * Settings view — full-workspace config management for the vibe-codr engine.
 *
 * When active, this replaces the normal workspace layout:
 *   Left rail  → settings section navigation + scope toggle
 *   Center     → scrollable form area with the active section + sticky save bar
 *
 * Config is read/written via main-process IPC (config:read / config:write) to
 * the same JSONC files the engine loads on bootstrap:
 *   global  ~/.config/vibe-codr/config.json
 *   project <cwd>/.vibe/config.json
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildConfigPatch } from "../../shared/config-diff";
import { CONFIG_SECTIONS, type ConfigScope, type VibeConfig } from "../../shared/config-schema";
import { mayReloadSettingsContext } from "../../shared/settings-load-guard";
import { IconChevron, IconChevronLeft, IconClose, IconSearch, IconSidebar } from "../icons";
import { AdvancedSection } from "./sections/AdvancedSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { BehaviorSection } from "./sections/BehaviorSection";
import { BudgetSection } from "./sections/BudgetSection";
import { BuildSection } from "./sections/BuildSection";
import { CloudSection } from "./sections/CloudSection";
import { CompactionSection } from "./sections/CompactionSection";
import { HooksSection } from "./sections/HooksSection";
import { InstructionsSection } from "./sections/InstructionsSection";
import { McpSection } from "./sections/McpSection";
import { MemorySection } from "./sections/MemorySection";
import { ModelsSection } from "./sections/ModelsSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { SearchSection } from "./sections/SearchSection";
import { SubagentsSection } from "./sections/SubagentsSection";

export type SectionId = (typeof CONFIG_SECTIONS)[number]["id"];

const CLOUD_SECTION = { id: "cloud", label: "Cloud", description: "E2B, Vercel, credentials, lifecycle, transfer policy" } as const;
const SETTINGS_SECTIONS = [...CONFIG_SECTIONS, CLOUD_SECTION] as const;

const SETTINGS_GROUPS: ReadonlyArray<{ label: string; ids: readonly SectionId[]; advanced?: boolean }> = [
  { label: "Essentials", ids: ["providers", "models", "appearance", "behavior"] },
  { label: "Workspace", ids: ["permissions", "cloud", "instructions"] },
  {
    label: "Advanced settings",
    ids: ["mcp", "subagents", "build", "memory", "search", "compaction", "budget", "hooks", "advanced"],
    advanced: true,
  },
];

const ADVANCED_SECTION_IDS = new Set<SectionId>(
  SETTINGS_GROUPS.find((group) => group.advanced)?.ids ?? [],
);

interface SettingsState {
  config: VibeConfig;
  original: VibeConfig;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
}

const EMPTY_CONFIG: VibeConfig = {};

function configEqual(original: VibeConfig, current: VibeConfig): boolean {
  return Object.keys(
    buildConfigPatch(
      original as Record<string, unknown>,
      current as Record<string, unknown>,
    ),
  ).length === 0;
}

// ── Sidebar ──────────────────────────────────────────────────────────────

function SettingsSidebar({
  activeSection,
  onSelectSection,
  scope,
  onScopeChange,
  cwd,
  onClose,
}: {
  activeSection: SectionId;
  onSelectSection: (id: SectionId) => void;
  scope: ConfigScope;
  onScopeChange: (scope: ConfigScope) => void;
  cwd: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const advancedVisible = advancedOpen || ADVANCED_SECTION_IDS.has(activeSection) || Boolean(normalizedQuery);
  const sectionsById = useMemo(() => new Map(SETTINGS_SECTIONS.map((section) => [section.id, section])), []);
  const visibleGroups = useMemo(
    () => SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        sections: group.ids
          .map((id) => sectionsById.get(id))
          .filter((section): section is (typeof SETTINGS_SECTIONS)[number] => Boolean(section))
          .filter((section) => !normalizedQuery || `${section.label} ${section.description}`.toLowerCase().includes(normalizedQuery)),
      }))
      .filter((group) => group.sections.length > 0),
    [normalizedQuery, sectionsById],
  );

  return (
    <aside
      id="project-rail"
      className="project-rail is-open settings-rail"
      aria-label="Settings sections"
    >
      <div className="rail-chrome">
        <button type="button" className="icon-button rail-chrome-toggle no-drag" onClick={onClose} aria-label="Close settings">
          <IconSidebar size={15} />
        </button>
      </div>

      <div className="rail-title-row">
        <h1 className="rail-product-name">Settings</h1>
      </div>

      <button type="button" className="settings-back no-drag" onClick={onClose}>
        <IconChevronLeft size={14} />
        <span>Back to app</span>
      </button>

      <label className="settings-search no-drag">
        <IconSearch size={14} />
        <span className="sr-only">Search settings</span>
        <input
          type="search"
          value={query}
          placeholder="Search settings…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="rail-actions settings-scope-row">
        <div className="settings-scope-toggle settings-scope-toggle-full" role="tablist" aria-label="Config scope">
          <button type="button" role="tab" aria-selected={scope === "global"} className={`settings-scope-btn settings-scope-btn-grow${scope === "global" ? " active" : ""}`} onClick={() => onScopeChange("global")}>Global</button>
          <button type="button" role="tab" aria-selected={scope === "project"} className={`settings-scope-btn settings-scope-btn-grow${scope === "project" ? " active" : ""}`} onClick={() => onScopeChange("project")} disabled={!cwd}>Project</button>
        </div>
      </div>

      <div className="settings-nav-heading">
        <h2 className="rail-section-label">Sections</h2>
        <span className="settings-scope-hint">{scope === "global" ? "Every project" : cwd ? "This project" : "Project unavailable"}</span>
      </div>
      <nav className="settings-nav-list" aria-label="Settings sections">
        {visibleGroups.map((group) => (
          <div className="settings-nav-group" key={group.label}>
            {group.advanced ? (
              <button
                type="button"
                className="settings-advanced-toggle"
                aria-expanded={advancedVisible}
                onClick={() => {
                  if (advancedVisible && ADVANCED_SECTION_IDS.has(activeSection)) {
                    onSelectSection("models");
                  }
                  setAdvancedOpen(!advancedVisible);
                }}
              >
                <IconChevron size={13} open={advancedVisible} />
                <span>{group.label}</span>
              </button>
            ) : (
              <h3 className="settings-nav-group-label">{group.label}</h3>
            )}
            {(!group.advanced || advancedVisible) && group.sections.map((section) => (
              <button key={section.id} type="button" className={`settings-nav-item${activeSection === section.id ? " active" : ""}`} onClick={() => onSelectSection(section.id)}>
                <span className="settings-nav-label">{section.label}</span>
                <span className="settings-nav-desc">{section.description}</span>
              </button>
            ))}
          </div>
        ))}
        {visibleGroups.length === 0 && <p className="settings-nav-empty">No settings match “{query}”.</p>}
      </nav>
    </aside>
  );
}

// ── Form area ────────────────────────────────────────────────────────────

function SettingsFormArea({
  active,
  activeSection,
  scope,
  cwd,
  runtimeIdentity,
  onClose,
  showToast,
  onCloudSessionRecovered,
  onBindClose,
  onBindDirty,
}: {
  active: boolean;
  activeSection: SectionId;
  scope: ConfigScope;
  cwd: string | null;
  runtimeIdentity: string;
  onClose: () => void;
  showToast: (message: string, severity?: "info" | "warn" | "error") => void;
  onCloudSessionRecovered?: (sessionId: string, cwd: string) => void | Promise<void>;
  /** Lets the shell (sidebar / topbar) run the same dirty-aware close path. */
  onBindClose?: (requestClose: () => void) => void;
  /** Lets the shell guard Global↔Project scope switches while dirty. */
  onBindDirty?: (isDirty: () => boolean) => void;
}) {
  const [state, setState] = useState<SettingsState>({
    config: EMPTY_CONFIG, original: EMPTY_CONFIG, dirty: false, loading: true, error: null, saving: false, saveError: null,
  });
  const loadSeq = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = state.dirty;
  /** Context that produced the in-memory config. Never save it to a newer cwd. */
  const loadedContextRef = useRef<{ scope: ConfigScope; cwd?: string } | null>(null);
  /** Instructions section dirty (kept mounted while settings is open). */
  const instructionsDirtyRef = useRef<() => boolean>(() => false);
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const cloudDirtyRef = useRef(false);
  const [cloudDirty, setCloudDirty] = useState(false);
  cloudDirtyRef.current = cloudDirty;
  const invalidDraftsRef = useRef<Set<string>>(new Set());
  const [invalidDrafts, setInvalidDrafts] = useState<Set<string>>(() => new Set());
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const prevCwdRef = useRef(cwd);
  /** After an explicit discard confirm, the next load may proceed without re-prompting. */
  const discardAcceptedRef = useRef(false);

  const shellIsDirty = useCallback(
    () => dirtyRef.current || instructionsDirtyRef.current() || cloudDirtyRef.current || invalidDraftsRef.current.size > 0,
    [],
  );
  const combinedDirty = state.dirty || instructionsDirty || cloudDirty || invalidDrafts.size > 0;

  useEffect(() => {
    window.vibe.setSettingsDirty(combinedDirty);
  }, [combinedDirty]);

  useEffect(() => () => {
    window.vibe.setSettingsDirty(false);
  }, []);

  const loadConfig = useCallback(async (selectedScope: ConfigScope) => {
    const seq = ++loadSeq.current;
    setState((prev) => ({ ...prev, loading: true, error: null, saving: false, saveError: null }));
    try {
      const targetCwd = selectedScope === "project" ? cwd ?? undefined : undefined;
      const res = await window.vibe.readConfig({ scope: selectedScope, cwd: targetCwd });
      if (seq !== loadSeq.current) return;
      if (!res.ok) { setState((prev) => ({ ...prev, loading: false, error: res.error })); return; }
      const cfg = res.config ?? {};
      loadedContextRef.current = { scope: selectedScope, cwd: targetCwd };
      setState({ config: cfg, original: cfg, dirty: false, loading: false, error: null, saving: false, saveError: null });
      discardAcceptedRef.current = false;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setState((prev) => ({ ...prev, loading: false, saving: false, saveError: null, error: err instanceof Error ? err.message : "Failed to load config" }));
    }
  }, [cwd]);

  useEffect(() => () => {
    // Invalidate in-flight reads/writes before this settings surface disappears.
    loadSeq.current += 1;
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    // Scope flips are confirmed in SettingsView.trySetScope before `scope` updates.
    // cwd flips (project switch) must not wipe dirty config — including global —
    // without a discard. App also gates open/resume when shellIsDirty().
    if (cwdChanged && dirtyRef.current && !discardAcceptedRef.current) {
      const ok = mayReloadSettingsContext({
        dirty: true,
        confirmDiscard: () => window.confirm("Discard unsaved settings changes?"),
      });
      if (!ok) {
        // Keep in-memory dirty edits; do not replace them with a fresh read.
        return;
      }
    }
    void loadConfig(scope);
  }, [scope, loadConfig, cwd]);

  const requestClose = useCallback(() => {
    if (shellIsDirty()) {
      const ok = window.confirm("Discard unsaved settings changes?");
      if (!ok) return;
      discardAcceptedRef.current = true;
    }
    onClose();
  }, [onClose, shellIsDirty]);

  useEffect(() => {
    onBindClose?.(requestClose);
  }, [onBindClose, requestClose]);

  useEffect(() => {
    onBindDirty?.(shellIsDirty);
  }, [onBindDirty, shellIsDirty]);

  const bindInstructionsDirty = useCallback((isDirty: () => boolean) => {
    instructionsDirtyRef.current = isDirty;
  }, []);

  const reportInvalidDraft = useCallback((key: string, invalid: boolean) => {
    setInvalidDrafts((current) => {
      const next = new Set(current);
      if (invalid) next.add(key);
      else next.delete(key);
      invalidDraftsRef.current = next;
      return next;
    });
  }, []);

  const updateConfig = useCallback((patch: Partial<VibeConfig>) => {
    setState((prev) => {
      const next = { ...prev.config, ...patch };
      return { ...prev, config: next, dirty: !configEqual(prev.original, next) };
    });
  }, []);

  const updateNested = useCallback(<K extends keyof VibeConfig>(key: K, patch: Partial<VibeConfig[K]>) => {
    setState((prev) => {
      const current = (prev.config[key] ?? {}) as Record<string, unknown>;
      // Deep-merge plain objects so one-field nested patches (e.g. gate.enabled)
      // do not wipe sibling keys (maxRounds, checks, recon, …) before save.
      const deepMerge = (
        base: Record<string, unknown>,
        delta: Record<string, unknown>,
      ): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...base };
        for (const [k, v] of Object.entries(delta)) {
          if (
            v !== null &&
            typeof v === "object" &&
            !Array.isArray(v) &&
            out[k] !== null &&
            typeof out[k] === "object" &&
            !Array.isArray(out[k])
          ) {
            out[k] = deepMerge(
              out[k] as Record<string, unknown>,
              v as Record<string, unknown>,
            );
          } else {
            out[k] = v;
          }
        }
        return out;
      };
      const merged = deepMerge(current, patch as Record<string, unknown>);
      const next = { ...prev.config, [key]: merged };
      return { ...prev, config: next, dirty: !configEqual(prev.original, next) };
    });
  }, []);

  const saveConfig = useCallback(async () => {
    const seq = loadSeq.current;
    const savedConfig = state.config;
    const savedOriginal = state.original;
    setState((prev) => ({ ...prev, saving: true, saveError: null }));
    try {
      const patch = buildConfigPatch(
        savedOriginal as Record<string, unknown>,
        savedConfig as Record<string, unknown>,
      );
      const target = loadedContextRef.current ?? {
        scope,
        cwd: scope === "project" ? cwd ?? undefined : undefined,
      };
      const res = await window.vibe.writeConfig({ scope: target.scope, cwd: target.cwd, patch });
      if (seq !== loadSeq.current) return;
      if (!res.ok) { setState((prev) => ({ ...prev, saving: false, saveError: res.error })); return; }
      setState((prev) => ({
        ...prev,
        original: savedConfig,
        dirty: !configEqual(savedConfig, prev.config),
        saving: false,
        saveError: null,
      }));
      showToast("Settings saved — new sessions will use these values", "info");
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setState((prev) => ({ ...prev, saving: false, saveError: err instanceof Error ? err.message : "Failed to save" }));
    }
  }, [scope, cwd, state.config, state.original, showToast]);

  const resetConfig = useCallback(() => {
    setState((prev) => ({ ...prev, config: prev.original, dirty: false, saveError: null }));
    setDraftResetVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
    };
    // Bubble so section-owned controls can consume Escape first (cancel an Add
    // row, close a draft) instead of the Settings layer pre-empting them in the
    // capture phase and prompting to discard the entire form.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, requestClose]);

  const sectionProps = useMemo(() => ({
    config: state.config,
    scope,
    updateConfig,
    updateNested,
    cwd,
    onInvalidDraftChange: reportInvalidDraft,
    draftResetVersion,
    showToast,
  }), [state.config, scope, updateConfig, updateNested, cwd, reportInvalidDraft, draftResetVersion, showToast]);

  // Keep every section mounted while Settings is open. Besides VIBE.md, MCP
  // env/header editors and add-new rows carry legitimate local draft state that
  // must survive a quick section switch.
  const renderConfigSection = (id: SectionId) => {
    switch (id) {
      case "models": return <ModelsSection {...sectionProps} />;
      case "providers": return <ProvidersSection {...sectionProps} />;
      case "mcp": return <McpSection {...sectionProps} />;
      case "permissions": return <PermissionsSection {...sectionProps} />;
      case "appearance": return <AppearanceSection {...sectionProps} />;
      case "behavior": return <BehaviorSection {...sectionProps} />;
      case "subagents": return <SubagentsSection {...sectionProps} />;
      case "build": return <BuildSection {...sectionProps} />;
      case "memory": return <MemorySection {...sectionProps} />;
      case "search": return <SearchSection {...sectionProps} />;
      case "compaction": return <CompactionSection {...sectionProps} />;
      case "budget": return <BudgetSection {...sectionProps} />;
      case "hooks": return <HooksSection {...sectionProps} />;
      case "advanced": return (
        <AdvancedSection
          {...sectionProps}
          active={active && activeSection === "advanced"}
          runtimeIdentity={runtimeIdentity}
        />
      );
      case "instructions": return null;
      case "cloud": return <CloudSection showToast={showToast} onSessionRecovered={onCloudSessionRecovered} onDirtyChange={setCloudDirty} />;
      default: return null;
    }
  };

  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === activeSection);

  return (
    <div className="main-column settings-main" id="main-content">
      <div className="settings-form-header">
        <div className="settings-form-header-copy">
          <h2 className="settings-form-title">{activeMeta?.label}</h2>
          <p className="settings-form-sub">{activeMeta?.description}</p>
        </div>
      </div>

      <div className="settings-form-scroll">
        {state.loading ? (
          <div className="settings-loading"><span className="spinner" aria-hidden /> Loading config…</div>
        ) : state.error ? (
          <div className="settings-error" role="alert">
            <p>Couldn't load config: {state.error}</p>
            <button type="button" className="button" onClick={() => void loadConfig(scope)}>Retry</button>
          </div>
        ) : (
          <>
            {scope === "project" && (
              <p className="setting-empty" role="note">
                Safety note: until trusted from Global settings, project providers, hooks/plugins/MCP, LSP or verify commands, sandbox/SSRF relaxations, auto approvals, and broad allow rules are ignored. Exact “always for this project” grants and deny/ask rules still apply.
              </p>
            )}
            {/* Keep instructions mounted (hidden) so VIBE.md drafts + dirty bind survive section switches. */}
            <div
              hidden={activeSection !== "instructions"}
              aria-hidden={activeSection !== "instructions"}
            >
              <InstructionsSection
                {...sectionProps}
                onBindDirty={bindInstructionsDirty}
                onDirtyChange={setInstructionsDirty}
              />
            </div>
            {SETTINGS_SECTIONS.filter(({ id }) => id !== "instructions").map(({ id }) => (
              <div key={id} hidden={activeSection !== id} aria-hidden={activeSection !== id}>
                {renderConfigSection(id)}
              </div>
            ))}
            {state.saveError && <div className="settings-save-error" role="alert">Save failed: {state.saveError}</div>}
          </>
        )}
      </div>

      {!state.loading && !state.error && activeSection !== "instructions" && activeSection !== "cloud" && (
        <div className="settings-save-bar">
          <div className="settings-save-status">
            {invalidDrafts.size > 0
              ? <span className="settings-dirty-indicator">Finish or clear draft fields before saving</span>
              : state.dirty
              ? <span className="settings-dirty-indicator">Unsaved changes</span>
              : <span className="settings-clean-indicator">All changes saved</span>}
          </div>
          <div className="settings-save-actions">
            <button type="button" className="button" onClick={resetConfig} disabled={(!state.dirty && invalidDrafts.size === 0) || state.saving}>Reset</button>
            <button type="button" className="button primary" onClick={() => void saveConfig()} disabled={!state.dirty || state.saving || invalidDrafts.size > 0}>
              {state.saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Combined view (used by App.tsx) ──────────────────────────────────────

export function SettingsView({
  active,
  cwd,
  runtimeIdentity,
  onClose,
  showToast,
  onCloudSessionRecovered,
  onBindDirty,
}: {
  active: boolean;
  cwd: string | null;
  runtimeIdentity: string;
  onClose: () => void;
  showToast: (message: string, severity?: "info" | "warn" | "error") => void;
  onCloudSessionRecovered?: (sessionId: string, cwd: string) => void | Promise<void>;
  /** Lets the shell confirm before unmounting settings (⌘,, git, inspector, slash). */
  onBindDirty?: (isDirty: () => boolean) => void;
}) {
  const [activeSection, setActiveSection] = useState<SectionId>("providers");
  const [scope, setScope] = useState<ConfigScope>("global");
  const requestCloseRef = useRef(onClose);
  const isDirtyRef = useRef<() => boolean>(() => false);

  const bindClose = useCallback((fn: () => void) => {
    requestCloseRef.current = fn;
  }, []);
  const bindDirty = useCallback((fn: () => boolean) => {
    isDirtyRef.current = fn;
    onBindDirty?.(fn);
  }, [onBindDirty]);

  useEffect(() => {
    return () => {
      // Clear shell guard so a closed panel never looks dirty after unmount.
      onBindDirty?.(() => false);
    };
  }, [onBindDirty]);

  const tryClose = useCallback(() => {
    requestCloseRef.current();
  }, []);

  const trySetScope = useCallback((next: ConfigScope) => {
    if (activeSection === "cloud") return;
    if (next === scope) return;
    if (isDirtyRef.current()) {
      const ok = window.confirm("Discard unsaved settings changes?");
      if (!ok) return;
    }
    setScope(next);
  }, [activeSection, scope]);

  // Note: project/cwd switches are gated in App via onBindDirty so resume/open
  // never unmounts dirty settings silently.

  return (
    <>
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        scope={scope}
        onScopeChange={trySetScope}
        cwd={cwd}
        onClose={tryClose}
      />
      <div className="content-inset">
        <header className="topbar">
          <div className="topbar-leading">
            <h1 className="topbar-title">
              <span className="topbar-project">Settings</span>
              <span className="topbar-separator" aria-hidden>/</span>
              <span className="topbar-session">{activeSection === "cloud" ? "This Mac" : scope === "global" ? "Global" : "Project"}</span>
            </h1>
          </div>
          <div className="topbar-actions no-drag">
            <button type="button" className="icon-button" onClick={tryClose} aria-label="Close settings" title="Close settings (Esc)">
              <IconClose size={16} />
            </button>
          </div>
        </header>
        <SettingsFormArea
          active={active}
          activeSection={activeSection}
          scope={scope}
          cwd={cwd}
          runtimeIdentity={runtimeIdentity}
          onClose={onClose}
          showToast={showToast}
          onCloudSessionRecovered={onCloudSessionRecovered}
          onBindClose={bindClose}
          onBindDirty={bindDirty}
        />
      </div>
    </>
  );
}
