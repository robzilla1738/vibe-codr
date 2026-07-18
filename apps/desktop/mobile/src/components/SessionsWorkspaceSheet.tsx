import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ProjectSummary } from "@shared/protocol";
import type { CloudSessionCatalogEntry } from "@shared/cloud";
import {
  automaticSessionBoardStatus,
  cloudAutomaticSessionState,
  DEFAULT_SESSION_BOARD_PREFERENCES,
  SESSION_BOARD_STORAGE_KEY,
  filterSessionBoard,
  flattenSessionBoard,
  readSessionBoardPreferences,
  sessionBoardKey,
  type SessionBoardItem,
  type SessionBoardPreferences,
  type SessionBoardSort,
  type SessionBoardStatus,
} from "@shared/session-board";
import { normalizeSessionTitle, relativeSessionTime } from "@shared/project-index";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Icon, type IconName } from "./icons";
import { IconBtn, Spinner, Txt } from "./primitives";
import { Sheet } from "./Sheet";

const STATUS_ORDER: SessionBoardStatus[] = ["active", "review", "done"];
const STATUS_META: Record<SessionBoardStatus, { label: string; hint: string; icon: IconName }> = {
  active: { label: "Active", hint: "Work in progress", icon: "MessagesSquare" },
  review: { label: "Review", hint: "Needs your attention", icon: "CircleDot" },
  done: { label: "Done", hint: "Finished sessions", icon: "CheckCircle2" },
};

