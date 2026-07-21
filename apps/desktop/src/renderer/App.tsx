import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { belowBreakpoint } from "../shared/breakpoints";
import { CatalogCache, type CatalogCacheKey } from "../shared/catalog-cache";
import {
  agentsPickerQuery,
  currentModelForTarget,
  type ModelPickerTarget,
  mcpPickerQuery,
  modelPicker,
  normalizeMcpServer,
  providersPickerQuery,
  skillsPickerFilter,
} from "../shared/catalog-draft";
import { sortChangedFilesForDisplay } from "../shared/changed-files";
import { type CloudProviderId, type CloudSessionCatalogEntry, type CloudStatusEvent, isCloudSessionRemoteOwned, latestRemoteOwnedCloudSession, type PendingCapabilityRequest } from "../shared/cloud";
import { cloudStatusBelongsToSession } from "../shared/cloud-progress";
import { commandsExpectBusy } from "../shared/command-busy";
import { encodedEngineCommandBytes, HOST_INBOUND_SAFE_BYTES } from "../shared/command-wire";
import { applyConfigPatch, buildConfigPatch } from "../shared/config-diff";
import { contextUsagePercent } from "../shared/context-usage";
import { densityLabel, nextDensity } from "../shared/density";
import { parseHandoffCommand, resolveHandoffCommandAction } from "../shared/handoff-command";
import type {
  LocalRuntimeLaunchQueueSnapshot,
  LocalRuntimeStatus,
} from "../shared/local-runtime";
import { planResolutionBlockedReason } from "../shared/plan-resolution";
import { commandsForPlanExitWithoutRunning, engineStateForUiMode } from "../shared/modes";
import {
  isChatsCwd,
  normalizeCwd,
  projectLabel,
  startupProjectCandidates,
  terminalCwdForWorkspace,
} from "../shared/project-index";
import type { EngineCommand, ProjectSummary } from "../shared/protocol";
import { isUIEvent } from "@vibe/protocol/client-runtime";
import { hasUsableOnboardingProvider } from "../shared/provider-readiness";
import { isProjectSummaryArray } from "../shared/runtime-guards";
import {
  readSessionBoardPreferences,
  sessionBoardKey,
  type SessionBoardStatus,
  writeSessionBoardPreferences,
} from "../shared/session-board";
import { lineToCommands, routePendingPermLine } from "../shared/slash";
import { classifySubmitLine } from "../shared/submit-routing";
import type {
  AgentInfo,
  McpServerInfo,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
} from "../shared/types";
import { BrandWordmark } from "./branding/BrandWordmark";
import { Composer, type ComposerMetric } from "./composer/Composer";
import { RequestGate } from "./hooks/request-gate";
import { usePresence, useRetainedValue } from "./hooks/usePresence";
import { useSession } from "./hooks/useSession";
import { IconSidebar } from "./icons";
import {
  ActivitySidebar,
  type ActivitySidebarTarget,
} from "./layout/ActivitySidebar";
import { ProjectRail } from "./layout/ProjectRail";
import { SidebarResizeHandle } from "./layout/SidebarResizeHandle";
import { Splash } from "./layout/Splash";
import { SessionBoot, SessionBootError, WelcomeGate } from "./layout/WelcomeGate";
import { WorkspaceDock, type WorkspaceDockTarget } from "./layout/WorkspaceDock";
import { Inspector } from "./panels/Inspector";
import { JobsView } from "./panels/JobsView";
import { KeysOverlay } from "./panels/KeysOverlay";
import { PermissionCard, PlanCard, QuestionCard, QueuePanel } from "./panels/LivePanels";
import type { ProviderStatus } from "./panels/OnboardingModal";
import { ChangedFilesPill } from "./panels/TurnChangesCard";
import { type CatalogChoice, CatalogModal, type CatalogPickerState } from "./pickers/CatalogModal";
import {
  formatChromeSummary,
  formatGitLine,
  formatGoalLine,
  projectName,
  StatusDot,
} from "./primitives";
import { TranscriptView } from "./transcript/TranscriptView";
import { deleteTranscriptCache, deleteTranscriptCachesForCwd } from "./transcript-cache";
import { buildLiveSessionInsight } from "./sessions/session-live-insight";

type Picker = CatalogPickerState | null;

const TerminalPanel = lazy(() =>
  import("./panels/TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
const GitView = lazy(() =>
  import("./git/GitPanel").then((module) => ({ default: module.GitView })),
);
const ChangesView = lazy(() =>
  import("./panels/ChangesView").then((module) => ({ default: module.ChangesView })),
);
const SettingsView = lazy(() =>
  import("./settings/SettingsPanel").then((module) => ({ default: module.SettingsView })),
);
const SessionsWorkspace = lazy(() =>
  import("./sessions/SessionsWorkspace").then((module) => ({ default: module.SessionsWorkspace })),
);
const OnboardingModal = lazy(() =>
  import("./panels/OnboardingModal").then((module) => ({ default: module.OnboardingModal })),
);
const CloudHandoffSheet = lazy(() =>
  import("./panels/CloudHandoffSheet").then((module) => ({ default: module.CloudHandoffSheet })),
);
const CLOUD_FILE_REVEAL_NOTICE = "This file is in Cloud. Preview it here or return Local before revealing it in Finder.";

function pickerMatchesDraft(picker: Picker, draft: string, modelTarget: "main" | "sub"): boolean {
  if (!picker) return false;
  if (picker.kind === "models") return modelPicker(draft, modelTarget) !== null;
  if (picker.kind === "providers") return providersPickerQuery(draft) !== null;
  if (picker.kind === "agents") return agentsPickerQuery(draft) !== null;
  if (picker.kind === "skills") return skillsPickerFilter(draft) !== null;
  return mcpPickerQuery(draft) !== null;
}

function asMcpList(value: unknown): McpServerInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => normalizeMcpServer((row ?? {}) as Record<string, unknown>));
}

/** Compact token count: `1.5k` at ≥1000, the raw number below (TUI parity: fmtCount). */
function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Full usage label: `12.3k tok · $0.0421 · 1.1k cached` (TUI parity: headless formatUsage). */
function formatUsage(u: { totalTokens: number; costUSD: number; costEstimated?: boolean; cachedInputTokens?: number }): string | null {
  if (!u.totalTokens) return null;
  const tok = fmtCount(u.totalTokens);
  const prefix = u.costEstimated ? "~$" : "$";
  const digits = u.costUSD === 0 ? 2 : u.costUSD < 1 ? 4 : 2;
  const cost = ` · ${prefix}${u.costUSD.toFixed(digits)}`;
  const cached =
    u.cachedInputTokens && u.cachedInputTokens > 0
      ? ` · ${fmtCount(u.cachedInputTokens)} cached`
      : "";
  return `${tok} tok${cost}${cached}`;
}

