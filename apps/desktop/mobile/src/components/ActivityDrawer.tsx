// Activity drawer — the mobile analog of the desktop workspace dock + activity
// sidebar. One mutually-exclusive right-side panel with Session / Changes / Git
// / Jobs views, fed by the shared chrome state + transcript changed-files. The
// main chat column is preserved (the drawer is an overlay sheet on phone).
import { useEffect, useState } from "react";
import { StyleSheet, View, Pressable, ScrollView, Text, useWindowDimensions } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { Icon, type IconName } from "./icons";
import { MetaBlock, MetaRow, Section, StatusDot, formatGitLine, formatGoalLine } from "./activity-shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card, Divider, Chip } from "./primitives";
import { modeWord } from "@shared/modes";
import { contextUsagePercent } from "@shared/context-usage";
import type { SessionChrome } from "@hooks/session-state";
import type { ChangedFile } from "@shared/reducer";
import { fileBasename, fileParentDir, changedFilesTotals } from "@shared/changed-files";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { GitWorkspace } from "./GitWorkspace";
import { useAccessibilitySettings } from "../hooks/useAccessibilitySettings";
import type { EngineCommand } from "@shared/commands";
import type { ActivityInfo } from "@shared/types";

export function activityRowsForDisplay(activities: readonly ActivityInfo[]): ActivityInfo[] {
  return activities.slice(-100);
}

export function cancelActivityCommand(
  activity: Pick<ActivityInfo, "id" | "status">,
): EngineCommand | null {
  return activity.status === "running" && activity.id.length > 0
    ? { type: "cancel-activity", id: activity.id }
    : null;
}

export type Tab = "session" | "changes" | "git" | "jobs";

export function ActivityDrawer({ open, onClose, chrome, changedFiles, onOpenReview, onOpenDiffReview, tab, onTabChange, client, onSend }: {
    open: boolean; onClose: () => void; chrome: SessionChrome; changedFiles: readonly ChangedFile[]; onOpenReview: () => void; onOpenDiffReview: () => void;
    tab: Tab; onTabChange: (t: Tab) => void; client: RemoteEngineClient; onSend: (command: EngineCommand) => Promise<boolean>;
  }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const { reduceMotion } = useAccessibilitySettings();
  const s = makeStyles(colors);
  const width = Math.min(dims.width - 56, 420);
  const translate = useSharedValue(open ? 0 : width);
  const TAB_ICONS: Record<Tab, IconName> = { session: "LayoutDashboard", changes: "FileText", git: "GitBranch", jobs: "SquareTerminal" };
  useEffect(() => { translate.value = reduceMotion ? (open ? 0 : width) : open ? withSpring(0, { damping: 26, stiffness: 280 }) : withTiming(width, { duration: 200 }); }, [open, reduceMotion, translate, width]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: translate.value }] }));
  const scrimA = useAnimatedStyle(() => ({ opacity: reduceMotion ? (open ? 1 : 0) : open ? withTiming(1, { duration: 200 }) : withTiming(0, { duration: 200 }) }));

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[s.scrim, scrimA]}><Pressable style={{ flex: 1 }} onPress={onClose} /></Animated.View>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, right: 0, width }, slide]}>
        <View style={{ flex: 1, backgroundColor: colors.bg, borderLeftWidth: 1, borderLeftColor: colors.borderSoft, paddingTop: insets.top, paddingBottom: insets.bottom }}>
          <View style={s.tabs}>
            {(["session", "changes", "git", "jobs"] as Tab[]).map((t) => (
              <Pressable key={t} accessibilityRole="tab" accessibilityState={{ selected: tab === t }} accessibilityLabel={`${t} workspace`} onPress={() => onTabChange(t)} style={[s.tab, tab === t && s.tabActive]}>
                <Icon name={TAB_ICONS[t]} size={16} color={tab === t ? colors.accent : colors.textSecondary} />
                <Txt variant="label" color={tab === t ? colors.accent : colors.textSecondary} style={{ textTransform: "capitalize" }}>{t}</Txt>
              </Pressable>
            ))}
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: T.sBase, gap: T.sSm }}>
            {tab === "session" ? <SessionView chrome={chrome} onOpenReview={onOpenReview} /> : null}
            {tab === "changes" ? <ChangesView files={changedFiles} onOpenReview={onOpenDiffReview} /> : null}
            {tab === "git" ? <GitWorkspace client={client} cwd={chrome.cwd} /> : null}
            {tab === "jobs" ? <JobsView chrome={chrome} onSend={onSend} /> : null}
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}