export function SessionsWorkspaceSheet({ open, onClose, client, activeCwd, activeSessionId, busy, needsInput, onSwitch, onNewChat }: {
  open: boolean;
  onClose: () => void;
  client: RemoteEngineClient;
  activeCwd: string;
  activeSessionId: string;
  busy: boolean;
  needsInput: boolean;
  onSwitch: (cwd: string, id: string) => void;
  onNewChat: (cwd: string) => Promise<boolean>;
}) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cloudSessions, setCloudSessions] = useState<CloudSessionCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [preferences, setPreferences] = useState<SessionBoardPreferences>(DEFAULT_SESSION_BOARD_PREFERENCES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [action, setAction] = useState<{ item: SessionBoardItem; mode: "menu" | "rename" | "archive" | "delete" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [value, cloud] = await Promise.all([
        client.rpc("listProjects"),
        client.cloud({ action: "listSessions" }).catch(() => null),
      ]);
      setProjects(Array.isArray(value) ? value as ProjectSummary[] : []);
      setCloudSessions(cloud?.ok && Array.isArray(cloud.value) ? cloud.value as CloudSessionCatalogEntry[] : []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    void AsyncStorage.getItem(SESSION_BOARD_STORAGE_KEY).then((raw) => {
      if (raw) setPreferences(readSessionBoardPreferences({ getItem: () => raw }));
      setPreferencesReady(true);
    }).catch(() => setPreferencesReady(true));
  }, [open, refresh]);

  useEffect(() => {
    if (!preferencesReady) return;
    void AsyncStorage.setItem(SESSION_BOARD_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences, preferencesReady]);

  const chatsCwd = useMemo(() => projects.find((project) => project.cwd.endsWith(".vibe/chats"))?.cwd ?? null, [projects]);
  const items = useMemo(() => flattenSessionBoard(projects, chatsCwd, preferences.statuses), [projects, chatsCwd, preferences.statuses]);
  const cloudBySession = useMemo(() => new Map(cloudSessions.map((entry) => [entry.sessionId, entry])), [cloudSessions]);
  const automaticStatuses = useMemo(() => {
    const values = new Map<string, SessionBoardStatus>();
    for (const item of items) {
      const cloud = cloudBySession.get(item.session.id);
      const status = cloud ? automaticSessionBoardStatus(cloudAutomaticSessionState(cloud.status)) : null;
      if (status) values.set(item.key, status);
    }
    if (activeCwd && activeSessionId) values.set(sessionBoardKey(activeCwd, activeSessionId), needsInput ? "review" : busy ? "active" : preferences.statuses[sessionBoardKey(activeCwd, activeSessionId)] ?? "active");
    return values;
  }, [activeCwd, activeSessionId, busy, cloudBySession, items, needsInput, preferences.statuses]);
  const visible = useMemo(() => filterSessionBoard(items, {
    query,
    status: preferences.status,
    project: preferences.project,
    mode: preferences.mode,
    sort: preferences.sort,
    automaticStatuses,
  }), [items, query, preferences.status, preferences.project, preferences.mode, preferences.sort, automaticStatuses]);
  const effectiveStatus = useCallback((item: SessionBoardItem) => automaticStatuses.get(item.key) ?? item.status, [automaticStatuses]);
  const filterProjects = useMemo(() => [...new Map(items.map((item) => [item.cwd, item.project])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [items]);
  const activeFilterCount = Number(preferences.status !== "all") + Number(preferences.project !== "all") + Number(preferences.mode !== "all") + Number(preferences.sort !== "updated");

  function setStatus(item: SessionBoardItem, status: SessionBoardStatus) {
    setPreferences((current) => ({ ...current, statuses: { ...current.statuses, [item.key]: status } }));
  }

  function showActions(item: SessionBoardItem) {
    setAction({ item, mode: "menu" }); setRenameValue(item.session.title); setActionError(null);
  }

  async function runAction() {
    if (!action) return;
    setActionBusy(true); setActionError(null);
    try {
      if (action.mode === "rename") {
        const title = normalizeSessionTitle(renameValue);
        if (!title) throw new Error("Enter a session name first.");
        await assertRpcOk(client.rpc("renameSession", { cwd: action.item.cwd, id: action.item.session.id, title }));
      } else if (action.mode === "archive" || action.mode === "delete") {
        if (action.item.cwd === activeCwd && action.item.session.id === activeSessionId) {
          const moved = await onNewChat(action.item.cwd);
          if (!moved) throw new Error("Couldn’t open a fresh session first.");
        }
        await assertRpcOk(client.rpc(action.mode === "delete" ? "deleteSession" : "archiveSession", { cwd: action.item.cwd, id: action.item.session.id }));
        setPreferences((current) => {
          const statuses = { ...current.statuses }; delete statuses[action.item.key];
          return { ...current, statuses };
        });
      }
      await refresh(); setAction(null);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActionBusy(false); }
  }

  return <>
    <Sheet open={open} onClose={onClose} title="Sessions" icon="MessagesSquare" heightRatio={0.96}>
      <View style={s.toolbar}>
        <View style={s.search}><Icon name="Search" size={15} color={colors.textSubtle} /><TextInput value={query} onChangeText={setQuery} placeholder="Search sessions…" placeholderTextColor={colors.textSubtle} style={s.searchInput} /></View>
        <IconBtn name={preferences.view === "board" ? "Columns3" : "List"} onPress={() => setPreferences((current) => ({ ...current, view: current.view === "board" ? "list" : "board" }))} label="Switch session view" size={17} />
        <View><IconBtn name="SlidersHorizontal" onPress={() => setFiltersOpen((value) => !value)} label="Session filters" size={17} />{activeFilterCount ? <View style={s.filterCount}><Txt variant="micro" color={colors.bg}>{activeFilterCount}</Txt></View> : null}</View>
      </View>
      {filtersOpen ? <Filters preferences={preferences} projects={filterProjects} onChange={setPreferences} /> : null}
      {loading ? <View style={s.center}><Spinner /><Txt variant="caption" color={colors.textSubtle}>Loading sessions…</Txt></View> : error ? <View style={s.center}><Txt variant="ui" color={colors.del}>{error}</Txt><Pill label="Retry" onPress={() => void refresh()} /></View> : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.content}>
          {visible.length === 0 ? <View style={s.center}><Icon name="MessagesSquare" size={24} color={colors.textSubtle} /><Txt variant="ui" color={colors.textSecondary}>No sessions match these filters.</Txt></View> : preferences.view === "board" ? STATUS_ORDER.map((status) => {
            const group = visible.filter((item) => effectiveStatus(item) === status);
            return <View key={status} style={s.column}><View style={s.columnHead}><Icon name={STATUS_META[status].icon} size={15} color={statusColor(status, colors)} /><View style={{ flex: 1 }}><Txt variant="ui" weight="600">{STATUS_META[status].label}</Txt><Txt variant="caption" color={colors.textSubtle}>{STATUS_META[status].hint}</Txt></View><Txt variant="caption" color={colors.textSubtle}>{group.length}</Txt></View>{group.length ? group.map((item) => <SessionCard key={item.key} item={item} status={effectiveStatus(item)} cloud={cloudBySession.get(item.session.id)} active={item.cwd === activeCwd && item.session.id === activeSessionId} onOpen={() => { onSwitch(item.cwd, item.session.id); onClose(); }} onStatus={(statusValue) => setStatus(item, statusValue)} onActions={() => showActions(item)} />) : <Txt variant="caption" color={colors.textSubtle} style={{ padding: T.sSm }}>Nothing here</Txt>}</View>;
          }) : visible.map((item) => <SessionCard key={item.key} compact item={item} status={effectiveStatus(item)} cloud={cloudBySession.get(item.session.id)} active={item.cwd === activeCwd && item.session.id === activeSessionId} onOpen={() => { onSwitch(item.cwd, item.session.id); onClose(); }} onStatus={(statusValue) => setStatus(item, statusValue)} onActions={() => showActions(item)} />)}
        </ScrollView>
      )}
    </Sheet>
    <Modal visible={!!action} transparent animationType="fade" onRequestClose={() => { if (!actionBusy) setAction(null); }}>
      <KeyboardAvoidingView style={s.actionOverlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => { if (!actionBusy) setAction(null); }} />
        <View style={s.actionCard}>
          <View style={s.actionHead}><View style={{ flex: 1 }}><Txt variant="label" color={colors.textSubtle}>{action?.item.project.toUpperCase()}</Txt><Txt variant="title" numberOfLines={1}>{action?.item.session.title}</Txt></View><IconBtn name="X" onPress={() => setAction(null)} label="Close session actions" size={17} /></View>
          {action?.mode === "menu" ? <View style={{ padding: T.s2xs }}>
            <ActionRow icon="Pencil" label="Rename" onPress={() => setAction({ ...action, mode: "rename" })} />
            <View style={s.statusChoices}>{STATUS_ORDER.map((status) => <Pill key={status} label={STATUS_META[status].label} selected={effectiveStatus(action.item) === status} onPress={() => { setStatus(action.item, status); setAction(null); }} />)}</View>
            <ActionRow icon="Archive" label="Archive" onPress={() => setAction({ ...action, mode: "archive" })} />
            <ActionRow icon="Trash2" label="Delete" danger onPress={() => setAction({ ...action, mode: "delete" })} />
          </View> : action?.mode === "rename" ? <View style={s.actionBody}><Txt variant="ui" color={colors.textSecondary}>Rename this session everywhere.</Txt><TextInput value={renameValue} onChangeText={setRenameValue} autoFocus selectTextOnFocus style={s.renameInput} onSubmitEditing={() => void runAction()} />{actionError ? <Txt variant="caption" color={colors.del}>{actionError}</Txt> : null}<View style={s.actions}><Pill label="Back" onPress={() => setAction({ ...action, mode: "menu" })} /><Pill label={actionBusy ? "Saving…" : "Save"} primary disabled={actionBusy} onPress={() => void runAction()} /></View></View> : <View style={s.actionBody}><Txt variant="ui" color={colors.textSecondary}>{action?.mode === "delete" ? `Permanently delete “${action.item.session.title}”? This can’t be undone.` : `Archive “${action?.item.session.title}” from active history?`}</Txt>{actionError ? <Txt variant="caption" color={colors.del}>{actionError}</Txt> : null}<View style={s.actions}><Pill label="Cancel" onPress={() => setAction(action ? { ...action, mode: "menu" } : null)} /><Pill label={actionBusy ? "Working…" : action?.mode === "delete" ? "Delete" : "Archive"} danger={action?.mode === "delete"} primary={action?.mode === "archive"} disabled={actionBusy} onPress={() => void runAction()} /></View></View>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}

function Filters({ preferences, projects, onChange }: { preferences: SessionBoardPreferences; projects: [string, string][]; onChange: React.Dispatch<React.SetStateAction<SessionBoardPreferences>> }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const sorts: SessionBoardSort[] = ["updated", "oldest", "title", "project"];
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
    <Pill label="All" selected={preferences.status === "all"} onPress={() => onChange((current) => ({ ...current, status: "all" }))} />
    {STATUS_ORDER.map((status) => <Pill key={status} label={STATUS_META[status].label} selected={preferences.status === status} onPress={() => onChange((current) => ({ ...current, status }))} />)}
    <View style={s.filterDivider} />
    <Pill label="Any mode" selected={preferences.mode === "all"} onPress={() => onChange((current) => ({ ...current, mode: "all" }))} />
    <Pill label="Plan" selected={preferences.mode === "plan"} onPress={() => onChange((current) => ({ ...current, mode: "plan" }))} />
    <Pill label="Execute" selected={preferences.mode === "execute"} onPress={() => onChange((current) => ({ ...current, mode: "execute" }))} />
    <View style={s.filterDivider} />
    <Pill label={`Sort: ${preferences.sort}`} onPress={() => onChange((current) => ({ ...current, sort: sorts[(sorts.indexOf(current.sort) + 1) % sorts.length]! }))} />
    <Pill label={preferences.project === "all" ? "All projects" : projects.find(([cwd]) => cwd === preferences.project)?.[1] ?? "Project"} onPress={() => onChange((current) => { const values = ["all", ...projects.map(([cwd]) => cwd)]; return { ...current, project: values[(values.indexOf(current.project) + 1) % values.length]! }; })} />
  </ScrollView>;
}

function SessionCard({ item, status, cloud, active, compact, onOpen, onStatus, onActions }: { item: SessionBoardItem; status: SessionBoardStatus; cloud?: CloudSessionCatalogEntry; active: boolean; compact?: boolean; onOpen: () => void; onStatus: (status: SessionBoardStatus) => void; onActions: () => void }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const next = STATUS_ORDER[(STATUS_ORDER.indexOf(status) + 1) % STATUS_ORDER.length]!;
  return <View style={[s.sessionCard, compact && s.sessionCardCompact, active && s.sessionCardActive]}><Pressable onPress={onOpen} style={({ pressed }) => [s.sessionMain, pressed && { opacity: 0.65 }]}><View style={s.sessionProject}><Txt variant="caption" color={active ? colors.accent : colors.textSubtle} numberOfLines={1}>{item.project}</Txt><View style={s.sessionMeta}>{cloud ? <View style={s.cloudBadge}><Icon name="Cloud" size={11} color={colors.tool} /><Txt variant="micro" color={colors.tool}>{cloud.status}</Txt></View> : null}<Txt variant="caption" color={colors.textSubtle}>{relativeSessionTime(item.session.updatedAt)}</Txt></View></View><Txt variant="ui" weight="600" numberOfLines={2}>{normalizeSessionTitle(item.session.title)}</Txt>{!compact && item.session.goal ? <Txt variant="caption" color={colors.textSecondary} numberOfLines={2}>{item.session.goal}</Txt> : null}<Txt variant="caption" mono color={colors.textSubtle} numberOfLines={1}>{item.session.mode} · {item.session.model}</Txt></Pressable><View style={s.cardActions}><Pressable onPress={() => onStatus(next)} accessibilityLabel={`Status ${STATUS_META[status].label}; change to ${STATUS_META[next].label}`} style={s.statusButton}><Icon name={STATUS_META[status].icon} size={14} color={statusColor(status, colors)} /><Txt variant="caption" color={statusColor(status, colors)}>{STATUS_META[status].label}</Txt></Pressable><IconBtn name="MoreVertical" onPress={onActions} label={`Actions for ${item.session.title}`} size={16} /></View></View>;
}

function ActionRow({ icon, label, onPress, danger }: { icon: "Pencil" | "Archive" | "Trash2"; label: string; onPress: () => void; danger?: boolean }) { const { colors } = useTheme(); return <Pressable onPress={onPress} style={({ pressed }) => [{ minHeight: 46, flexDirection: "row", alignItems: "center", gap: T.sSm, paddingHorizontal: T.sSm, borderRadius: T.radiusSm, opacity: pressed ? 0.6 : 1 }]}><Icon name={icon} size={16} color={danger ? colors.del : colors.textSecondary} /><Txt variant="ui" color={danger ? colors.del : colors.assistant}>{label}</Txt></Pressable>; }
function Pill({ label, onPress, selected, primary, danger, disabled }: { label: string; onPress?: () => void; selected?: boolean; primary?: boolean; danger?: boolean; disabled?: boolean }) { const { colors } = useTheme(); return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ height: 34, paddingHorizontal: T.sSm, alignItems: "center", justifyContent: "center", borderRadius: T.radiusPill, borderWidth: 1, borderColor: danger ? colors.del : primary || selected ? colors.accent : colors.borderSoft, backgroundColor: danger ? colors.delBg : primary ? colors.accent : selected ? colors.navActiveBg : colors.surfaceSubtle, opacity: disabled ? 0.45 : pressed ? 0.65 : 1 }]}><Txt variant="caption" weight="600" color={danger ? colors.del : primary ? colors.bg : selected ? colors.accent : colors.textSecondary}>{label}</Txt></Pressable>; }
async function assertRpcOk(request: Promise<unknown>) { const result = await request as { ok?: boolean; error?: string } | undefined; if (result?.ok === false) throw new Error(result.error || "The action failed."); }
function statusColor(status: SessionBoardStatus, colors: ReturnType<typeof useTheme>["colors"]) { return status === "review" ? colors.notice : status === "done" ? colors.add : colors.accent; }

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) { return StyleSheet.create({
  toolbar: { flexDirection: "row", alignItems: "center", gap: T.s2xs, paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  search: { flex: 1, height: 38, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sSm, borderRadius: T.radius, backgroundColor: colors.surfaceSubtle, borderWidth: 1, borderColor: colors.borderSoft },
  searchInput: { flex: 1, color: colors.assistant, fontSize: T.textUi, paddingVertical: 0 },
  filterCount: { position: "absolute", top: 2, right: 1, minWidth: 15, height: 15, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: colors.accent },
  filters: { gap: T.s2xs, alignItems: "center", paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  filterDivider: { width: 1, height: 20, backgroundColor: colors.borderSoft, marginHorizontal: 2 },
  content: { padding: T.sBase, gap: T.sMd, paddingBottom: T.s2xl },
  center: { minHeight: 220, alignItems: "center", justifyContent: "center", gap: T.sXs, padding: T.sBase },
  column: { gap: T.sXs },
  columnHead: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.s2xs },
  sessionCard: { borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.elevated, overflow: "hidden" },
  sessionCardCompact: { flexDirection: "row", alignItems: "center" },
  sessionCardActive: { borderColor: colors.borderActive },
  sessionMain: { flex: 1, gap: T.s2xs, padding: T.sSm },
  sessionProject: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: T.sXs },
  sessionMeta: { flexDirection: "row", alignItems: "center", gap: T.sXs },
  cloudBadge: { flexDirection: "row", alignItems: "center", gap: 3 },
  cardActions: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: T.sSm, paddingRight: T.s2xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
  statusButton: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: T.s2xs },
  actionOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.48)", padding: T.sBase },
  actionCard: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusXl, overflow: "hidden", marginBottom: T.sSm },
  actionHead: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingLeft: T.sBase, paddingRight: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  actionBody: { gap: T.sSm, padding: T.sBase },
  renameInput: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: T.radius, backgroundColor: colors.surfaceSubtle, paddingHorizontal: T.sSm, color: colors.assistant, fontSize: T.textProse },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: T.sXs },
  statusChoices: { flexDirection: "row", gap: T.s2xs, paddingHorizontal: T.sSm, paddingVertical: T.sXs },
}); }
