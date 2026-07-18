// Project rail — a left slide-out sidebar (the native analog of the desktop
// ProjectRail). Liquid-glass panel that slides in from the leading edge with a
// scrim + Reanimated spring. Fetches the live project/session catalog over RPC
// (`listProjects`) and reuses the shared project-index helpers so grouping,
// filtering, and labels are identical. Selecting a session re-bootstraps the
// remote engine to that cwd + resume id.
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, Text, FlatList, Pressable, TextInput, Modal, KeyboardAvoidingView, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Spinner, IconBtn } from "./primitives";
import { Icon } from "./icons";
import {
  partitionProjects, filterProjects, filterChatSessions, chatSessions,
  projectLabel, relativeSessionTime, normalizeSessionTitle,
  limitProjectRailProjects, limitProjectRailSessions,
} from "@shared/project-index";
import type { ProjectSummary, ProjectSessionSummary } from "@shared/protocol";
import type { CloudSessionCatalogEntry } from "@shared/cloud";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { useAccessibilitySettings } from "../hooks/useAccessibilitySettings";

interface Props {
  open: boolean;
  onClose: () => void;
  client: RemoteEngineClient;
  activeCwd: string;
  activeSessionId: string;
  onSwitch: (cwd: string, resume?: string) => void;
  onNewChat: (cwd: string) => Promise<boolean>;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
}

