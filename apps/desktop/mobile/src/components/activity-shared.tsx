// Shared activity-sidebar/inspector UI helpers — the native analog of the
// desktop panels/activity-shared.tsx (MetaRow, Section, StatusDot, formatGitLine,
// formatGoalLine). Token-first, matching the desktop .meta-block/.meta-row/
// .sidebar-section h4/.task-row/.StatusDot. Used by both the activity drawer and
// the inspector so the two surfaces stay in lockstep.
import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt } from "./primitives";
import { Icon } from "./icons";
import type { SessionChrome } from "@hooks/session-state";
import type { EngineCommand } from "@shared/commands";

type PermissionDecision = Extract<EngineCommand, { type: "resolve-permission" }>["decision"];
type PlanDecision = Extract<EngineCommand, { type: "resolve-plan" }>["decision"];

/** Keep every live-panel action on the shared EngineCommand contract. */
export function permissionResolutionCommand(
  id: string,
  decision: PermissionDecision,
  feedback?: string,
): EngineCommand {
  const trimmedFeedback = feedback?.trim();
  return {
    type: "resolve-permission",
    id,
    decision,
    ...(decision === "deny" && trimmedFeedback ? { feedback: trimmedFeedback } : {}),
  };
}

export function planResolutionCommand(
  decision: PlanDecision,
  options: { edit?: string; autoApprove?: boolean } = {},
): EngineCommand {
  const edit = options.edit?.trim();
  return {
    type: "resolve-plan",
    decision,
    ...(decision === "edit" && edit ? { edit } : {}),
    ...(decision === "accept" && options.autoApprove ? { approvals: "auto" as const } : {}),
  };
}

export function questionResolutionCommand(
  id: string,
  answers: string[],
  freeform?: string,
): EngineCommand {
  const trimmedFreeform = freeform?.trim();
  return {
    type: "resolve-question",
    id,
    answers,
    ...(trimmedFreeform ? { freeform: trimmedFreeform } : {}),
  };
}

export function queueActionCommand(action: "steer" | "dequeue", id: string): EngineCommand {
  return { type: action, id };
}

export function formatGitLine(git: SessionChrome["git"]): string | null {
  if (!git) return null;
  return [git.branch, git.dirty ? `${git.dirty} dirty` : null, git.ahead ? `↑${git.ahead}` : null, git.behind ? `↓${git.behind}` : null, git.worktree ? "worktree" : null].filter(Boolean).join(" · ");
}
export function formatGoalLine(goal: string | null, run: SessionChrome["goalRun"]): string | null {
  if (!goal) return null;
  return [goal, run?.active ? `${run.phase ?? "run"} ${run.round}/${run.max}` : run?.met ? "met" : null].filter(Boolean).join(" · ");
}

export function MetaBlock({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <View style={s.metaBlock}>{children}</View>;
}
export function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.metaRow}>
      <Txt variant="ui" color={colors.textSubtle} style={{ fontWeight: "500", width: 84 }}>{label}</Txt>
      <Txt variant="ui" mono={mono} color={colors.assistant} style={{ flex: 1, lineHeight: T.textUi * 1.45 }} numberOfLines={2}>{value}</Txt>
    </View>
  );
}
export function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: T.sXs, marginBottom: T.sXs }}>
        <Txt variant="caption" color={colors.textSubtle} style={{ fontWeight: "500" }}>{title}</Txt>
        {count != null ? <Txt variant="caption" color={colors.textSubtle}>{count}</Txt> : null}
      </View>
      {children}
    </View>
  );
}
export function StatusDot({ status }: { status: "completed" | "in_progress" | "pending" | "failed" | "running" }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  if (status === "completed") return <View style={[s.dot, { backgroundColor: colors.taskDone }]}><Icon name="Check" size={10} color={colors.bg} strokeWidth={2.4} /></View>;
  if (status === "failed") return <View style={[s.dot, { backgroundColor: colors.del }]}><Icon name="X" size={10} color={colors.bg} strokeWidth={2.4} /></View>;
  const c = status === "in_progress" || status === "running" ? colors.taskActive : colors.taskPending;
  return <View style={[s.dot, { backgroundColor: c, opacity: status === "in_progress" || status === "running" ? 1 : 0.5 }]} />;
}
export function TaskRow({ status, title }: { status: "completed" | "in_progress" | "pending"; title: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: T.sXs, alignItems: "center", paddingVertical: 2 }}>
      <StatusDot status={status} />
      <Txt variant="ui" color={status === "completed" ? colors.textSubtle : colors.assistant} style={{ flex: 1, textDecorationLine: status === "completed" ? "line-through" : "none" }}>{title}</Txt>
    </View>
  );
}
export function Empty({ children }: { children?: React.ReactNode }) {
  const { colors } = useTheme();
  return <Txt variant="caption" color={colors.textSubtle}>{children ?? "—"}</Txt>;
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    metaBlock: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft },
    metaRow: { flexDirection: "row", gap: T.sSm, alignItems: "baseline", minHeight: 40, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    dot: { width: 14, height: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  });
}