export function App() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<Picker>(null);
  const pickerPresence = usePresence(Boolean(picker));
  const renderedPicker = useRetainedValue(picker);
  const [modelTarget, setModelTarget] = useState<"main" | "sub">("main");
  const catalogCache = useRef(new CatalogCache());
  const catalogGeneration = useRef(0);
  const catalogPresentationGate = useRef(new RequestGate());
  const pickerRetryRef = useRef<(() => void) | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [chatsCwd, setChatsCwd] = useState<string | null>(null);
  const [homeCwd, setHomeCwd] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [initialProjectRestoreSettled, setInitialProjectRestoreSettled] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectOpenError, setProjectOpenError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [providerSetupRequest, setProviderSetupRequest] = useState<{ providerId?: string } | null>(null);
  /** "Skip for now" lasts only for this renderer session, not forever. */
  const onboardingDismissed = useRef(false);
  const [onboardingProviders, setOnboardingProviders] = useState<ProviderStatus[]>([]);
  const [onboardingSaving, setOnboardingSaving] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const onboardingProbeGate = useRef(new RequestGate());
  const [keysOpen, setKeysOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionStatusRevision, setSessionStatusRevision] = useState(0);
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<Map<string, LocalRuntimeStatus>>(
    () => new Map(),
  );
  const [localRuntimeQueue, setLocalRuntimeQueue] = useState<LocalRuntimeLaunchQueueSnapshot>({
    capacity: 3,
    items: [],
  });
  const localRuntimeStateRef = useRef(new Map<string, LocalRuntimeStatus["state"]>());
  const busySessionRef = useRef<string | null>(null);
  const projectRefreshBusyRef = useRef(false);
  const [cloudSheetOpen, setCloudSheetOpen] = useState(false);
  const [cloudTransitioning, setCloudTransitioning] = useState(false);
  const [cloudRequest, setCloudRequest] = useState<{ target?: "cloud" | "local"; provider?: CloudProviderId; instruction?: string } | null>(null);
  const [cloudSessions, setCloudSessions] = useState<CloudSessionCatalogEntry[]>([]);
  const [cloudProgress, setCloudProgress] = useState<CloudStatusEvent | null>(null);
  const [pendingLocalCapability, setPendingLocalCapability] = useState<PendingCapabilityRequest | null>(null);
  const [pendingLocalCapabilitySessionId, setPendingLocalCapabilitySessionId] = useState<string | null>(null);
  const pendingLocalCapabilityRef = useRef<PendingCapabilityRequest | null>(null);
  pendingLocalCapabilityRef.current = pendingLocalCapability;
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null);
  /** Bumped on N so PermissionCard can open deny-reason then confirm (card parity). */
  const [permDenyKick, setPermDenyKick] = useState(0);
  const [gitOpen, setGitOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [projectRailOpen, setProjectRailOpen] = useState(true);
  const [followSignal, setFollowSignal] = useState(0);
  /** When opening the Session panel from the turn card / dock, focus this path. */
  const [inspectorFocusPath, setInspectorFocusPath] = useState<string | null>(null);
  const [inspectorFocusSection, setInspectorFocusSection] = useState<"subagents" | null>(null);
  const [inspectorTool, setInspectorTool] = useState<"session" | "changes">("session");
  const didRestoreProject = useRef(false);
  /** Bound by SettingsView while mounted — true when config form has unsaved edits. */
  const settingsDirtyRef = useRef<() => boolean>(() => false);
  const projectRefreshGate = useRef(new RequestGate());
  const composerStackRef = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  const session = useSession(cwd);
  const activeEndPanel: ActivitySidebarTarget | null = session.inspectorOpen
    ? inspectorTool
    : session.jobsView
      ? "jobs"
      : gitOpen
        ? "git"
        : terminalOpen
          ? "terminal"
          : null;
  const projectRailPresence = usePresence(projectRailOpen);
  const endPanelPresence = usePresence(activeEndPanel !== null);
  const renderedEndPanel = useRetainedValue(activeEndPanel);
  const endPanelOpen = endPanelPresence.mounted;
  const terminalCwd = cwd ? terminalCwdForWorkspace(cwd, chatsCwd, homeCwd) : null;
  const terminalScope = cwd && chatsCwd && isChatsCwd(cwd, chatsCwd) ? "chat" : "project";
  const showToastRef = useRef(session.showToast);
  showToastRef.current = session.showToast;
  const activeSessionIdRef = useRef(session.chrome.sessionId);
  activeSessionIdRef.current = session.chrome.sessionId;
  const cloudSessionsRef = useRef(cloudSessions);
  cloudSessionsRef.current = cloudSessions;
  const cloudStatusRefreshRef = useRef(new Map<string, string>());

  useEffect(() => {
    const request = session.pendingCapabilities.find((candidate) => candidate.status === "pending") ?? null;
    setPendingLocalCapability(request);
    setPendingLocalCapabilitySessionId(request ? activeSessionIdRef.current : null);
  }, [session.pendingCapabilities]);

  const refreshCloudSessions = useCallback(async () => {
    const result = await window.vibe.listCloudSessions();
    if (result.ok) setCloudSessions(result.value);
  }, []);

  useEffect(() => {
    void refreshCloudSessions();
    return window.vibe.onCloudStatus((event) => {
      if (cloudStatusBelongsToSession(event, activeSessionIdRef.current)) setCloudProgress(event);
      const statusKey = event.sessionId ?? "active";
      if (cloudStatusRefreshRef.current.get(statusKey) !== event.status) {
        cloudStatusRefreshRef.current.set(statusKey, event.status);
        void refreshCloudSessions();
      }
    });
  }, [refreshCloudSessions]);

  useEffect(() => window.vibe.onEvent((event) => {
    if (!isUIEvent(event)) return;
    if (event.type === "engine-error") {
      const failedId = event.sessionId ?? activeSessionIdRef.current;
      if (failedId) setFailedSessionId(failedId);
      return;
    }
    if (event.type === "session-start") {
      setFailedSessionId((current) => current === event.sessionId ? null : current);
    }
    if (event.type === "user-message") {
      setFailedSessionId((current) => current === event.sessionId ? null : current);
    }
    if (event.type === "external-capability-pending") {
      setPendingLocalCapability(event.request);
      setPendingLocalCapabilitySessionId(event.sessionId ?? activeSessionIdRef.current);
      setCloudProgress({ status: "needs-local", message: `Needs your Mac for ${event.request.integration}` });
      return;
    }
    if (event.type === "external-capability-resolved") {
      if (pendingLocalCapabilityRef.current?.id === event.id) {
        setPendingLocalCapabilitySessionId(null);
        setPendingLocalCapability(null);
      }
      return;
    }
    if (event.type !== "runtime-handoff-requested") return;
    const target = event.target.kind;
    const cloudOwned = cloudSessionsRef.current.some((item) =>
      item.sessionId === activeSessionIdRef.current && isCloudSessionRemoteOwned(item.status));
    const action = resolveHandoffCommandAction({ target }, cloudOwned);
    if (action === "already-local" || action === "already-cloud") {
      showToastRef.current(action === "already-local" ? "Session is already running locally" : "Session is already running in Cloud", "info");
      return;
    }
    setCloudRequest({
      target: action,
      ...(event.target.kind === "cloud" ? { provider: event.target.provider } : {}),
      ...(event.instruction ? { instruction: event.instruction } : {}),
    });
    setCloudProgress(null);
    setCloudSheetOpen(true);
  }), []);

  const revealPath = useCallback((path: string) => {
    void window.vibe.showItem(path).catch((error: unknown) => {
      session.showToast(
        error instanceof Error ? error.message : "Couldn’t reveal that item",
        "error",
      );
    });
  }, [session]);

  // The composer and live panels overlay the transcript so output can continue
  // to scroll underneath them. Track both heights: transcript padding follows
  // the composer, while Jump to latest must sit above permission/plan/activity
  // panels instead of covering them.
  useEffect(() => {
    const stack = composerStackRef.current;
    const panels = panelsRef.current;
    const column = stack?.closest<HTMLElement>(".chat-column");
    if (!stack || !column || typeof ResizeObserver === "undefined") return;

    const syncClearances = () => {
      const composerHeight = Math.ceil(stack.getBoundingClientRect().height);
      const panelsHeight = panels
        ? Math.ceil(panels.getBoundingClientRect().height)
        : 0;
      column.style.setProperty("--composer-clearance", `${composerHeight + 24}px`);
      column.style.setProperty("--panels-clearance", `${panelsHeight}px`);
    };

    syncClearances();
    const observer = new ResizeObserver(syncClearances);
    observer.observe(stack);
    if (panels) observer.observe(panels);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--composer-clearance");
      column.style.removeProperty("--panels-clearance");
    };
  }, [session.booting, session.chrome.queuePending.length, session.transcript.blocks.length, picker]);

  useEffect(() => {
    const onPreviewToast = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) showToastRef.current(detail);
    };
    window.addEventListener("vibe-preview-toast", onPreviewToast);
    return () => window.removeEventListener("vibe-preview-toast", onPreviewToast);
  }, []);

  const bindSettingsDirty = useCallback((isDirty: () => boolean) => {
    settingsDirtyRef.current = isDirty;
  }, []);

  /** Confirm discard when leaving settings while the form is dirty. */
  const confirmLeaveSettings = useCallback((): boolean => {
    if (!settingsDirtyRef.current()) return true;
    return window.confirm("Discard unsaved settings changes?");
  }, []);

  const openSettings = useCallback(() => {
    setSessionsOpen(false);
    setSettingsOpen(true);
    setGitOpen(false);
    setTerminalOpen(false);
    session.setInspectorOpen(false);
    session.setJobsView(false);
  }, [session]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      if (settingsDirtyRef.current() && !window.confirm("Discard unsaved settings changes?")) {
        return;
      }
      setSettingsOpen(false);
      return;
    }
    setGitOpen(false);
    setTerminalOpen(false);
    setSessionsOpen(false);
    session.setInspectorOpen(false);
    session.setJobsView(false);
    setSettingsOpen(true);
  }, [settingsOpen, session]);

  const openGit = useCallback(() => {
    if (!cwd) return;
    if (!confirmLeaveSettings()) return;
    setGitOpen(true);
    setSessionsOpen(false);
    setSettingsOpen(false);
    setTerminalOpen(false);
    session.setInspectorOpen(false);
    session.setJobsView(false);
  }, [cwd, confirmLeaveSettings, session]);

  const toggleGit = useCallback(() => {
    if (!cwd) return;
    if (gitOpen) {
      setGitOpen(false);
      return;
    }
    if (settingsDirtyRef.current() && !window.confirm("Discard unsaved settings changes?")) {
      return;
    }
    setSettingsOpen(false);
    setSessionsOpen(false);
    setTerminalOpen(false);
    session.setInspectorOpen(false);
    session.setJobsView(false);
    setGitOpen(true);
  }, [cwd, gitOpen, session]);

  const toggleInspector = useCallback(() => {
    if (settingsOpen) {
      if (!confirmLeaveSettings()) return;
      setSettingsOpen(false);
      setSessionsOpen(false);
      setGitOpen(false);
      setTerminalOpen(false);
      setInspectorFocusPath(null);
      setInspectorFocusSection(null);
      setInspectorTool("session");
      session.setInspectorOpen(true);
      return;
    }
    setGitOpen(false);
    setSessionsOpen(false);
    setTerminalOpen(false);
    session.setJobsView(false);
    session.setInspectorOpen((v) => {
      if (v) {
        setInspectorFocusPath(null);
        setInspectorFocusSection(null);
      } else {
        setInspectorTool("session");
      }
      return !v;
    });
  }, [settingsOpen, confirmLeaveSettings, session]);

  const openSessionReview = useCallback(
    (
      path?: string,
      tool: "session" | "changes" = path ? "changes" : "session",
      focusSection: "subagents" | null = null,
    ) => {
      if (settingsOpen && !confirmLeaveSettings()) return;
      setSettingsOpen(false);
      setSessionsOpen(false);
      setGitOpen(false);
      setTerminalOpen(false);
      session.setJobsView(false);
      setInspectorFocusPath(path ?? null);
      setInspectorFocusSection(focusSection);
      setInspectorTool(tool);
      session.setInspectorOpen(true);
    },
    [settingsOpen, confirmLeaveSettings, session],
  );

  const openWorkspaceDock = useCallback(
    (target: WorkspaceDockTarget) => {
      if (target === "files") {
        if (!cwd) return;
        revealPath(cwd);
        return;
      }
      if (target === "git") {
        openGit();
        return;
      }
      if (target === "jobs") {
        if (settingsOpen && !confirmLeaveSettings()) return;
        setSettingsOpen(false);
        setSessionsOpen(false);
        setGitOpen(false);
        setTerminalOpen(false);
        session.setInspectorOpen(false);
        setInspectorFocusPath(null);
        // Toggle so the dock control matches keyboard / e2e "Toggle background jobs".
        session.setJobsView((open) => !open);
        return;
      }
      if (target === "terminal") {
        if (settingsOpen && !confirmLeaveSettings()) return;
        setSettingsOpen(false);
        setSessionsOpen(false);
        setGitOpen(false);
        session.setInspectorOpen(false);
        session.setJobsView(false);
        setInspectorFocusPath(null);
        setTerminalOpen((open) => !open);
        return;
      }
      if (target === "changes") {
        // Open highest-churn file first (same order as the turn card / inspector list).
        const ordered = sortChangedFilesForDisplay(session.transcript.changedFiles);
        openSessionReview(ordered[0]?.path, "changes");
        return;
      }
      // session overview
      openSessionReview();
    },
    [cwd, openGit, settingsOpen, confirmLeaveSettings, session, openSessionReview, revealPath],
  );

  const selectActivityTool = useCallback(
    (target: ActivitySidebarTarget) => {
      if (target === activeEndPanel) return;
      openWorkspaceDock(target);
    },
    [activeEndPanel, openWorkspaceDock],
  );

  const closeActiveEndPanel = useCallback(() => {
    if (activeEndPanel === "session" || activeEndPanel === "changes") {
      setInspectorFocusPath(null);
      setInspectorFocusSection(null);
      session.setInspectorOpen(false);
      return;
    }
    if (activeEndPanel === "jobs") {
      session.setJobsView(false);
      return;
    }
    if (activeEndPanel === "git") {
      setGitOpen(false);
      return;
    }
    if (activeEndPanel === "terminal") setTerminalOpen(false);
  }, [activeEndPanel, session]);

  // Preview harness: auto-open a panel when a `vibe-preview-open-panel` event
  // is dispatched (used by `npm run ui:preview ?scenario=settings|git|changes|cloud-*`).
  useEffect(() => {
    const onOpenPanel = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === "settings") openSettings();
      if (detail === "git") openGit();
      if (detail === "changes") openWorkspaceDock("changes");
      if (detail === "sessions") {
        setSettingsOpen(false);
        setGitOpen(false);
        setTerminalOpen(false);
        session.setInspectorOpen(false);
        session.setJobsView(false);
        setSessionsOpen(true);
        if (belowBreakpoint("tablet")) setProjectRailOpen(false);
      }
      if (detail === "cloud") {
        setCloudRequest({ target: "cloud", provider: "e2b" });
        setCloudProgress(null);
        setCloudSheetOpen(true);
      }
    };
    window.addEventListener("vibe-preview-open-panel", onOpenPanel);
    return () => window.removeEventListener("vibe-preview-open-panel", onOpenPanel);
  }, [openSettings, openGit, openWorkspaceDock, session]);

  // Global keyboard shortcuts for app-owned panels. Native menu accelerators
  // route through the same actions in Electron; this also keeps preview mode
  // and non-macOS behavior consistent.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        toggleSettings();
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "b" || event.key === "B")) {
        event.preventDefault();
        toggleGit();
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "j" || event.key === "J")) {
        event.preventDefault();
        openWorkspaceDock(event.shiftKey ? "jobs" : "terminal");
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "/") {
        event.preventDefault();
        setKeysOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSettings, toggleGit, openWorkspaceDock]);

  const chromeRef = useRef(session.chrome);
  chromeRef.current = session.chrome;

  const dismissCatalog = useCallback(() => {
    catalogPresentationGate.current.invalidate();
    pickerRetryRef.current = null;
    setPicker(null);
  }, []);

  const invalidateCatalogs = useCallback(() => {
    catalogGeneration.current += 1;
    catalogPresentationGate.current.invalidate();
    pickerRetryRef.current = null;
    catalogCache.current.clear();
    setPicker(null);
    setModelTarget("main");
  }, []);

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[] | null> => {
    const request = projectRefreshGate.current.begin();
    setProjectsLoading(true);
    try {
      const res = await window.vibe.listProjects();
      if (!projectRefreshGate.current.isCurrent(request)) return null;
      if (res.ok && isProjectSummaryArray(res.value)) {
        setProjects(res.value);
        setProjectsLoaded(true);
        setProjectsError(null);
        return res.value;
      } else {
        setProjectsError("Project history is unavailable.");
        return null;
      }
    } catch {
      if (projectRefreshGate.current.isCurrent(request)) {
        setProjectsError("Project history is unavailable.");
      }
      return null;
    } finally {
      if (projectRefreshGate.current.isCurrent(request)) setProjectsLoading(false);
    }
  }, []);

  const openSessions = useCallback(() => {
    if (settingsOpen && !confirmLeaveSettings()) return;
    setSettingsOpen(false);
    setGitOpen(false);
    setTerminalOpen(false);
    session.setInspectorOpen(false);
    session.setJobsView(false);
    setSessionsOpen(true);
    void refreshProjects();
  }, [confirmLeaveSettings, refreshProjects, session, settingsOpen]);

  const openProjectAt = useCallback(
    async (path: string): Promise<boolean> => {
      // Project switch reloads settings (even Global scope uses cwd in load deps).
      // Never wipe dirty config/instructions without an explicit discard.
      const wasDirty = settingsDirtyRef.current();
      if (!confirmLeaveSettings()) return false;
      if (wasDirty) setSettingsOpen(false);
      setProjectOpenError(null);
      invalidateCatalogs();
      const cloud = await window.vibe.listCloudSessions();
      if (!cloud.ok) {
        const message = `Couldn’t verify cloud ownership: ${cloud.error}`;
        setProjectOpenError(message);
        session.showToast(message, "error");
        return false;
      }
      const cloudList = cloud.value;
      const projectList = await refreshProjects() ?? projects;
      const localSessions = projectList.find((item) => normalizeCwd(item.cwd) === normalizeCwd(path))?.sessions ?? [];
      const cloudOwned = latestRemoteOwnedCloudSession(
        cloudList.filter((item) => normalizeCwd(item.sourceRoot) === normalizeCwd(path)),
        localSessions,
      );
      if (cloudOwned) {
        const connected = await window.vibe.reconnectCloudSession(cloudOwned.sessionId);
        if (connected.ok) {
          setCwd(path);
          setCloudSessions(cloudList);
          await session.attachCurrent(path, cloudOwned.appearance);
          await refreshProjects();
          return true;
        }
        setProjectOpenError(connected.error);
        session.showToast(connected.error, "error");
        return false;
      }
      const ok = await session.bootstrap({ cwd: path });
      if (!ok) {
        setProjectOpenError(session.bootError ?? "The engine could not open this workspace.");
        return false;
      }
      setCwd(path);
      await refreshProjects();
      const onboardingProbe = onboardingProbeGate.current.begin();
      try {
        const [prov, models] = await Promise.all([
          window.vibe.rpc("listProviders"),
          window.vibe.rpc("listModels"),
        ]);
        if (!onboardingProbeGate.current.isCurrent(onboardingProbe)) return true;
        if (!prov.ok) {
          setOnboardingProviders([]);
          setShowOnboarding(false);
          return true;
        }
        const items = (prov.value as ProviderInfo[]) ?? [];
        const modelItems = models.ok ? (models.value as ModelSummary[]) : [];
        catalogCache.current.set("providers", items);
        if (models.ok) catalogCache.current.set("models", modelItems);
        setOnboardingProviders(items as ProviderStatus[]);
        setShowOnboarding(
          !hasUsableOnboardingProvider(items, modelItems)
            && !onboardingDismissed.current,
        );
      } catch {
        if (!onboardingProbeGate.current.isCurrent(onboardingProbe)) return true;
        // Unknown provider state must not open a misleading first-run modal.
        setOnboardingProviders([]);
        setShowOnboarding(false);
      }
      return true;
    },
    [session, refreshProjects, projects, invalidateCatalogs, confirmLeaveSettings],
  );

  const saveOnboarding = useCallback(
    async (patch: Record<string, unknown>) => {
      onboardingProbeGate.current.invalidate();
      setOnboardingSaving(true);
      setOnboardingError(null);
      let rollbackPatch: Record<string, unknown> | null = null;
      let wroteConfig = false;
      try {
        const previous = await window.vibe.readConfig({ scope: "global" });
        if (!previous.ok) {
          setOnboardingError(`Could not read existing settings safely: ${previous.error}`);
          return;
        }
        const original = (previous.config ?? {}) as Record<string, unknown>;
        const proposed = applyConfigPatch(original, patch);
        rollbackPatch = buildConfigPatch(proposed, original);

        const res = await window.vibe.writeConfig({ scope: "global", patch });
        if (!res.ok) {
          setOnboardingError(res.error);
          return;
        }
        wroteConfig = true;
        // Provider/model RPC results were produced by the previous runtime
        // configuration. Never let setup success leave stale picker results.
        invalidateCatalogs();
        if (!cwd) {
          setOnboardingError(
            "Provider settings were saved, but no project is open. Open a project to start the engine.",
          );
          return;
        }

        // Treat setup as complete only after the engine accepts the new
        // configuration. Closing the modal after the config write alone left
        // users stranded on a boot error with no guided way to correct a bad
        // provider, model, or custom endpoint.
        const bootstrapped = await session.bootstrap({ cwd });
        if (!bootstrapped) {
          const restored = await window.vibe.writeConfig({ scope: "global", patch: rollbackPatch });
          const runtimeRestored = restored.ok ? await session.bootstrap({ cwd }) : false;
          setOnboardingError(restored.ok && runtimeRestored
            ? "The engine could not start with those settings. Previous settings were restored; review the provider, model, and endpoint, then try again."
            : restored.ok
              ? "The engine could not start with those settings. The previous config file was restored, but the engine could not restart. Review the setup and try again."
              : `The engine could not start, and automatic settings restore failed: ${restored.error}`);
          return;
        }

        onboardingDismissed.current = false;
        setShowOnboarding(false);
        setProviderSetupRequest(null);
      } catch (err) {
        let restoreFailure = "";
        if (wroteConfig && rollbackPatch) {
          try {
            const restored = await window.vibe.writeConfig({ scope: "global", patch: rollbackPatch });
            if (!restored.ok) {
              restoreFailure = ` Automatic restore also failed: ${restored.error}`;
            } else if (cwd) {
              const runtimeRestored = await session.bootstrap({ cwd });
              if (!runtimeRestored) {
                restoreFailure = " The previous config file was restored, but the engine could not restart.";
              }
            }
          } catch (restoreError) {
            restoreFailure = ` Automatic restore also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
          }
        }
        setOnboardingError(`${err instanceof Error ? err.message : "Failed to save"}${restoreFailure}`);
      } finally {
        setOnboardingSaving(false);
      }
    },
    [cwd, session, invalidateCatalogs],
  );

  const openProject = useCallback(async () => {
    try {
      const path = await window.vibe.openProject();
      if (!path) return;
      await openProjectAt(path);
    } catch (error) {
      session.showToast(
        error instanceof Error ? error.message : "Couldn’t open the project picker",
        "error",
      );
    }
  }, [openProjectAt, session]);

  // Application menu actions — single subscription (continueLatest included once defined).

  // Launch directly into a safe workspace. Project selection is a recovery
  // path, not a required onboarding screen.
  useEffect(() => {
    if (didRestoreProject.current) return;
    didRestoreProject.current = true;
    void (async () => {
      try {
        const recent = await refreshProjects();
        let last: string | null = null;
        try {
          last = localStorage.getItem("vibe.lastCwd");
        } catch {
          /* ignore */
        }
        if (recent) {
          for (const project of startupProjectCandidates(recent, last)) {
            if (await openProjectAt(project.cwd)) return;
          }
        }
        if (last && recent && !recent.some(
          (project) => normalizeCwd(project.cwd) === normalizeCwd(last),
        )) {
          // Remove a stale or forged restore hint only after the host index
          // loaded successfully. Transient host failures must not erase it.
          try {
            localStorage.removeItem("vibe.lastCwd");
          } catch {
            /* ignore */
          }
        }

        // A fresh install still has a useful main view: the dedicated Chats
        // workspace is created and authorized by the host, then bootstrapped
        // through the same ownership-safe path as a project.
        try {
          const chats = await window.vibe.ensureChatsDir();
          setChatsCwd(chats);
          if (await openProjectAt(chats)) return;
        } catch (error) {
          setProjectOpenError(
            error instanceof Error ? error.message : "Couldn’t open the Chats workspace.",
          );
        }
      } finally {
        setInitialProjectRestoreSettled(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep welcome-gate recents fresh when still on the cold-start screen.
  useEffect(() => {
    if (!initialProjectRestoreSettled) return;
    if (cwd || session.booting) return;
    if (projectsLoaded || projectsLoading || projectsError) return;
    void refreshProjects();
  }, [cwd, initialProjectRestoreSettled, session.booting, projectsLoaded, projectsLoading, projectsError, refreshProjects]);

  const resumeSession = useCallback(
    async (projectCwd: string, id: string) => {
      const wasDirty = settingsDirtyRef.current();
      if (!confirmLeaveSettings()) return;
      if (wasDirty) setSettingsOpen(false);
      invalidateCatalogs();
      const cloud = await window.vibe.listCloudSessions();
      if (!cloud.ok) {
        session.showToast(`Couldn’t verify cloud ownership: ${cloud.error}`, "error");
        return;
      }
      const cloudList = cloud.value;
      const cloudOwned = cloudList.find((item) => item.sessionId === id && isCloudSessionRemoteOwned(item.status));
      if (cloudOwned) {
        const connected = await window.vibe.reconnectCloudSession(id);
        if (connected.ok) {
          setSessionsOpen(false);
          setCwd(projectCwd);
          setCloudSessions(cloudList);
          await session.attachCurrent(projectCwd, cloudOwned.appearance);
          await refreshProjects();
        } else session.showToast(connected.error, "error");
        return;
      }
      const ok = await session.bootstrap({ cwd: projectCwd, resume: id });
      if (ok) {
        setSessionsOpen(false);
        setCwd(projectCwd);
        await refreshProjects();
      }
    },
    [session, refreshProjects, invalidateCatalogs, confirmLeaveSettings],
  );

  useEffect(() => window.vibe.onLocalRuntimeNotificationActivation((target) => {
    void resumeSession(target.cwd, target.sessionId);
  }), [resumeSession]);

  const continueLatest = useCallback(async () => {
    if (!cwd) return;
    const wasDirty = settingsDirtyRef.current();
    if (!confirmLeaveSettings()) return;
    if (wasDirty) setSettingsOpen(false);
    invalidateCatalogs();
    const cloud = await window.vibe.listCloudSessions();
    if (!cloud.ok) {
      session.showToast(`Couldn’t verify cloud ownership: ${cloud.error}`, "error");
      return;
    }
    const projectList = await refreshProjects() ?? projects;
    const localSessions = projectList.find((item) => normalizeCwd(item.cwd) === normalizeCwd(cwd))?.sessions ?? [];
    const cloudOwned = latestRemoteOwnedCloudSession(
      cloud.value.filter((item) => normalizeCwd(item.sourceRoot) === normalizeCwd(cwd)),
      localSessions,
    );
    if (cloudOwned) {
      const connected = await window.vibe.reconnectCloudSession(cloudOwned.sessionId);
      if (!connected.ok) session.showToast(connected.error, "error");
      else {
        setCloudSessions(cloud.value);
        await session.attachCurrent(cwd, cloudOwned.appearance);
        await refreshProjects();
      }
      return;
    }
    const ok = await session.bootstrap({ cwd, continueLatest: true });
    if (ok) await refreshProjects();
  }, [cwd, session, refreshProjects, projects, invalidateCatalogs, confirmLeaveSettings]);

  const newSession = useCallback(async () => {
    if (!cwd) return false;
    if (settingsOpen && !confirmLeaveSettings()) return false;
    invalidateCatalogs();
    const ok = await session.bootstrap({ cwd });
    if (ok) {
      setSettingsOpen(false);
      setSessionsOpen(false);
      setDraft("");
      setFollowSignal((value) => value + 1);
      await refreshProjects();
    }
    return ok;
  }, [cwd, session, settingsOpen, confirmLeaveSettings, refreshProjects, invalidateCatalogs]);

  // Single menu router for File, Tools, and Help actions.
  useEffect(() => {
    const off = window.vibe.onMenuAction((action) => {
      switch (action) {
        case "newSession":
          void newSession();
          break;
        case "openProject":
          void openProject();
          break;
        case "toggleSettings":
          toggleSettings();
          break;
        case "toggleGit":
          toggleGit();
          break;
        case "toggleInspector":
          toggleInspector();
          break;
        case "toggleTerminal":
          openWorkspaceDock("terminal");
          break;
        case "toggleJobs":
          openWorkspaceDock("jobs");
          break;
        case "showKeys":
          setKeysOpen(true);
          break;
        case "continueLatest":
          void continueLatest();
          break;
      }
    });
    return off;
  }, [newSession, openProject, toggleSettings, toggleGit, toggleInspector, openWorkspaceDock, continueLatest]);

  const startProjectChat = useCallback(async (projectCwd: string) => {
    const wasDirty = settingsDirtyRef.current();
    if (!confirmLeaveSettings()) return;
    if (wasDirty) setSettingsOpen(false);
    invalidateCatalogs();
    const ok = await session.bootstrap({ cwd: projectCwd });
    if (ok) {
      setSessionsOpen(false);
      setCwd(projectCwd);
      setDraft("");
      setFollowSignal((value) => value + 1);
      await refreshProjects();
    }
  }, [confirmLeaveSettings, invalidateCatalogs, refreshProjects, session]);

  /** One-off conversation in `~/.vibe/chats` — not a code project. */
  const startNewChat = useCallback(async () => {
    const wasDirty = settingsDirtyRef.current();
    if (!confirmLeaveSettings()) return;
    if (wasDirty) setSettingsOpen(false);
    try {
      const path = await window.vibe.ensureChatsDir();
      setChatsCwd(path);
      invalidateCatalogs();
      setGitOpen(false);
      const ok = await session.bootstrap({ cwd: path });
      if (ok) {
        setSessionsOpen(false);
        setCwd(path);
        setDraft("");
        setFollowSignal((value) => value + 1);
        await refreshProjects();
      }
    } catch (err) {
      session.showToast(
        err instanceof Error ? err.message : "Couldn’t create chats folder",
        "error",
      );
    }
  }, [session, confirmLeaveSettings, invalidateCatalogs, refreshProjects]);

  // Resolve chats path early so the rail can partition before first chat.
  useEffect(() => {
    void window.vibe.ensureChatsDir().then(setChatsCwd).catch(() => {
      /* path optional until first chat */
    });
    void window.vibe.getPath("home").then(setHomeCwd).catch(() => {
      /* terminal waits for a safe context-specific cwd */
    });
  }, []);

  const renameSession = useCallback(
    async (projectCwd: string, id: string, title: string) => {
      try {
        const res = await window.vibe.renameSession({ cwd: projectCwd, id, title });
        if (!res.ok) {
          session.showToast(res.error || "Rename failed", "error");
          return false;
        }
        await refreshProjects();
        return true;
      } catch (error) {
        session.showToast(error instanceof Error ? error.message : "Rename failed", "error");
        return false;
      }
    },
    [refreshProjects, session],
  );

  const renameProject = useCallback(
    async (projectCwd: string, name: string) => {
      try {
        const res = await window.vibe.renameProject({ cwd: projectCwd, name });
        if (!res.ok) {
          session.showToast(res.error || "Rename project failed", "error");
          return false;
        }
        await refreshProjects();
        session.showToast("Project renamed");
        return true;
      } catch (error) {
        session.showToast(error instanceof Error ? error.message : "Rename project failed", "error");
        return false;
      }
    },
    [refreshProjects, session],
  );

  const archiveProject = useCallback(
    async (projectCwd: string) => {
      if (projectCwd === cwd) {
        session.showToast("Open another project before archiving this project.", "warn");
        return false;
      }
      try {
        const res = await window.vibe.archiveProject({ cwd: projectCwd });
        if (!res.ok) {
          session.showToast(res.error || "Archive project failed", "error");
          return false;
        }
        await refreshProjects();
        session.showToast("Project archived");
        return true;
      } catch (error) {
        session.showToast(error instanceof Error ? error.message : "Archive project failed", "error");
        return false;
      }
    },
    [cwd, refreshProjects, session],
  );

  const deleteProject = useCallback(
    async (projectCwd: string) => {
      if (projectCwd === cwd) {
        session.showToast("Open another project before deleting this project.", "warn");
        return false;
      }
      try {
        const res = await window.vibe.deleteProject({ cwd: projectCwd });
        if (!res.ok) {
          session.showToast(res.error || "Delete project failed", "error");
          return false;
        }
        await deleteTranscriptCachesForCwd(projectCwd);
        await refreshProjects();
        session.showToast("Project deleted");
        return true;
      } catch (error) {
        session.showToast(error instanceof Error ? error.message : "Delete project failed", "error");
        return false;
      }
    },
    [cwd, refreshProjects, session],
  );

  const removeSession = useCallback(
    async (projectCwd: string, id: string, mode: "delete" | "archive") => {
      const active = id === session.chrome.sessionId && projectCwd === cwd;
      // Retire/finalize the active engine before removing its persisted record;
      // otherwise shutdown can save the just-deleted session back to disk.
      if (active && !(await newSession())) return false;
      try {
        const res =
          mode === "delete"
            ? await window.vibe.deleteSession({ cwd: projectCwd, id })
            : await window.vibe.archiveSession({ cwd: projectCwd, id });
        if (!res.ok) {
          session.showToast(res.error || `${mode === "delete" ? "Delete" : "Archive"} failed`, "error");
          return false;
        }
        if (mode === "delete") await deleteTranscriptCache(projectCwd, id);
        await refreshProjects();
        session.showToast(mode === "delete" ? "Session deleted" : "Session archived");
        return true;
      } catch (error) {
        session.showToast(
          error instanceof Error ? error.message : `${mode === "delete" ? "Delete" : "Archive"} failed`,
          "error",
        );
        return false;
      }
    },
    [cwd, newSession, refreshProjects, session],
  );

  const forkSession = useCallback(
    async (projectCwd: string, id: string, atTurnId?: string) => {
      try {
        const result = await window.vibe.forkSession({ cwd: projectCwd, id, ...(atTurnId ? { atTurnId } : {}) });
        if (!result.ok) {
          session.showToast(result.error || "Fork failed", "error");
          return false;
        }
        const opened = await session.bootstrap({ cwd: projectCwd, resume: result.value.id });
        if (!opened) return false;
        setCwd(projectCwd);
        setSessionsOpen(false);
        setDraft("");
        await refreshProjects();
        session.showToast("Session forked");
        return true;
      } catch (error) {
        session.showToast(error instanceof Error ? error.message : "Fork failed", "error");
        return false;
      }
    },
    [refreshProjects, session],
  );

  /** Prevent double resolve-permission / resolve-plan from keyboard + card races. */
  const resolvingGate = useRef(false);

  const commandFitsInboundLimit = useCallback(
    (command: EngineCommand): boolean => {
      if (encodedEngineCommandBytes(command) <= HOST_INBOUND_SAFE_BYTES) return true;
      session.showToast(
        "Message is too large to send safely. Shorten it or attach the content as a file.",
        "error",
      );
      return false;
    },
    [session],
  );

  const answerPerm = useCallback(
    async (decision: "once" | "always" | "always-project" | "deny", feedback?: string) => {
      const perm = session.chrome.perms[0];
      if (!perm || resolvingGate.current) return false;
      const gateSessionId = session.chrome.sessionId;
      const command: EngineCommand = {
        type: "resolve-permission",
        id: perm.id,
        decision,
        ...(feedback ? { feedback } : {}),
      };
      if (!commandFitsInboundLimit(command)) return false;
      resolvingGate.current = true;
      try {
        const sent = await session.send(command);
        if (!sent) return false;
        // A slow renderer→host write can settle after New/Open/Resume replaced
        // the session. Never let an acknowledgement for the old permission
        // mutate a new session whose request happens to reuse the same id.
        if (chromeRef.current.sessionId !== gateSessionId) return true;
        session.dispatchChrome({ type: "drop-perm", id: perm.id });
        // Do not synthesize an "allowed" transcript notice here. The IPC result
        // only acknowledges transport; a concurrent permission-settled event may
        // have already caused the engine to reject this stale id.
        return true;
      } finally {
        resolvingGate.current = false;
      }
    },
    [commandFitsInboundLimit, session],
  );

  const answerPlan = useCallback(
    async (
      decision: "accept" | "edit" | "keep-planning",
      edit?: string,
      approvals?: "auto",
    ) => {
      if (resolvingGate.current) return false;
      const pendingPlan = session.chrome.plan;
      if (!pendingPlan) return false;
      const gateSessionId = session.chrome.sessionId;
      const blocked = planResolutionBlockedReason(decision, session.chrome.goalRun);
      if (blocked) {
        session.showToast(blocked, "warn");
        return false;
      }
      const command: EngineCommand = {
        type: "resolve-plan",
        decision,
        ...(edit ? { edit } : {}),
        ...(approvals ? { approvals } : {}),
      };
      if (!commandFitsInboundLimit(command)) return false;
      resolvingGate.current = true;
      try {
        const sent = await session.send(command);
        if (!sent) return false;
        // Only the exact plan/session that originated this send may be cleared.
        // A delayed acknowledgement must not dismiss a newer plan or mark a
        // newly-opened session busy.
        if (
          chromeRef.current.sessionId !== gateSessionId
          || chromeRef.current.plan !== pendingPlan
        ) {
          return true;
        }
        session.dispatchChrome({ type: "clear-plan" });
        // Accept/edit start real engine work — match commandsExpectBusy optimism.
        if (decision === "accept" || decision === "edit") {
          session.setBusy(true);
        }
        return true;
      } finally {
        resolvingGate.current = false;
      }
    },
    [commandFitsInboundLimit, session],
  );

  const resolveModeTransition = useCallback(
    async (choice: "run" | "switch" | "cancel") => {
      const pending = session.pendingModeTransition;
      if (!pending) return;
      if (choice === "cancel") {
        session.dismissPendingModeTransition();
        return;
      }
      const plan = chromeRef.current.plan;
      if (
        chromeRef.current.sessionId !== pending.sessionId
        || !plan
        || plan.text !== pending.planIdentity
      ) {
        session.dismissPendingModeTransition();
        return;
      }

      let sent = false;
      if (choice === "run") {
        if (pending.target === "execute") {
          sent = await session.send({ type: "set-approvals", mode: "ask", quiet: true })
            && await answerPlan("accept");
        } else {
          sent = await answerPlan("accept", undefined, "auto");
        }
      } else {
        sent = await session.sendMany(commandsForPlanExitWithoutRunning(pending.target));
        if (
          sent
          && chromeRef.current.sessionId === pending.sessionId
          && chromeRef.current.plan?.text === pending.planIdentity
        ) {
          session.dispatchChrome({ type: "clear-plan" });
        }
      }

      if (sent && chromeRef.current.sessionId === pending.sessionId) {
        const state = engineStateForUiMode(pending.target);
        session.dispatchChrome({ type: "optimistic-mode", mode: state.mode, approvals: state.approvals });
      }
      session.dismissPendingModeTransition();
    },
    [answerPlan, session],
  );

  const answerQuestion = useCallback(
    async (answers: string[], freeform?: string) => {
      const question = chromeRef.current.question;
      if (!question || resolvingGate.current) return false;
      const command: EngineCommand = {
        type: "resolve-question",
        id: question.id,
        answers,
        ...(freeform ? { freeform } : {}),
      };
      if (!commandFitsInboundLimit(command)) return false;
      resolvingGate.current = true;
      try {
        return await session.send(command);
      } finally {
        resolvingGate.current = false;
      }
    },
    [commandFitsInboundLimit, session],
  );

  // Centralized catalog presenter (I42): keeps the popover open across
  // loading → ready / error so RPC failures show inline instead of as a
  // vanishing toast. Each call site supplies its cache, fetch, and the
  // loading/ready picker descriptors.
  const presentCatalog = useCallback(
    async <T,>(opts: {
      cacheKey: CatalogCacheKey;
      fetch: () => Promise<{ ok: true; value: T[] } | { ok: false; error: string }>;
      loadingPicker: CatalogPickerState;
      readyPicker: (items: T[]) => CatalogPickerState;
      cancelled: () => boolean;
    }): Promise<boolean> => {
      const generation = catalogGeneration.current;
      const request = catalogPresentationGate.current.begin();
      const isCurrent = () => catalogPresentationGate.current.isCurrent(request);
      let items = catalogCache.current.get<T>(opts.cacheKey);
      if (!items) {
        setPicker({ ...opts.loadingPicker, status: "loading" });
        pickerRetryRef.current = () => {
          void presentCatalog(opts);
        };
        let res: { ok: true; value: T[] } | { ok: false; error: string };
        try {
          res = await opts.fetch();
        } catch (error) {
          res = {
            ok: false,
            error: error instanceof Error ? error.message : "Catalog request failed",
          };
        }
        if (opts.cancelled() || generation !== catalogGeneration.current || !isCurrent()) {
          // A newer request or explicit close owns the picker now. A stale
          // completion must never clear or reopen that newer presentation.
          return false;
        }
        if (!res.ok) {
          setPicker({ ...opts.loadingPicker, status: "error", error: res.error });
          return false;
        }
        items = res.value;
        catalogCache.current.set(opts.cacheKey, items);
      }
      if (opts.cancelled() || generation !== catalogGeneration.current || !isCurrent()) {
        return false;
      }
      pickerRetryRef.current = null;
      setPicker(opts.readyPicker(items));
      return true;
    },
    [],
  );

  const retryCatalog = useCallback(() => {
    pickerRetryRef.current?.();
  }, []);

  const openModelsPicker = useCallback(
    async (target: ModelPickerTarget, query = ""): Promise<boolean> => {
      return presentCatalog<ModelSummary>({
        cacheKey: "models",
        fetch: async () => {
          const res = await window.vibe.rpc("listModels");
          return res.ok ? { ok: true, value: res.value as ModelSummary[] } : { ok: false, error: res.error };
        },
        loadingPicker: { kind: "models", items: [], target, query },
        readyPicker: (items) => {
          const chrome = chromeRef.current;
          return {
            kind: "models",
            items,
            target,
            query,
            current: currentModelForTarget(
              target,
              chrome.model,
              chrome.subagentModel,
              catalogCache.current.get<AgentInfo>("agents") ?? [],
            ),
          };
        },
        cancelled: () => false,
      });
    },
    [presentCatalog],
  );

  // Compose in $VISUAL/$EDITOR (TUI parity: composeInEditor). Reused by the
  // ⌘G shortcut and the composer insert menu so the affordance is discoverable
  // beyond keyboard-only users (I27).
  const composeInEditor = useCallback(async () => {
    try {
      const res = await window.vibe.composeInEditor(draft);
      if (res.ok && res.text != null) {
        if (res.text.trim().length > 0) {
          setDraft(res.text);
        } else {
          session.dispatchTranscript({
            type: "notice",
            text: "Editor draft was empty — kept your prior text.",
            level: "info",
          });
        }
      } else if (res.reason === "failed") {
        session.dispatchTranscript({
          type: "notice",
          text: `The external editor failed${res.error ? `: ${res.error}` : ""} — kept your prior text.`,
          level: "warn",
        });
      } else if (res.reason === "no-editor") {
        session.dispatchTranscript({
          type: "notice",
          text: "Set $VISUAL or $EDITOR to compose in an external editor.",
          level: "warn",
        });
      } else if (res.reason === "kept") {
        session.dispatchTranscript({
          type: "notice",
          text: "External editor made no replacement — kept your prior text.",
          level: "info",
        });
      }
    } catch (error) {
      session.dispatchTranscript({
        type: "notice",
        text: `The external editor failed: ${error instanceof Error ? error.message : String(error)} — kept your prior text.`,
        level: "warn",
      });
    } finally {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
      });
    }
  }, [draft, session]);

  const submitLine = useCallback(
    async (line: string): Promise<boolean> => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (cloudTransitioning) {
        session.showToast("Session handoff is in progress; wait for it to finish before sending", "warn");
        return false;
      }
      const catalogRequestGeneration = catalogGeneration.current;

      const localRoute = classifySubmitLine(trimmed);
      if (localRoute.kind === "jobs") {
        // Same mutual-exclusion as the dock control (Session/Changes/Git/Terminal/Jobs).
        openWorkspaceDock("jobs");
        return true;
      }
      if (localRoute.kind === "keys") {
        setKeysOpen(true);
        return true;
      }
      if (localRoute.kind === "settings") {
        openSettings();
        return true;
      }
      if (localRoute.kind === "git") {
        if (!cwd) return false;
        openGit();
        return true;
      }
      const handoff = parseHandoffCommand(trimmed);
      if (handoff) {
        const cloudOwned = cloudSessions.some((item) =>
          item.sessionId === session.chrome.sessionId && isCloudSessionRemoteOwned(item.status));
        const action = resolveHandoffCommandAction(handoff, cloudOwned);
        if (action === "already-local" || action === "already-cloud") {
          session.showToast(action === "already-local" ? "Session is already running locally" : "Session is already running in Cloud", "info");
          return true;
        }
        setCloudRequest({
          target: action,
          ...(handoff.provider ? { provider: handoff.provider } : {}),
          ...(handoff.instruction ? { instruction: handoff.instruction } : {}),
        });
        setCloudProgress(null);
        setCloudSheetOpen(true);
        return true;
      }

      setFollowSignal((value) => value + 1);

      if (session.chrome.perms[0] && !trimmed.startsWith("/")) {
        const route = routePendingPermLine(trimmed);
        if (route.kind === "perm") {
          return await answerPerm(route.decision, route.feedback);
        }
      }

      if (session.chrome.plan && !trimmed.startsWith("/")) {
        return await answerPlan("edit", trimmed);
      }

      if (trimmed === "/clear" || trimmed === "/new") {
        if (session.chrome.busy) await session.send({ type: "abort" });
        session.clearSessionLocal();
        return await session.sendMany(lineToCommands(trimmed));
      }

      // Bare catalog commands — keep Enter path for keyboard users; live draft also opens these.
      if (trimmed === "/model" || trimmed === "/models") {
        setModelTarget("main");
        const opened = await openModelsPicker("main");
        if (!opened) return false;
        if (trimmed === "/models") return await session.sendMany(lineToCommands(trimmed));
        return true;
      }
      if (trimmed === "/providers") {
        return presentCatalog<ProviderInfo>({
          cacheKey: "providers",
          fetch: async () => {
            const res = await window.vibe.rpc("listProviders");
            return res.ok ? { ok: true, value: res.value as ProviderInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "providers", items: [] },
          readyPicker: (items) => ({ kind: "providers", items }),
          cancelled: () => catalogRequestGeneration !== catalogGeneration.current,
        });
      }
      if (trimmed === "/agents") {
        return presentCatalog<AgentInfo>({
          cacheKey: "agents",
          fetch: async () => {
            const res = await window.vibe.rpc("listAgents");
            return res.ok ? { ok: true, value: res.value as AgentInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "agents", items: [] },
          readyPicker: (items) => ({ kind: "agents", items }),
          cancelled: () => catalogRequestGeneration !== catalogGeneration.current,
        });
      }
      if (trimmed === "/skills" || trimmed.startsWith("/skills ")) {
        const skillsQuery = trimmed.slice("/skills".length).trim();
        return presentCatalog<SkillInfo>({
          cacheKey: "skills",
          fetch: async () => {
            const res = await window.vibe.rpc("listSkills");
            return res.ok ? { ok: true, value: res.value as SkillInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "skills", items: [], query: skillsQuery },
          readyPicker: (items) => ({ kind: "skills", items, query: skillsQuery }),
          cancelled: () => catalogRequestGeneration !== catalogGeneration.current,
        });
      }
      if (trimmed === "/mcp") {
        return presentCatalog<McpServerInfo>({
          cacheKey: "mcp",
          fetch: async () => {
            const res = await window.vibe.rpc("listMcp");
            return res.ok
              ? { ok: true, value: asMcpList(res.value) }
              : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "mcp", items: [] },
          readyPicker: (items) => ({ kind: "mcp", items }),
          cancelled: () => catalogRequestGeneration !== catalogGeneration.current,
        });
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        window.vibe.quit();
        return true;
      }

      // Invalidate model/provider caches after key/refresh
      if (/^\/model\s+key\b/i.test(trimmed) || /^\/models?\s+refresh\b/i.test(trimmed)) {
        catalogCache.current.delete("models");
        catalogCache.current.delete("providers");
        dismissCatalog();
      }

      const commands = lineToCommands(trimmed);
      if (!commands.every(commandFitsInboundLimit)) return false;
      // Only optimistically mark busy for commands that start real engine work.
      // Pure run-slash (theme/help/model) often never emits engine-idle.
      const expectBusy = commandsExpectBusy(commands);
      if (expectBusy) session.setBusy(true);
      const sent = await session.sendMany(commands);
      if (!sent && expectBusy) session.setBusy(false);
      return sent;
    },
    [session, cwd, cloudTransitioning, cloudSessions, answerPerm, answerPlan, commandFitsInboundLimit, openModelsPicker, presentCatalog, openSettings, openGit, openWorkspaceDock, dismissCatalog],
  );

  // Live draft catalogs — open/update pickers while typing (TUI parity).
  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const cancelledFn = () => cancelled;
      const pick = modelPicker(draft, modelTarget);
      if (pick) {
        await presentCatalog<ModelSummary>({
          cacheKey: "models",
          fetch: async () => {
            const res = await window.vibe.rpc("listModels");
            return res.ok ? { ok: true, value: res.value as ModelSummary[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "models", items: [], target: pick.target, query: pick.query },
          readyPicker: (items) => {
            const chrome = chromeRef.current;
            return {
              kind: "models",
              items,
              target: pick.target,
              query: pick.query,
              current: currentModelForTarget(
                pick.target,
                chrome.model,
                chrome.subagentModel,
                catalogCache.current.get<AgentInfo>("agents") ?? [],
              ),
            };
          },
          cancelled: cancelledFn,
        });
        return;
      }

      const provQ = providersPickerQuery(draft);
      if (provQ !== null) {
        await presentCatalog<ProviderInfo>({
          cacheKey: "providers",
          fetch: async () => {
            const res = await window.vibe.rpc("listProviders");
            return res.ok ? { ok: true, value: res.value as ProviderInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "providers", items: [], query: provQ },
          readyPicker: (items) => ({ kind: "providers", items, query: provQ }),
          cancelled: cancelledFn,
        });
        return;
      }

      const agentsQ = agentsPickerQuery(draft);
      if (agentsQ !== null) {
        await presentCatalog<AgentInfo>({
          cacheKey: "agents",
          fetch: async () => {
            const res = await window.vibe.rpc("listAgents");
            return res.ok ? { ok: true, value: res.value as AgentInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "agents", items: [], query: agentsQ },
          readyPicker: (items) => ({ kind: "agents", items, query: agentsQ }),
          cancelled: cancelledFn,
        });
        return;
      }

      const skillsQ = skillsPickerFilter(draft);
      if (skillsQ !== null) {
        await presentCatalog<SkillInfo>({
          cacheKey: "skills",
          fetch: async () => {
            const res = await window.vibe.rpc("listSkills");
            return res.ok ? { ok: true, value: res.value as SkillInfo[] } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "skills", items: [], query: skillsQ },
          readyPicker: (items) => ({ kind: "skills", items, query: skillsQ }),
          cancelled: cancelledFn,
        });
        return;
      }

      const mcpQ = mcpPickerQuery(draft);
      if (mcpQ !== null) {
        await presentCatalog<McpServerInfo>({
          cacheKey: "mcp",
          fetch: async () => {
            const res = await window.vibe.rpc("listMcp");
            return res.ok ? { ok: true, value: asMcpList(res.value) } : { ok: false, error: res.error };
          },
          loadingPicker: { kind: "mcp", items: [], query: mcpQ },
          readyPicker: (items) => ({ kind: "mcp", items, query: mcpQ }),
          cancelled: cancelledFn,
        });
        return;
      }

      // Typed away from a catalog draft — close. Empty draft leaves submit-opened pickers alone.
      if (draft.trim()) dismissCatalog();
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [draft, modelTarget, session.chrome.model, session.chrome.subagentModel, presentCatalog, dismissCatalog]);

  const onCatalogChoose = useCallback(
    (choice: CatalogChoice) => {
      if (choice.kind === "setup-provider") {
        dismissCatalog();
        setDraft("");
        setShowOnboarding(false);
        setOnboardingError(null);
        setProviderSetupRequest(choice.providerId ? { providerId: choice.providerId } : {});
        return;
      }
      if (choice.kind === "command") {
        const cmd = choice.command;
        void (async () => {
          const sent = await session.send(cmd);
          if (!sent) return;
          dismissCatalog();
          setDraft("");
          setModelTarget("main");
          if (cmd.type === "set-subagent-model") {
            // No dedicated event exists for this setting; update only after the
            // host accepted the command, never before transport succeeds.
            session.setSubagentModel(cmd.model ?? undefined);
          }
          if (cmd.type === "set-agent-model") {
            // Persistence/reload is asynchronous engine-side. Invalidate rather
            // than claiming a value the engine may reject or fail to persist.
            catalogCache.current.delete("agents");
          }
        })();
        return;
      }
      if (choice.kind === "prefill") {
        dismissCatalog();
        setDraft(choice.draft);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
        });
        return;
      }
      dismissCatalog();
      void submitLine(choice.line);
    },
    [session, submitLine, dismissCatalog],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const emptyDraft = !draft.trim();
      const target = e.target as HTMLElement | null;
      const inInput = Boolean(
        target
        && (
          target.tagName === "TEXTAREA"
          || target.tagName === "INPUT"
          || target.tagName === "SELECT"
          || target.isContentEditable
        )
      );
      const inComposer = target?.classList.contains("composer-input") ?? false;
      const chatShortcutAvailable = !settingsOpen && !sessionsOpen && (!inInput || inComposer);

      // Ctrl/Cmd+T thinking
      if (chatShortcutAvailable && e.key === "t" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        session.dispatchTranscript({ type: "toggle-thinking-all", density: session.chrome.density });
        return;
      }
      // Ctrl/Cmd+D density
      if (chatShortcutAvailable && e.key === "d" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const next = nextDensity(session.chrome.density);
        void (async () => {
          const sent = await session.send({ type: "run-slash", name: "details", args: next });
          if (sent) session.showToast(`Density · ${densityLabel(next)}`);
        })();
        return;
      }
      // Ctrl/Cmd+O fold all turns
      if (chatShortcutAvailable && e.key === "o" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        session.foldAllTurns();
        return;
      }
      // Ctrl/Cmd+G external editor (TUI parity: composeInEditor)
      if (chatShortcutAvailable && e.key.toLowerCase() === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        void composeInEditor();
        return;
      }
      // ⇧⌘N continue latest
      if (chatShortcutAvailable && e.key === "n" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void continueLatest();
        return;
      }
      // ⌘K / Ctrl+K open slash by prefilling /
      if (chatShortcutAvailable && e.key === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        setDraft("/");
        return;
      }
      // Ctrl+P project grant
      if (chatShortcutAvailable && e.key === "p" && (e.ctrlKey || e.metaKey) && emptyDraft && session.chrome.perms[0]) {
        e.preventDefault();
        void answerPerm("always-project");
        return;
      }
      // Ctrl+Y accept plan + yolo
      if (chatShortcutAvailable && e.key === "y" && (e.ctrlKey || e.metaKey) && emptyDraft && session.chrome.plan && !session.chrome.perms.length) {
        e.preventDefault();
        void answerPlan("accept", undefined, "auto");
        return;
      }
      // Inspector toggle
      if (e.key.toLowerCase() === "i" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        toggleInspector();
        return;
      }

      // Permission y/a/n when empty draft (even in composer). Deny reason field is
      // free-text: N there types "n"; Enter confirms. Second N confirms when focus
      // stays on the Deny button (PermissionCard keeps focus there after open).
      const inPermDenyReason =
        target?.closest?.(".perm-deny-reason") != null
        || target?.getAttribute?.("aria-label") === "Optional reason for denying";
      if (
        emptyDraft &&
        session.chrome.perms[0] &&
        (!inInput || inComposer) &&
        !inPermDenyReason &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (e.key === "y" || e.key === "Y") {
          e.preventDefault();
          void answerPerm("once");
          return;
        }
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          void answerPerm("always");
          return;
        }
        if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          // Two-step deny: first N opens reason UI; second N (focus on Deny button)
          // confirms via PermissionCard denyKick / button keydown.
          setPermDenyKick((n) => n + 1);
          return;
        }
      }

      // Plan Enter accept when empty draft + not shift
      if (
        e.key === "Enter" &&
        emptyDraft &&
        session.chrome.plan &&
        !session.chrome.perms.length &&
        !e.shiftKey &&
        inComposer
      ) {
        e.preventDefault();
        void answerPlan("accept");
        return;
      }

      if (e.key === "Escape") {
        // Text-entry controls own Escape (Git drafts, file filters, settings,
        // deny reasons). Closing a surrounding surface while editing loses
        // context and can discard a local draft before its field handler runs.
        if (inInput && !inComposer) return;
        e.preventDefault();
        if (keysOpen) {
          setKeysOpen(false);
          return;
        }
        if (picker) {
          dismissCatalog();
          return;
        }
        if (endPanelOpen) {
          closeActiveEndPanel();
          return;
        }
        if (sessionsOpen) {
          setSessionsOpen(false);
          return;
        }
        if (projectRailOpen && belowBreakpoint("tablet")) {
          setProjectRailOpen(false);
          return;
        }
        if (draft.trim() && inComposer) {
          // Clear draft first (TUI: Esc clears half-typed revision / draft)
          if (session.chrome.plan) {
            setDraft("");
            return;
          }
          setDraft("");
          return;
        }
        if (session.chrome.perms[0]) {
          void answerPerm("deny");
          return;
        }
        if (session.chrome.plan) {
          void answerPlan("keep-planning");
          return;
        }
        if (session.chrome.busy) {
          void session.send({ type: "abort" });
          return;
        }
      }

      // CLI Ctrl+C: clear a draft first, then gracefully quit. Do not capture
      // macOS Cmd+C — it must remain native copy for selected transcript/input.
      // Also don't fire when focus is in a text input that isn't the composer
      // (rename fields, search filters, deny-reason) — Ctrl+C there should
      // remain native copy, not quit the app.
      if (
        e.key === "c" && e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (!inInput || inComposer)
      ) {
        e.preventDefault();
        if (draft.trim()) {
          setDraft("");
          return;
        }
        window.vibe.quit();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, draft, continueLatest, answerPerm, answerPlan, composeInEditor, picker, keysOpen, cwd, projectRailOpen, toggleInspector, endPanelOpen, closeActiveEndPanel, dismissCatalog, settingsOpen, sessionsOpen]);

  const chrome = session.chrome;
  const ctxPct = contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow);
  const hotCtx = ctxPct != null && ctxPct >= 80;

  // Usage as a composer chip. Changed files get their own review pill above
  // the input so the action is visible without competing with model metrics.
  const composerMetrics = useMemo((): ComposerMetric[] => {
    const chips: ComposerMetric[] = [];
    const usage = formatUsage(chrome.usage);
    if (usage) chips.push({ key: "usage", label: usage, title: usage });
    return chips;
  }, [chrome.usage]);

  const activeProject = projects.find((project) => project.cwd === cwd);
  const activeTask = chrome.tasks.find((t) => t.status === "in_progress");
  const taskDone = chrome.tasksCompletedTotal;
  const runningSubagents = chrome.subagents.filter((s) => s.status === "running").length;
  const doneSubagents = chrome.subagents.filter((s) => s.status === "done").length;
  const activeSessionTitle =
    activeProject?.sessions.find((item) => item.id === chrome.sessionId)?.title ??
    (chrome.goal || "New session");
  const currentCloudSession = cloudSessions.find((item) => item.sessionId === chrome.sessionId && isCloudSessionRemoteOwned(item.status)) ?? null;
  const executionLabel = currentCloudSession
    ? cloudProgress?.status === "needs-local" || currentCloudSession.status === "needs-local"
      ? "Needs your Mac"
      : cloudProgress && cloudProgress.status !== "running"
        ? cloudProgress.status === "suspended" ? "Cloud paused" : "Cloud"
        : "Cloud"
    : "Local";
  const topbarMetaChips = [
    { key: "execution", label: executionLabel, tone: executionLabel === "Needs your Mac" ? "warn" as const : "neutral" as const },
    chrome.queuePendingTotal
      ? { key: "queue", label: `queued ${chrome.queuePendingTotal}`, tone: "neutral" as const }
      : null,
    hotCtx && ctxPct != null
      ? { key: "ctx", label: `ctx ${ctxPct}%`, tone: "warn" as const }
      : null,
  ].filter((chip): chip is { key: string; label: string; tone: "neutral" | "warn" } => chip != null);
  const topbarMetaTitle = [
    ...topbarMetaChips.map((chip) => chip.label),
    ...composerMetrics.map((metric) => metric.label),
  ].join(" · ");
  const questionPending = !!chrome.question && !chrome.perms.length;
  const planPending = !!chrome.plan && !chrome.perms.length && !questionPending;
  const sessionNeedsInput = chrome.perms.length > 0
    || questionPending
    || planPending
    || (pendingLocalCapability !== null && pendingLocalCapabilitySessionId === chrome.sessionId);
  const sessionNeedsReview = !chrome.busy && (chrome.lastGate === "red" || failedSessionId === chrome.sessionId);
  const sessionAttention = chrome.perms[0]
    ? `Approve ${chrome.perms[0].toolName}`
    : questionPending
      ? chrome.question?.question ?? "Answer the agent’s question"
      : planPending
        ? "Review the proposed plan"
        : pendingLocalCapability !== null && pendingLocalCapabilitySessionId === chrome.sessionId
          ? `Continue ${pendingLocalCapability.integration} on this Mac`
          : null;
  const liveSessionInsight = buildLiveSessionInsight({
    chrome,
    transcript: session.transcript,
    needsInput: sessionNeedsInput,
    needsReview: sessionNeedsReview,
    attention: sessionAttention,
  });
  const persistSessionStatus = useCallback((statusCwd: string, sessionId: string, status: SessionBoardStatus) => {
    try {
      const preferences = readSessionBoardPreferences(window.localStorage);
      writeSessionBoardPreferences(window.localStorage, {
        ...preferences,
        statuses: { ...preferences.statuses, [sessionBoardKey(statusCwd, sessionId)]: status },
      });
      setSessionStatusRevision((revision) => revision + 1);
    } catch {
      /* Session organization remains usable in-memory when storage is unavailable. */
    }
  }, []);
  useEffect(() => window.vibe.onLocalRuntimeStatus((status) => {
    const previous = localRuntimeStateRef.current.get(status.key);
    if (status.state === "stopped") localRuntimeStateRef.current.delete(status.key);
    else localRuntimeStateRef.current.set(status.key, status.state);
    setLocalRuntimeStatuses((current) => {
      const next = new Map(current);
      if (status.state === "stopped") next.delete(status.key);
      else next.set(status.key, status);
      return next;
    });
    if (
      !status.foreground
      && status.state === "idle"
      && previous !== undefined
      && previous !== "idle"
      && previous !== "failed"
    ) {
      persistSessionStatus(status.cwd, status.sessionId, "done");
      void refreshProjects();
    }
  }), [persistSessionStatus, refreshProjects]);
  useEffect(() => {
    let current = true;
    let observedPush = false;
    const off = window.vibe.onLocalRuntimeLaunchQueue((snapshot) => {
      observedPush = true;
      if (current) setLocalRuntimeQueue(snapshot);
    });
    void window.vibe.localRuntimeLaunchQueue().then((result) => {
      if (current && !observedPush && result.ok) setLocalRuntimeQueue(result.value);
    }).catch(() => undefined);
    return () => { current = false; off(); };
  }, []);
  useEffect(() => {
    if (!chrome.sessionId) return;
    if (sessionNeedsInput) {
      busySessionRef.current = chrome.sessionId;
      if (cwd) persistSessionStatus(cwd, chrome.sessionId, "review");
      return;
    }
    if (chrome.busy) {
      busySessionRef.current = chrome.sessionId;
      return;
    }
    if (
      busySessionRef.current === chrome.sessionId
      && session.ready
    ) {
      if (!cwd) return;
      persistSessionStatus(cwd, chrome.sessionId, sessionNeedsReview ? "review" : "done");
      busySessionRef.current = null;
    }
  }, [chrome.busy, chrome.sessionId, cwd, persistSessionStatus, session.ready, sessionNeedsInput, sessionNeedsReview]);
  useEffect(() => {
    const wasBusy = projectRefreshBusyRef.current;
    projectRefreshBusyRef.current = chrome.busy;
    if (wasBusy && !chrome.busy && session.ready) void refreshProjects();
  }, [chrome.busy, refreshProjects, session.ready]);
  const showGateBanner = chrome.lastGate === "red" && !chrome.busy;
  const contextSummary = formatChromeSummary({
    git: formatGitLine(chrome.git),
    goal: formatGoalLine(chrome.goal, chrome.goalRun, { style: "context" }),
  });

  const activeSessionIndexed = projects.some((project) =>
    project.sessions.some((item) => item.id === chrome.sessionId),
  );

  useEffect(() => {
    if (session.ready && !chrome.busy && (!projects.length || !activeSessionIndexed)) {
      void refreshProjects();
    }
  }, [session.ready, chrome.busy, projects.length, activeSessionIndexed, refreshProjects]);

  if (!cwd) {
    return (
      <WelcomeGate
        booting={!initialProjectRestoreSettled || session.booting}
        restoring={!initialProjectRestoreSettled}
        bootError={initialProjectRestoreSettled ? (session.bootError ?? projectOpenError) : null}
        pendingCwd={null}
        recentProjects={projects}
        projectsLoading={projectsLoading}
        projectsError={projectsError}
        onOpenProject={() => void openProject()}
        onOpenRecent={(path) => void openProjectAt(path)}
        onRetryProjects={() => void refreshProjects()}
      />
    );
  }

  return (
    <div className="app-shell">
      <nav className="skip-links" aria-label="Skip links">
        <a className="skip-link" href="#main-content">
          {sessionsOpen ? "Skip to sessions" : "Skip to conversation"}
        </a>
        {!sessionsOpen ? <a className="skip-link" href="#composer">Skip to composer</a> : null}
        {projectRailPresence.mounted ? (
          <a className="skip-link" href="#project-rail">Skip to projects</a>
        ) : null}
        {session.inspectorOpen ? (
          <a className="skip-link" href="#session-panel">Skip to session panel</a>
        ) : null}
      </nav>
      <div className={`workspace${(settingsOpen || projectRailPresence.mounted) ? " rail-open" : ""}${session.inspectorOpen ? " inspector-open" : ""}${settingsOpen ? " settings-mode" : ""}`}>
        {/* Keep Settings mounted (hidden) so form draft + Instructions dirty state
            survive section switches and chat remains in the tree for scroll restore. */}
        {cwd ? (
          <div
            className={`settings-layer${settingsOpen ? " is-open" : ""}`}
            hidden={!settingsOpen}
            aria-hidden={!settingsOpen}
          >
            <Suspense
              fallback={(
                <section className="settings-workspace" aria-label="Loading settings" />
              )}
            >
              <SettingsView
                active={settingsOpen}
                cwd={cwd}
                runtimeIdentity={`${cwd ?? ""}\0${chrome.sessionId}`}
                onClose={() => setSettingsOpen(false)}
                showToast={session.showToast}
                onCloudSessionRecovered={async (_sessionId, recoveredCwd) => {
                  setSettingsOpen(false);
                  setCwd(recoveredCwd);
                  await session.attachCurrent(recoveredCwd);
                  await Promise.all([refreshCloudSessions(), refreshProjects()]);
                }}
                onBindDirty={bindSettingsDirty}
              />
            </Suspense>
          </div>
        ) : null}
        <div className={`chat-workspace${settingsOpen ? " is-obscured" : ""}`} aria-hidden={settingsOpen || undefined}>
          <ProjectRail
          projects={projects}
          cloudSessions={cloudSessions}
          chatsCwd={chatsCwd}
          activeCwd={cwd}
          activeSessionId={chrome.sessionId}
          open={projectRailOpen}
          closing={projectRailPresence.closing}
          loading={projectsLoading}
          error={projectsError}
          busy={chrome.busy}
          navigationDisabled={session.booting || cloudTransitioning}
          onClose={() => setProjectRailOpen(false)}
          onOpenSettings={openSettings}
          settingsActive={settingsOpen}
          onOpenSessions={() => {
            if (belowBreakpoint("tablet")) setProjectRailOpen(false);
            if (sessionsOpen) setSessionsOpen(false);
            else openSessions();
          }}
          sessionsActive={sessionsOpen}
          onRetry={() => void refreshProjects()}
          onOpenProject={() => void openProject()}
          onNewChat={() => {
            if (belowBreakpoint("tablet")) setProjectRailOpen(false);
            void startNewChat();
          }}
          onNewProjectChat={(projectCwd) => {
            if (belowBreakpoint("tablet")) setProjectRailOpen(false);
            void startProjectChat(projectCwd);
          }}
          onResume={(projectCwd, id) => {
            if (belowBreakpoint("tablet")) setProjectRailOpen(false);
            void resumeSession(projectCwd, id);
          }}
          onRenameProject={renameProject}
          onArchiveProject={archiveProject}
          onDeleteProject={deleteProject}
          onRenameSession={renameSession}
          onDeleteSession={(projectCwd, id) => removeSession(projectCwd, id, "delete")}
          onArchiveSession={(projectCwd, id) => removeSession(projectCwd, id, "archive")}
          onForkSession={forkSession}
        />
        {projectRailPresence.mounted && (
          <button
            type="button"
            className={`drawer-scrim${projectRailPresence.closing ? " is-closing" : ""}`}
            data-drawer="start"
            aria-label="Close project rail"
            onClick={() => setProjectRailOpen(false)}
          />
        )}
        {!sessionsOpen && endPanelPresence.mounted && (
          <button
            type="button"
            className={`drawer-scrim${endPanelPresence.closing ? " is-closing" : ""}`}
            data-drawer="end"
            aria-label="Close activity sidebar"
            onClick={closeActiveEndPanel}
          />
        )}

        <div className={`content-inset${projectRailPresence.mounted ? "" : " is-expanded"}${
          !sessionsOpen && endPanelOpen ? " end-panel-open" : ""
        }`}>
          {sessionsOpen ? (
            <Suspense fallback={<section className="sessions-workspace" aria-label="Loading sessions" />}>
              <SessionsWorkspace
                projects={projects}
                cloudSessions={cloudSessions}
                localRuntimes={[...localRuntimeStatuses.values()]}
                chatsCwd={chatsCwd}
                activeCwd={cwd}
                activeSessionId={chrome.sessionId}
                busy={chrome.busy || cloudTransitioning}
                interactionDisabled={chrome.busy || session.booting || cloudTransitioning}
                navigationDisabled={session.booting || cloudTransitioning}
                needsInput={sessionNeedsInput}
                needsReview={sessionNeedsReview}
                liveInsight={liveSessionInsight}
                statusRevision={sessionStatusRevision}
                loading={projectsLoading}
                error={projectsError}
                onRetry={() => void refreshProjects()}
                onOpen={(projectCwd, id) => void resumeSession(projectCwd, id)}
                onNewChat={() => void startNewChat()}
                onFork={forkSession}
                onRename={renameSession}
                onArchive={(projectCwd, id) => removeSession(projectCwd, id, "archive")}
                onDelete={(projectCwd, id) => removeSession(projectCwd, id, "delete")}
                onClose={() => setSessionsOpen(false)}
              />
            </Suspense>
          ) : (
          <>
          <header className="topbar">
            <div className="topbar-leading">
              {!projectRailOpen && (
                <button
                  type="button"
                  className="icon-button no-drag"
                  onClick={() => setProjectRailOpen(true)}
                  aria-label="Show project rail"
                  aria-expanded={projectRailOpen}
                  aria-controls="project-rail"
                >
                  <IconSidebar size={15} />
                </button>
              )}
              {!projectRailOpen && (
                <BrandWordmark className="topbar-brand" />
              )}
              <h1 className="topbar-title" title={`${cwd}\n${activeSessionTitle}`}>
                <span className="topbar-project">
                  {activeProject
                    ? projectLabel(activeProject, projects)
                    : projectName(cwd)}
                </span>
                <span className="topbar-separator" aria-hidden>
                  /
                </span>
                <span className="topbar-session">{activeSessionTitle}</span>
              </h1>
              {topbarMetaChips.length > 0 && (
                <div className="topbar-meta no-drag" title={topbarMetaTitle || undefined}>
                  {topbarMetaChips.map((chip) => (
                    <span
                      key={chip.key}
                      className={`topbar-meta-chip${chip.tone === "warn" ? " is-warn" : ""}`}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </header>
        <div className="main-column" id="main-content">
            <main
              className={`chat-column${
                !session.booting &&
                !(session.bootError && !session.ready) &&
                session.transcript.blocks.length === 0 &&
                !chrome.busy
                  ? " is-empty"
                  : ""
              }`}
              aria-label="Conversation"
            >
            {(session.transcript.blocks.length > 0 || chrome.busy) && contextSummary && (
              <div className="context-line">
                {contextSummary}
              </div>
            )}

            {session.booting ? (
              <>
                {session.transcript.blocks.length > 0 ? (
                  <TranscriptView
                    sessionId={chrome.sessionId}
                    turns={session.turns}
                    busy={chrome.busy}
                    liveThinking={chrome.thinkingStream}
                    hiddenCount={session.hiddenCount}
                    revealPage={session.revealPage}
                    foldedTurns={session.foldedTurns}
                    density={chrome.density}
                    theme={chrome.theme}
                    itemWindowFor={session.itemWindowFor}
                    onSetBlockExpanded={(id, expanded) =>
                      session.dispatchTranscript({ type: "set-expanded", id, expanded })
                    }
                    onToggleTurn={(key) =>
                      session.setFoldedTurns((prev) => {
                        const n = new Set(prev);
                        if (n.has(key)) n.delete(key);
                        else n.add(key);
                        return n;
                      })
                    }
                    onEdit={(text) => {
                      setDraft(text);
                      window.requestAnimationFrame(() => {
                        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
                      });
                    }}
                    onShowEarlier={session.revealEarlier}
                    onRevealTurnItems={session.revealTurnItems}
                    followSignal={followSignal}
                    footerAccessory={
                      !chrome.busy && session.transcript.changedFiles.length > 0 ? (
                        <ChangedFilesPill
                          files={session.transcript.changedFiles}
                          onReview={() => openWorkspaceDock("changes")}
                        />
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="transcript">
                    <Splash />
                  </div>
                )}
                <SessionBoot cwd={cwd} />
              </>
            ) : session.bootError && !session.ready ? (
              <SessionBootError
                error={session.bootError}
                onRetry={() => void openProjectAt(cwd)}
                onNewSession={() => void newSession()}
                onOpenProject={() => void openProject()}
              />
            ) : session.transcript.blocks.length === 0 && !chrome.busy ? (
              <div className="transcript">
                <Splash />
              </div>
            ) : (
              <TranscriptView
                sessionId={chrome.sessionId}
                turns={session.turns}
                busy={chrome.busy}
                liveThinking={chrome.thinkingStream}
                hiddenCount={session.hiddenCount}
                revealPage={session.revealPage}
                foldedTurns={session.foldedTurns}
                density={chrome.density}
                theme={chrome.theme}
                itemWindowFor={session.itemWindowFor}
                onSetBlockExpanded={(id, expanded) =>
                  session.dispatchTranscript({ type: "set-expanded", id, expanded })
                }
                onToggleTurn={(key) =>
                  session.setFoldedTurns((prev) => {
                    const n = new Set(prev);
                    if (n.has(key)) n.delete(key);
                    else n.add(key);
                    return n;
                  })
                }
                onEdit={(text) => {
                  setDraft(text);
                  window.requestAnimationFrame(() => {
                    document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
                  });
                }}
                onShowEarlier={session.revealEarlier}
                onRevealTurnItems={session.revealTurnItems}
                followSignal={followSignal}
                footerAccessory={
                  !chrome.busy && session.transcript.changedFiles.length > 0 ? (
                    <ChangedFilesPill
                      files={session.transcript.changedFiles}
                      onReview={() => openWorkspaceDock("changes")}
                    />
                  ) : undefined
                }
              />
            )}

            <div className="panels" ref={panelsRef}>
              {(showOnboarding || providerSetupRequest) && !chrome.perms[0] && !planPending && !questionPending && (
                <Suspense fallback={null}>
                  <OnboardingModal
                    providers={onboardingProviders}
                    initialProviderId={providerSetupRequest?.providerId}
                    focusedSetup={Boolean(providerSetupRequest)}
                    onSave={saveOnboarding}
                    saving={onboardingSaving}
                    saveError={onboardingError}
                    onDismiss={() => {
                      if (providerSetupRequest) {
                        setProviderSetupRequest(null);
                      } else {
                        onboardingDismissed.current = true;
                      }
                      setShowOnboarding(false);
                    }}
                  />
                </Suspense>
              )}
              {showGateBanner && (
                <div className="notice error gate-banner" role="alert">
                  Verify gate failed — review the last turn before continuing
                </div>
              )}
              {pendingLocalCapability && (
                <div className="notice warning gate-banner cloud-capability-card" role="alert">
                  <div>
                    <strong>Needs your Mac · {pendingLocalCapability.integration}</strong>
                    <p>{pendingLocalCapability.toolName} is local-only. The experimental relay is disabled, so Vibe will not substitute a cloud tool.</p>
                    <code>{JSON.stringify(pendingLocalCapability.arguments)}</code>
                  </div>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void session.send({
                      type: "resolve-external-capability",
                      id: pendingLocalCapability.id,
                      decision: "deny",
                      error: "Local capability relay is not enabled in this experimental build",
                    })}
                  >Deny and continue</button>
                </div>
              )}
              {chrome.perms[0] && (
                <PermissionCard
                  perm={chrome.perms[0]}
                  count={chrome.perms.length}
                  denyKick={permDenyKick}
                  onDecide={(decision, feedback) => void answerPerm(decision, feedback)}
                />
              )}
              {questionPending && (
                <QuestionCard
                  question={chrome.question!}
                  onAnswer={(answers, freeform) => void answerQuestion(answers, freeform)}
                />
              )}
              {planPending && (
                <PlanCard
                  plan={chrome.plan!}
                  hasDraft={!!draft.trim()}
                  onAccept={() => void answerPlan("accept")}
                  onAcceptYolo={() => void answerPlan("accept", undefined, "auto")}
                  onKeep={() => void answerPlan("keep-planning")}
                />
              )}
              {!session.inspectorOpen &&
                (chrome.tasksUnfinishedTotal > 0 || chrome.subagents.length > 0) && (
                <div className="panel-strip-compact" role="group" aria-label="Live activity">
                  {chrome.tasksUnfinishedTotal > 0 && (
                    <button
                      type="button"
                      className="panel-strip-chip"
                      onClick={() => openSessionReview()}
                      title="Open session panel for full task list"
                    >
                      <StatusDot status={activeTask ? "active" : "pending"} />
                      <span>
                        Tasks · {taskDone}/{chrome.tasksTotal}
                        {activeTask ? ` · ${activeTask.title}` : ""}
                      </span>
                    </button>
                  )}
                  {chrome.subagents.length > 0 && (
                    <button
                      type="button"
                      className="panel-strip-chip"
                      onClick={() => openSessionReview(undefined, "session", "subagents")}
                      title="Review each subagent"
                      aria-label="Review subagent details"
                    >
                      <StatusDot status={runningSubagents > 0 ? "active" : "done"} />
                      <span>
                        {runningSubagents > 0
                          ? `Subagents · ${runningSubagents} running`
                          : doneSubagents > 0 && doneSubagents < chrome.subagents.length
                            ? `Subagents · ${doneSubagents}/${chrome.subagents.length} done`
                            : `Subagents · ${chrome.subagents.length}`}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {!(session.booting || (session.bootError && !session.ready)) && (
            <div className="composer-stack" id="composer" ref={composerStackRef}>
              <QueuePanel
                pending={chrome.queuePending}
                totalCount={chrome.queuePendingTotal}
                onSteer={(id) => void session.send({ type: "steer", id })}
                onDequeue={(id) => void session.send({ type: "dequeue", id })}
              />
              {pickerPresence.mounted && renderedPicker && (
                <CatalogModal
                  picker={renderedPicker}
                  closing={pickerPresence.closing}
                  anchorRef={composerStackRef}
                  autoFocusSearch={!draft.trim()}
                  draftLinked={!!draft.trim()}
                  onClose={() => {
                    dismissCatalog();
                    setModelTarget("main");
                  }}
                  onChoose={onCatalogChoose}
                  onRetry={retryCatalog}
                  onToggleModelTarget={
                    renderedPicker.kind === "models" && typeof renderedPicker.target === "string"
                      ? () => {
                          const next: "main" | "sub" = renderedPicker.target === "main" ? "sub" : "main";
                          setModelTarget(next);
                          setPicker({
                            ...renderedPicker,
                            target: next,
                            current: currentModelForTarget(
                              next,
                              chrome.model,
                              chrome.subagentModel,
                              catalogCache.current.get<AgentInfo>("agents") ?? [],
                            ),
                          });
                        }
                      : undefined
                  }
                />
              )}
              <Composer
                uiMode={session.uiMode}
                draft={draft}
                setDraft={setDraft}
                onSubmit={submitLine}
                catalogOpen={pickerMatchesDraft(picker, draft, modelTarget)}
                onCycleMode={session.cycleMode}
                onSelectMode={session.selectMode}
                pendingModeTransition={session.pendingModeTransition}
                onResolveModeTransition={(choice) => void resolveModeTransition(choice)}
                modeTransitionRunDisabledReason={planResolutionBlockedReason("accept", chrome.goalRun)}
                disabled={!session.ready || session.booting || cloudTransitioning}
                commandNames={chrome.commandNames}
                cwd={cwd}
                model={chrome.model}
                theme={chrome.theme}
                accent={chrome.accent}
                approvals={chrome.approvals}
                density={chrome.density}
                reasoning={chrome.reasoning}
                metrics={composerMetrics}
                ctxPct={ctxPct}
                busy={chrome.busy}
                onAbort={() => void session.send({ type: "abort" })}
                onCycleDensity={() => {
                  const next = nextDensity(chrome.density);
                  void (async () => {
                    const sent = await session.send({
                      type: "run-slash",
                      name: "details",
                      args: next,
                    });
                    if (sent) session.showToast(`Density · ${densityLabel(next)}`);
                  })();
                }}
                onPasteError={session.showToast}
                onOpenModel={() => void openModelsPicker("main")}
                onOpenInspector={() => openSessionReview()}
                onEditInEditor={() => void composeInEditor()}
                planPending={planPending}
                executionTarget={currentCloudSession ? "cloud" : "local"}
                executionStatus={executionLabel}
                onExecutionTargetChange={(target) => {
                  setCloudRequest({ target });
                  setCloudProgress(null);
                  setCloudSheetOpen(true);
                }}
                emptyHome={
                  session.transcript.blocks.length === 0 &&
                  !chrome.busy
                }
              />
            </div>
            )}

            <div className="sr-only" aria-live="polite">
              {chrome.busy ? "Vibe Codr is working" : "Vibe Codr is idle"}
              {hotCtx ? `, context is ${ctxPct} percent full` : ""}
            </div>
          </main>

          </div>

          {/* The launcher is anchored to the full workspace frame—not the
              below-topbar chat column—so it occupies the upper-right corner. */}
          {!endPanelOpen && (
            <WorkspaceDock
              changedFiles={session.transcript.changedFiles}
              cwd={cwd}
              project={activeProject ? projectLabel(activeProject, projects) : projectName(cwd)}
              branch={chrome.git?.branch ?? null}
              executionTarget={currentCloudSession ? "cloud" : "local"}
              sessionOpen={false}
              changesOpen={false}
              gitOpen={false}
              terminalOpen={false}
              jobsOpen={false}
              emptyHome={
                !session.booting &&
                !(session.bootError && !session.ready) &&
                session.transcript.blocks.length === 0 &&
                !chrome.busy
              }
              onOpen={openWorkspaceDock}
            />
          )}
          </>
          )}

          {!sessionsOpen && endPanelPresence.mounted && renderedEndPanel && (
            <ActivitySidebar
              active={renderedEndPanel}
              closing={endPanelPresence.closing}
              changedCount={session.transcript.changedFiles.length}
              jobCount={chrome.jobsTotal + chrome.activities.filter((activity) => activity.kind !== "shell").length + localRuntimeQueue.items.length}
              onSelect={selectActivityTool}
              onClose={closeActiveEndPanel}
            >
              {renderedEndPanel === "jobs" && (
                <section
                  className="activity-rail jobs-activity-rail"
                  aria-labelledby="jobs-panel-title"
                >
                  <JobsView
                    jobs={chrome.jobs}
                    activities={chrome.activities}
                    totalCount={chrome.jobsTotal}
                    launchQueue={localRuntimeQueue}
                    onClose={() => session.setJobsView(false)}
                    onCancelActivity={(id) => void session.send({ type: "cancel-activity", id })}
                    onCancelLaunch={(id) => void window.vibe.cancelLocalRuntimeLaunch(id)}
                  />
                </section>
              )}

              {renderedEndPanel === "changes" && (
                <Suspense
                  fallback={(
                    <section className="activity-rail changes-activity-rail" aria-label="Loading changes review" />
                  )}
                >
                  <ChangesView
                    key={`changes:${inspectorFocusPath ?? ""}`}
                    files={session.transcript.changedFiles}
                    cwd={cwd}
                    cloudOwned={currentCloudSession !== null}
                    focusPath={inspectorFocusPath}
                    onClose={() => {
                      setInspectorFocusPath(null);
                      session.setInspectorOpen(false);
                    }}
                    onRevealFile={(path) => {
                      if (!cwd) return;
                      if (currentCloudSession) {
                        session.showToast(CLOUD_FILE_REVEAL_NOTICE, "info");
                        return;
                      }
                      const resolvedPath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
                        ? path
                        : `${cwd}/${path}`;
                      revealPath(resolvedPath);
                    }}
                  />
                </Suspense>
              )}

              {renderedEndPanel === "session" && (
                <Inspector
                  key={`${inspectorTool}:${inspectorFocusPath ?? ""}`}
                  chrome={chrome}
                  changedFiles={session.transcript.changedFiles}
                  cwd={cwd}
                  focusPath={inspectorFocusPath}
                  focusSection={inspectorFocusSection}
                  onClose={() => {
                    setInspectorFocusPath(null);
                    setInspectorFocusSection(null);
                    session.setInspectorOpen(false);
                  }}
                  onUndo={() => void session.send({ type: "run-slash", name: "undo", args: "" })}
                  onRedo={() => void session.send({ type: "run-slash", name: "redo", args: "" })}
                  onRevealFile={(path) => {
                    if (!cwd) return;
                    if (currentCloudSession) {
                      session.showToast(CLOUD_FILE_REVEAL_NOTICE, "info");
                      return;
                    }
                    const resolvedPath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
                      ? path
                      : `${cwd}/${path}`;
                    revealPath(resolvedPath);
                  }}
                />
              )}

              {renderedEndPanel === "git" && cwd && (
                <Suspense
                  fallback={(
                    <section
                      className="activity-rail git-activity-rail"
                      aria-label="Loading Git view"
                    />
                  )}
                >
                  <GitView
                    key={`${cwd}:${currentCloudSession ? "cloud" : "local"}`}
                    cwd={cwd}
                    cloudOwned={currentCloudSession !== null}
                    onClose={() => setGitOpen(false)}
                    showToast={session.showToast}
                  />
                </Suspense>
              )}

              {renderedEndPanel === "terminal" && terminalCwd && (
                <Suspense
                  fallback={(
                    <section
                      className="activity-rail terminal-activity-rail"
                      aria-label="Loading terminal"
                    />
                  )}
                >
                  <TerminalPanel
                    key={`${terminalCwd}:${currentCloudSession ? "cloud" : "local"}`}
                    cwd={terminalCwd}
                    scope={terminalScope}
                    executionTarget={currentCloudSession ? "cloud" : "local"}
                    onClose={() => setTerminalOpen(false)}
                  />
                </Suspense>
              )}
            </ActivitySidebar>
          )}

          {!sessionsOpen && endPanelPresence.mounted && renderedEndPanel && (
            <SidebarResizeHandle
              side="end"
              cssVar={renderedEndPanel === "changes" ? "--changes-rail-w" : "--activity-rail-w"}
              defaultWidth={renderedEndPanel === "changes" ? 620 : 320}
              min={renderedEndPanel === "changes" ? 440 : 280}
              max={renderedEndPanel === "changes" ? 800 : 520}
              storageKey={renderedEndPanel === "changes" ? "vibe.changes-rail-width" : "vibe.activity-rail-width"}
              label={renderedEndPanel === "changes" ? "Resize changes sidebar" : "Resize activity sidebar"}
            />
          )}
        </div>
        </div>
      </div>

      {keysOpen && <KeysOverlay onClose={() => setKeysOpen(false)} />}

      {cloudSheetOpen && cwd && chrome.sessionId && (
        <Suspense fallback={<div className="modal-overlay cloud-handoff-backdrop" aria-label="Loading Cloud handoff" />}>
          <CloudHandoffSheet
            cwd={cwd}
            sessionId={chrome.sessionId}
            model={chrome.model}
            cloudSession={currentCloudSession}
            busy={chrome.busy}
            requestedTarget={cloudRequest?.target}
            requestedProvider={cloudRequest?.provider}
            initialInstruction={cloudRequest?.instruction}
            progress={cloudProgress?.sessionId === chrome.sessionId ? cloudProgress : null}
            onWorkingChange={setCloudTransitioning}
            onClose={() => { setCloudSheetOpen(false); setCloudRequest(null); }}
            onComplete={async ({ message, executionTarget, cwd: resumedCwd, cloudSession }) => {
              setCloudSheetOpen(false);
              setCloudRequest(null);
              setCloudProgress(null);
              setCloudSessions((current) => executionTarget === "cloud" && cloudSession
                ? [cloudSession, ...current.filter((item) => item.sessionId !== cloudSession.sessionId)]
                : current.filter((item) => item.sessionId !== chrome.sessionId));
              const activeCwd = resumedCwd ?? cwd;
              if (normalizeCwd(activeCwd) !== normalizeCwd(cwd)) setCwd(activeCwd);
              const attached = await session.attachCurrent(
                activeCwd,
                cloudSession?.appearance ?? currentCloudSession?.appearance,
              );
              session.showToast(
                attached ? message : "Handoff completed, but the session view needs to reconnect",
                attached ? "info" : "error",
              );
              await Promise.all([refreshCloudSessions(), refreshProjects()]);
            }}
          />
        </Suspense>
      )}

      {session.toast && (
        <div
          className={`toast toast-${session.toast.severity}${session.toast.closing ? " is-closing" : ""}`}
          role="status"
          aria-live={session.toast.severity === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          data-severity={session.toast.severity}
        >
          <button
            type="button"
            className="toast-dismiss"
            onClick={() => session.dismissToast()}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            {session.toast.message}
          </button>
        </div>
      )}
    </div>
  );
}