export function ProjectRailSheet({ open, onClose, client, activeCwd, activeSessionId, onSwitch, onNewChat, onOpenSessions, onOpenSettings }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const { reduceMotion } = useAccessibilitySettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cloudSessions, setCloudSessions] = useState<CloudSessionCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionMode, setActionMode] = useState<"menu" | "rename" | "archive" | "delete">("menu");
  const [renameValue, setRenameValue] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const s = makeStyles(colors);
  const width = Math.min(dims.width * 0.84, 360);
  const translate = useSharedValue(open ? 0 : -width);

  useEffect(() => {
    translate.value = reduceMotion ? (open ? 0 : -width) : open ? withSpring(0, { damping: 26, stiffness: 280 }) : withTiming(-width, { duration: 200 });
  }, [open, reduceMotion, translate, width]);

  const refreshProjects = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [res, cloud] = await Promise.all([
        client.rpc("listProjects") as Promise<ProjectSummary[]>,
        client.cloud({ action: "listSessions" }).catch(() => null),
      ]);
      setProjects(Array.isArray(res) ? res : []);
      setCloudSessions(cloud?.ok && Array.isArray(cloud.value) ? cloud.value as CloudSessionCatalogEntry[] : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    void refreshProjects();
  }, [open, client]);

  const { chats, projects: realProjects } = useMemo(() => {
    const chatsRoot = projects.find((p) => p.cwd.endsWith(".vibe/chats"))?.cwd ?? "";
    return partitionProjects(projects, chatsRoot);
  }, [projects]);

  const filteredProjects = useMemo(() => limitProjectRailProjects(filterProjects(realProjects, query), activeCwd).items, [realProjects, query, activeCwd]);
  const filteredChats = useMemo(() => limitProjectRailSessions(filterChatSessions(chatSessions(chats), query), activeSessionId).items, [chats, query, activeSessionId]);
  const cloudSessionIds = useMemo(() => new Set(cloudSessions.map((entry) => entry.sessionId)), [cloudSessions]);

  const data = useMemo(() => {
    const rows: Row[] = [];
    if (filteredChats.length) {
      rows.push({ kind: "head", key: "chats-head", label: "Chats" });
      for (const c of filteredChats) rows.push({ kind: "chat", key: `c-${c.id}`, session: c });
    }
    rows.push({ kind: "head", key: "projects-head", label: "Projects" });
    for (const p of filteredProjects) {
      rows.push({ kind: "project", key: `p-${p.cwd}`, project: p });
      for (const ses of p.sessions) rows.push({ kind: "session", key: `s-${p.cwd}-${ses.id}`, project: p, session: ses });
    }
    return rows;
  }, [filteredChats, filteredProjects]);

  function pick(cwd: string, resume?: string) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onSwitch(cwd, resume);
  }

  function showActions(target: ActionTarget) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setActionTarget(target);
    setActionMode("menu");
    setRenameValue(target.label);
    setActionError(null);
  }

  function closeActions() {
    if (actionBusy) return;
    setActionTarget(null);
    setActionError(null);
  }

  async function runAction() {
    if (!actionTarget) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (actionMode === "rename") {
        const value = renameValue.trim();
        if (!value) throw new Error("Enter a name first.");
        await assertRpcOk(actionTarget.kind === "project"
          ? client.rpc("renameProject", { cwd: actionTarget.cwd, name: value })
          : client.rpc("renameSession", { cwd: actionTarget.cwd, id: actionTarget.id, title: value }));
      } else {
        if (actionTarget.kind === "project") {
          if (actionMode === "delete" && actionTarget.cwd === activeCwd) {
            throw new Error("Open another project before deleting this project.");
          }
          await assertRpcOk(client.rpc(actionMode === "delete" ? "deleteProject" : "archiveProject", { cwd: actionTarget.cwd }));
        } else {
          if (actionTarget.cwd === activeCwd && actionTarget.id === activeSessionId) {
            const moved = await onNewChat(actionTarget.cwd);
            if (!moved) throw new Error("Couldn’t open a fresh session first.");
          }
          await assertRpcOk(client.rpc(actionMode === "delete" ? "deleteSession" : "archiveSession", { cwd: actionTarget.cwd, id: actionTarget.id }));
        }
      }
      await refreshProjects();
      setActionTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } finally {
      setActionBusy(false);
    }
  }

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translate.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: reduceMotion ? (open ? 1 : 0) : open ? withTiming(1, { duration: 200 }) : withTiming(0, { duration: 200 }), pointerEvents: open ? "auto" : "none" as const }));

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[s.scrim, scrimStyle]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width }, panelStyle]}>
        <View style={{ flex: 1, backgroundColor: colors.bg, borderRightWidth: 1, borderRightColor: colors.borderSoft }}>
          <View style={{ flex: 1, paddingTop: insets.top + T.sSm }}>
            <View style={s.head}>
              <Txt variant="title">Projects</Txt>
              <IconBtn name="X" onPress={onClose} label="Close sidebar" size={18} />
            </View>
            <Pressable onPress={onOpenSessions} style={({ pressed }) => [s.sessionsRow, pressed && { opacity: 0.65 }]}>
              <Icon name="MessagesSquare" size={16} color={colors.textSecondary} />
              <Txt variant="ui" weight="600" style={{ flex: 1 }}>Sessions</Txt>
              <Txt variant="caption" color={colors.textSubtle}>{projects.reduce((total, project) => total + project.sessions.length, 0)}</Txt>
              <Icon name="ChevronRight" size={15} color={colors.textSubtle} />
            </Pressable>
            <View style={s.searchWrap}>
              <View style={s.searchBox}>
                <Icon name="Search" size={15} color={colors.textSubtle} />
                <TextInput style={s.search} placeholder="Filter…" placeholderTextColor={colors.textSubtle} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} />
              </View>
              <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); void onNewChat(chats?.cwd ?? activeCwd).then((ok) => { if (ok) onClose(); }); }} style={({ pressed }) => [s.newBtn, pressed && { opacity: 0.7 }]}>
                <Icon name="Plus" size={16} color={colors.bg} />
                <Text style={s.newText}>New</Text>
              </Pressable>
            </View>
            {loading ? <View style={s.center}><Spinner /></View> :
             error ? <View style={s.center}><Txt variant="ui" color={colors.del}>{error}</Txt></View> :
              <FlatList
                data={data}
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: insets.bottom + T.sMd }}
                ListFooterComponent={<Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); onOpenSettings(); }} style={({ pressed }) => [s.footerRow, pressed && { opacity: 0.7 }]}><Icon name="Settings" size={16} color={colors.textSecondary} /><Txt variant="ui" color={colors.textSecondary}>Settings</Txt></Pressable>}
                keyExtractor={(r) => r.key}
                renderItem={({ item }) => {
                  if (item.kind === "head") return <Txt variant="label" color={colors.textSubtle} style={s.head2}>{item.label}</Txt>;
                  if (item.kind === "chat") {
                    const c = item.session!;
                    const active = c.id === activeSessionId;
                    return (
                      <Pressable onPress={() => pick(chats?.cwd ?? activeCwd, c.id)} style={({ pressed }) => [s.row, active && s.rowActive, pressed && { opacity: 0.7 }]}>
                        <Icon name="MessageSquare" size={15} color={active ? colors.accent : colors.textSubtle} />
                        <View style={{ flex: 1 }}>
                          <Txt variant="ui" numberOfLines={1} color={active ? colors.accent : colors.assistant}>{normalizeSessionTitle(c.title)}</Txt>
                          <Txt variant="caption" color={colors.textSubtle} numberOfLines={1}>{c.model} · {relativeSessionTime(c.updatedAt)}</Txt>
                        </View>
                        {cloudSessionIds.has(c.id) ? <Icon name="Cloud" size={13} color={colors.tool} /> : null}
                        <IconBtn name="MoreVertical" onPress={() => showActions({ kind: "session", cwd: chats?.cwd ?? activeCwd, id: c.id, label: normalizeSessionTitle(c.title) })} label={`Actions for ${normalizeSessionTitle(c.title)}`} size={16} />
                      </Pressable>
                    );
                  }
                  if (item.kind === "project") {
                    const p = item.project!;
                    const active = p.cwd === activeCwd;
                    return (
                      <Pressable onPress={() => pick(p.cwd)} style={({ pressed }) => [s.projectRow, active && s.rowActive, pressed && { opacity: 0.7 }]}>
                        <Icon name={active ? "FolderOpen" : "Folder"} size={15} color={active ? colors.accent : colors.tool} />
                        <Txt variant="ui" style={{ flex: 1 }} numberOfLines={1} color={active ? colors.accent : colors.assistant}>{projectLabel(p, realProjects)}</Txt>
                        <Txt variant="caption" color={colors.textSubtle}>{relativeSessionTime(p.updatedAt)}</Txt>
                        <IconBtn name="MoreVertical" onPress={() => showActions({ kind: "project", cwd: p.cwd, label: projectLabel(p, realProjects) })} label={`Actions for ${projectLabel(p, realProjects)}`} size={16} />
                      </Pressable>
                    );
                  }
                  const p = item.project!; const ses = item.session!;
                  const active = ses.id === activeSessionId;
                  return (
                    <Pressable onPress={() => pick(p.cwd, ses.id)} style={({ pressed }) => [s.subRow, active && s.rowActive, pressed && { opacity: 0.7 }]}>
                      <Txt variant="caption" color={colors.textSecondary} style={{ flex: 1 }} numberOfLines={1}>{normalizeSessionTitle(ses.title)}</Txt>
                      {cloudSessionIds.has(ses.id) ? <Icon name="Cloud" size={13} color={colors.tool} /> : null}
                      <Txt variant="caption" color={colors.textSubtle}>{relativeSessionTime(ses.updatedAt)}</Txt>
                      <IconBtn name="MoreVertical" onPress={() => showActions({ kind: "session", cwd: p.cwd, id: ses.id, label: normalizeSessionTitle(ses.title) })} label={`Actions for ${normalizeSessionTitle(ses.title)}`} size={16} />
                    </Pressable>
                  );
                }}
              />}
          </View>
        </View>
      </Animated.View>
      <Modal visible={!!actionTarget} transparent animationType="fade" onRequestClose={closeActions}>
        <KeyboardAvoidingView style={s.actionOverlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeActions} />
          <View style={s.actionCard}>
            <View style={s.actionHead}>
              <View style={{ flex: 1 }}>
                <Txt variant="label" color={colors.textSubtle}>{actionTarget?.kind === "project" ? "PROJECT" : "CHAT"}</Txt>
                <Txt variant="title" numberOfLines={1}>{actionTarget?.label}</Txt>
              </View>
              <IconBtn name="X" onPress={closeActions} label="Close actions" size={17} />
            </View>
            {actionMode === "menu" ? (
              <View style={s.actionList}>
                <ActionRow icon="Pencil" label="Rename" onPress={() => setActionMode("rename")} />
                <ActionRow icon="Archive" label="Archive" onPress={() => setActionMode("archive")} />
                <ActionRow icon="Trash2" label="Delete" danger onPress={() => setActionMode("delete")} />
              </View>
            ) : actionMode === "rename" ? (
              <View style={s.actionBody}>
                <Txt variant="ui" color={colors.textSecondary}>Choose a clear name you’ll recognize on desktop and mobile.</Txt>
                <TextInput value={renameValue} onChangeText={setRenameValue} autoFocus selectTextOnFocus style={s.renameInput} placeholder="Name" placeholderTextColor={colors.textSubtle} onSubmitEditing={() => void runAction()} />
                {actionError ? <Txt variant="caption" color={colors.del}>{actionError}</Txt> : null}
                <View style={s.actionButtons}>
                  <ActionButton label="Back" onPress={() => { setActionMode("menu"); setActionError(null); }} />
                  <ActionButton label={actionBusy ? "Saving…" : "Save"} primary disabled={actionBusy} onPress={() => void runAction()} />
                </View>
              </View>
            ) : (
              <View style={s.actionBody}>
                <Txt variant="ui" color={colors.textSecondary}>
                  {actionMode === "delete"
                    ? `Delete “${actionTarget?.label}” permanently? This can’t be undone.`
                    : `Archive “${actionTarget?.label}”? It will leave the active list.`}
                </Txt>
                {actionError ? <Txt variant="caption" color={colors.del}>{actionError}</Txt> : null}
                <View style={s.actionButtons}>
                  <ActionButton label="Cancel" onPress={() => { setActionMode("menu"); setActionError(null); }} />
                  <ActionButton label={actionBusy ? "Working…" : actionMode === "delete" ? "Delete" : "Archive"} danger={actionMode === "delete"} primary={actionMode === "archive"} disabled={actionBusy} onPress={() => void runAction()} />
                </View>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

async function assertRpcOk(request: Promise<unknown>) {
  const result = await request as { ok?: boolean; error?: string } | undefined;
  if (result?.ok === false) throw new Error(result.error || "The action failed.");
}

function ActionRow({ icon, label, onPress, danger }: { icon: "Pencil" | "Archive" | "Trash2"; label: string; onPress: () => void; danger?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: T.sSm, minHeight: 48, paddingHorizontal: T.sSm, borderRadius: T.radiusSm, opacity: pressed ? 0.6 : 1 }]}>
      <Icon name={icon} size={17} color={danger ? colors.del : colors.textSecondary} />
      <Txt variant="ui" color={danger ? colors.del : colors.assistant}>{label}</Txt>
    </Pressable>
  );
}