function SessionView({ chrome, onOpenReview }: { chrome: SessionChrome; onOpenReview: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const ctx = contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow);
  const git = formatGitLine(chrome.git);
  const goal = formatGoalLine(chrome.goal, chrome.goalRun);
  return (
    <View style={{ gap: T.sMd }}>
      <Pressable onPress={onOpenReview} style={({ pressed }) => [s.reviewBtn, pressed && { opacity: 0.55 }]}><Txt variant="ui" color={colors.textSecondary}>Open full review</Txt><Icon name="ChevronRight" size={15} color={colors.textSubtle} /></Pressable>
      <MetaBlock>
        <MetaRow label="Mode" value={modeWord(chrome.mode === "plan" ? "plan" : "execute")} />
        <MetaRow label="Approvals" value={chrome.approvals} />
        <MetaRow label="Model" value={chrome.model || "—"} mono />
        {chrome.subagentModel ? <MetaRow label="Subagent" value={chrome.subagentModel} mono /> : null}
        {goal ? <MetaRow label="Goal" value={goal} /> : null}
        <MetaRow label="Context" value={ctx != null ? `${ctx}% · ${chrome.ctxUsed.toLocaleString()}/${chrome.ctxWindow.toLocaleString()}` : "—"} />
        <MetaRow label="Tokens" value={chrome.usage.totalTokens.toLocaleString()} />
        <MetaRow label="Cost" value={`$${chrome.usage.costUSD.toFixed(4)}`} />
        {git ? <MetaRow label="Git" value={git} mono /> : null}
      </MetaBlock>
      <Section title="Tasks">
        {chrome.tasks.length === 0 ? <Txt variant="caption" color={colors.textSubtle}>No active tasks</Txt> :
          chrome.tasks.map((t) => (
            <View key={t.id} style={s.taskRow}>
              <StatusDot status={t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending"} />
              <Txt variant="ui" color={t.status === "completed" ? colors.textSubtle : colors.assistant} style={{ flex: 1, textDecorationLine: t.status === "completed" ? "line-through" : "none" }}>{t.title}</Txt>
            </View>
          ))}
      </Section>
    </View>
  );
}

function ChangesView({ files, onOpenReview }: { files: readonly ChangedFile[]; onOpenReview: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  if (files.length === 0) return <Txt variant="ui" color={colors.textSubtle}>No changed files this session</Txt>;
  const totals = changedFilesTotals(files);
  return (
    <View style={{ gap: T.sXs }}>
      <Pressable onPress={onOpenReview} style={({ pressed }) => [s.reviewBtn, pressed && { opacity: 0.55 }]}><Txt variant="ui" color={colors.textSecondary}>Full diff review</Txt><Icon name="ChevronRight" size={15} color={colors.textSubtle} /></Pressable>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: T.sXs }}>
        <Txt variant="caption" color={colors.textSubtle} style={{ fontWeight: "500" }}>{totals.count} changed</Txt>
        <Txt variant="caption" color={colors.add}>+{totals.added}</Txt>
        <Txt variant="caption" color={colors.del}>−{totals.removed}</Txt>
      </View>
      {files.map((f) => {
        const parent = fileParentDir(f.path);
        const base = fileBasename(f.path);
        return (
          <Pressable key={f.path} onPress={onOpenReview} style={({ pressed }) => [s.fileRow, pressed && { opacity: 0.7 }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row" }}>
                {parent ? <Text style={s.fileParent} numberOfLines={1}>{parent}/</Text> : null}
                <Text style={s.fileBase} numberOfLines={1}>{base}</Text>
              </View>
            </View>
            <Text style={[s.stat, { color: colors.add }]}>+{f.added}</Text>
            <Text style={[s.stat, { color: colors.del }]}>−{f.removed}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function JobStatusPill({ status }: { status: "running" | "exited" | "killed" }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const label = status === "running" ? "Running" : status === "killed" ? "Killed" : "Exited";
  const c = status === "running" ? colors.assistant : status === "killed" ? colors.del : colors.muted;
  return (
    <View style={[s.jobStatus, { borderColor: c, backgroundColor: status === "running" ? colors.navActiveBg : "transparent" }]}>
      <View style={[s.jobStatusDot, { backgroundColor: c }]} />
      <Text style={[s.jobStatusText, { color: c }]}>{label}</Text>
    </View>
  );
}
function ActivityStatusPill({ activity }: { activity: ActivityInfo }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const c = activity.status === "running" ? colors.assistant : activity.status === "failed" || activity.status === "cancelled" ? colors.del : colors.muted;
  return (
    <View style={[s.jobStatus, { borderColor: c, backgroundColor: activity.status === "running" ? colors.navActiveBg : "transparent" }]}>
      <View style={[s.jobStatusDot, { backgroundColor: c }]} />
      <Text style={[s.jobStatusText, { color: c }]}>{activity.kind} · {activity.status}</Text>
    </View>
  );
}

function JobsView({ chrome, onSend }: { chrome: SessionChrome; onSend: (command: EngineCommand) => Promise<boolean> }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const activities = activityRowsForDisplay(chrome.activities);
  if (chrome.jobs.length === 0 && activities.length === 0) return <Txt variant="ui" color={colors.textSubtle}>No background jobs or activities</Txt>;
  return (
    <View style={{ gap: T.sXs }}>
      {activities.map((activity) => {
        const cancel = cancelActivityCommand(activity);
        const metrics = [
          activity.metrics?.turns != null ? `${activity.metrics.turns} turns` : null,
          activity.metrics?.toolCalls != null ? `${activity.metrics.toolCalls} tools` : null,
          activity.metrics?.inputTokens != null ? `${activity.metrics.inputTokens.toLocaleString()} in` : null,
          activity.metrics?.outputTokens != null ? `${activity.metrics.outputTokens.toLocaleString()} out` : null,
        ].filter(Boolean).join(" · ");
        return (
          <View key={`activity:${activity.id}`} style={s.jobCard}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: T.sXs, flexWrap: "wrap" }}>
              <ActivityStatusPill activity={activity} />
              <Text style={s.jobCommand} numberOfLines={2}>{activity.label}</Text>
              {cancel ? <Pressable onPress={() => { void onSend(cancel); }} style={s.stopButton}><Txt variant="caption">Stop</Txt></Pressable> : null}
            </View>
            {metrics ? <Txt variant="caption" color={colors.textSecondary}>{metrics}</Txt> : null}
            {activity.outputTail || activity.summary ? <Text style={s.output}>{activity.outputTail || activity.summary}</Text> : null}
          </View>
        );
      })}
      {chrome.jobs.map((j) => (
        <View key={j.id} style={s.jobCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: T.sXs, flexWrap: "wrap" }}>
            <JobStatusPill status={j.status} />
            <Text style={s.jobCommand} numberOfLines={1}>{j.command}</Text>
          </View>
          {j.exitCode != null ? <Txt variant="caption" color={j.exitCode === 0 ? colors.add : colors.del}>exit {j.exitCode}</Txt> : null}
          {j.servers.length > 0 ? j.servers.map((u) => <Txt key={u} variant="caption" color={colors.user}>{u}</Txt>) : null}
          {j.outputTail ? <Text style={s.output} numberOfLines={6}>{j.outputTail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: T.sSm, alignItems: "center" }}>
      <Txt variant="label" color={colors.textSubtle} style={{ width: 88 }}>{label}</Txt>
      <Txt variant="ui" mono={mono} style={{ flex: 1 }} numberOfLines={2}>{value}</Txt>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
    scrimHit: { flex: 1 },
    panel: { backgroundColor: colors.bg, borderLeftWidth: 1, borderLeftColor: colors.borderSoft },
    tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    tab: { flex: 1, paddingVertical: T.sSm, alignItems: "center" },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
    taskRow: { flexDirection: "row", gap: T.sXs, alignItems: "center", paddingVertical: 2 },
    metaBlock: { borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.elevated, overflow: "hidden" },
    metaRow: { flexDirection: "row", gap: T.sSm, alignItems: "baseline", minHeight: 38, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    reviewBtn: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    taskDot: { fontFamily: "SF Mono", fontSize: T.textUi },
    fileRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    fileParent: { color: colors.textSubtle, fontSize: T.textCaption, fontFamily: "SF Mono" },
    fileBase: { color: colors.assistant, fontSize: T.textUi, fontWeight: "500", fontFamily: "SF Mono" },
    stat: { fontFamily: "SF Mono", fontSize: T.textCaption },
    jobCard: { borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle, padding: T.sSm, gap: T.s2xs },
    jobStatus: { flexDirection: "row", alignItems: "center", gap: 4, height: 22, paddingHorizontal: 8, borderRadius: T.radiusSm, borderWidth: 1 },
    jobStatusDot: { width: 5, height: 5, borderRadius: 2.5 },
    jobStatusText: { fontSize: T.textCaption, fontWeight: "500", letterSpacing: T.trackingUi },
    jobCommand: { flex: 1, color: colors.assistant, fontFamily: "SF Mono", fontSize: T.textCode, minWidth: 0 },
    output: { color: colors.textSecondary, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * T.leadingCode, marginTop: T.s2xs },
    stopButton: { minHeight: 30, justifyContent: "center", paddingHorizontal: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusSm },
  });
}