function ActionButton({ label, onPress, primary, danger, disabled }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ flex: 1, height: 42, alignItems: "center", justifyContent: "center", borderRadius: T.radius, borderWidth: 1, borderColor: danger ? colors.del : primary ? colors.accent : colors.borderSoft, backgroundColor: danger ? colors.del : primary ? colors.accent : colors.surfaceSubtle, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
      <Txt variant="ui" weight="600" color={danger || primary ? colors.bg : colors.assistant}>{label}</Txt>
    </Pressable>
  );
}

type ActionTarget =
  | { kind: "project"; cwd: string; label: string }
  | { kind: "session"; cwd: string; id: string; label: string };

type Row =
  | { kind: "head"; key: string; label: string }
  | { kind: "chat"; key: string; session: ProjectSessionSummary }
  | { kind: "project"; key: string; project: ProjectSummary }
  | { kind: "session"; key: string; project: ProjectSummary; session: ProjectSessionSummary };

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.45)" },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: T.sBase, paddingBottom: T.sXs },
    searchWrap: { flexDirection: "row", gap: T.sXs, paddingHorizontal: T.sBase, paddingBottom: T.sXs, alignItems: "center" },
    sessionsRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: T.sXs, marginHorizontal: T.sXs, marginBottom: T.sXs, paddingHorizontal: T.sXs, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle },
    searchBox: { flex: 1, flexDirection: "row", alignItems: "center", gap: T.sXs, backgroundColor: colors.surfaceSubtle, borderRadius: T.radius, paddingHorizontal: T.sSm, height: 36, borderWidth: 1, borderColor: colors.borderSoft },
    search: { flex: 1, color: colors.assistant, fontSize: T.textUi, paddingVertical: 0 },
    newBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.accent, borderRadius: T.radiusPill, paddingHorizontal: T.sSm, height: 36 },
    newText: { color: colors.bg, fontSize: T.textUi, fontWeight: "600" },
    center: { paddingVertical: T.s2xl, alignItems: "center" },
    head2: { paddingTop: T.sSm, paddingBottom: T.s2xs, paddingHorizontal: T.sBase, textTransform: "uppercase" },
    row: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.sXs, paddingHorizontal: T.sBase },
    rowActive: { backgroundColor: colors.navActiveBg },
    projectRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.sXs, paddingHorizontal: T.sBase },
    subRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.s2xs, paddingLeft: T.sBase + T.sMd, paddingRight: T.sBase },
    footerRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sBase, paddingVertical: T.sSm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, marginTop: T.sXs },
    actionOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.48)", padding: T.sBase },
    actionCard: { backgroundColor: colors.elevated, borderRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, overflow: "hidden", marginBottom: T.sSm },
    actionHead: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingLeft: T.sBase, paddingRight: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    actionList: { padding: T.s2xs },
    actionBody: { gap: T.sSm, padding: T.sBase },
    renameInput: { height: 44, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceSubtle, paddingHorizontal: T.sSm, color: colors.assistant, fontSize: T.textProse },
    actionButtons: { flexDirection: "row", gap: T.sXs, marginTop: T.s2xs },
  });
}
