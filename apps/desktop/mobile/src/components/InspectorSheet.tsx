// Inspector — the native session-review surface. Mirrors the desktop Inspector's
// sections (meta, tasks, subagents, thinking trail, orchestration, checkpoints,
// changed files with diff) fed by the shared chrome state + transcript
// changed-files. Diff text is already carried per ChangedFile, so review works
// offline from the last snapshot with no extra RPC.
import { useState } from "react";
import { StyleSheet, View, Text, ScrollView, Pressable, useWindowDimensions } from "react-native";
import { Sheet } from "./Sheet";
import { MetaBlock, MetaRow, Section, StatusDot, TaskRow, Empty, formatGitLine, formatGoalLine } from "./activity-shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card, Divider } from "./primitives";
import { contextUsagePercent } from "@shared/context-usage";
import { modeWord } from "@shared/modes";
import type { EngineCommand } from "@shared/commands";
import type { SessionChrome } from "@hooks/session-state";
import type { ChangedFile } from "@shared/reducer";

export function checkpointCommand(action: "undo" | "redo"): EngineCommand {
  return { type: "run-slash", name: action, args: "" };
}

export function InspectorSheet({ open, onClose, chrome, changedFiles, onSend }: {
  open: boolean; onClose: () => void; chrome: SessionChrome; changedFiles: readonly ChangedFile[];
  onSend: (command: EngineCommand) => Promise<boolean>;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkpointConfirm, setCheckpointConfirm] = useState<"undo" | "redo" | null>(null);
  const s = makeStyles(colors);
  if (!open) return null;
  const ctx = contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow);
  const toggle = (path: string) => setExpanded((p) => { const n = new Set(p); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  return (
    <Sheet open={open} onClose={onClose} title="Review" icon="LayoutDashboard" heightRatio={0.9}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, gap: T.sMd, paddingBottom: T.s2xl }}>
            <MetaBlock>
              <MetaRow label="Mode" value={modeWord(chrome.mode === "plan" ? "plan" : "execute")} />
              <MetaRow label="Model" value={chrome.model || "—"} mono />
              {formatGoalLine(chrome.goal, chrome.goalRun) ? <MetaRow label="Goal" value={formatGoalLine(chrome.goal, chrome.goalRun)!} /> : null}
              <MetaRow label="Context" value={ctx != null ? `${ctx}% · ${chrome.ctxUsed.toLocaleString()}/${chrome.ctxWindow.toLocaleString()}` : "—"} />
              <MetaRow label="Tokens" value={chrome.usage.totalTokens.toLocaleString()} />
              <MetaRow label="Cost" value={`$${chrome.usage.costUSD.toFixed(4)}`} />
              {chrome.git ? <MetaRow label="Git" value={formatGitLine(chrome.git)!} mono /> : null}
            </MetaBlock>

            <Section title="Tasks" count={chrome.tasks.length}>
              {chrome.tasks.length === 0 ? <Empty /> : chrome.tasks.map((t) => (
                <TaskRow key={t.id} status={t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending"} title={t.title} />
              ))}
            </Section>

            <Section title="Subagents" count={chrome.subagents.length}>
              {chrome.subagents.length === 0 ? <Empty /> : chrome.subagents.map((sa) => {
                const key = `subagent:${sa.id}`;
                const isExpanded = expanded.has(key);
                const metrics = [
                  sa.agent,
                  sa.metrics?.turns != null ? `${sa.metrics.turns} turns` : null,
                  sa.metrics?.toolCalls != null ? `${sa.metrics.toolCalls} tools` : null,
                  sa.metrics?.inputTokens != null ? `${sa.metrics.inputTokens.toLocaleString()} in` : null,
                  sa.metrics?.outputTokens != null ? `${sa.metrics.outputTokens.toLocaleString()} out` : null,
                ].filter(Boolean).join(" · ");
                return (
                  <Card key={sa.id} surface="surfaceSubtle" inset={T.sXs} style={{ marginBottom: T.sXs }}>
                    <Pressable onPress={() => toggle(key)} style={({ pressed }) => [s.subagentSummary, pressed && { opacity: 0.7 }]}>
                      <StatusDot status={sa.status === "running" ? "running" : "completed"} />
                      <View style={{ flex: 1 }}>
                        <Txt variant="ui" numberOfLines={2}>{sa.prompt || sa.agent || "Subagent"}</Txt>
                        <Txt variant="caption" color={sa.status === "running" ? colors.subagent : colors.textSubtle}>
                          {sa.status === "running" ? (sa.activity ?? "Working…") : "Done"}
                        </Txt>
                      </View>
                      <Text style={s.chev}>{isExpanded ? "▾" : "▸"}</Text>
                    </Pressable>
                    {isExpanded ? (
                      <View style={s.subagentDetail}>
                        {metrics ? <Txt variant="caption" color={colors.textSecondary}>{metrics}</Txt> : null}
                        {sa.result ? <><Txt variant="caption" color={colors.textSubtle}>Result</Txt><Txt variant="ui">{sa.result}</Txt></> : null}
                        {sa.transcript ? <><Txt variant="caption" color={colors.textSubtle}>Transcript</Txt><Text style={s.subagentTranscript}>{sa.transcript}</Text></> : null}
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </Section>

            <Section title="Thinking trail" count={chrome.thoughtLog.length}>
              {chrome.thoughtLog.length === 0 ? <Empty /> : chrome.thoughtLog.map((line, i) => (
                <Txt key={i} variant="caption" color={colors.textSecondary} style={s.trailLine}>{line}</Txt>
              ))}
            </Section>

            <Section title="Orchestration" count={chrome.orchestration.length}>
              {chrome.orchestration.length === 0 ? <Empty /> : chrome.orchestration.map((o) => (
                <View key={o.taskId} style={{ flexDirection: "row", gap: T.sXs, alignItems: "center", paddingVertical: 2 }}>
                  <StatusDot status={o.status === "completed" ? "completed" : o.status === "failed" ? "failed" : "running"} />
                  <Txt variant="ui" color={colors.assistant} style={{ flex: 1 }} numberOfLines={2}>{o.objective}</Txt>
                </View>
              ))}
            </Section>

            <Section title="Checkpoints" count={chrome.checkpoints.length}>
              {chrome.checkpoints.length === 0 ? <Empty /> : (
                <View style={{ gap: T.sXs }}>
                  {chrome.checkpoints.slice().reverse().map((c) => (
                    <Txt key={c.id} variant="ui" color={colors.textSecondary}>⟲ {c.label}</Txt>
                  ))}
                  {checkpointConfirm ? (
                    <View style={s.checkpointActions}>
                      <Txt variant="caption" color={colors.textSecondary} style={{ flex: 1 }}>
                        {checkpointConfirm === "undo"
                          ? `Undo to “${chrome.checkpoints.at(-1)?.label ?? "last checkpoint"}”?`
                          : "Redo the undone checkpoint?"}
                      </Txt>
                      <Pressable onPress={() => setCheckpointConfirm(null)} style={s.smallButton}><Txt variant="caption">Cancel</Txt></Pressable>
                      <Pressable onPress={() => { void onSend(checkpointCommand(checkpointConfirm)); setCheckpointConfirm(null); }} style={s.smallButton}><Txt variant="caption">Confirm</Txt></Pressable>
                    </View>
                  ) : (
                    <View style={s.checkpointActions}>
                      <Pressable onPress={() => setCheckpointConfirm("undo")} style={s.smallButton}><Txt variant="caption">Undo</Txt></Pressable>
                      <Pressable onPress={() => setCheckpointConfirm("redo")} style={s.smallButton}><Txt variant="caption">Redo</Txt></Pressable>
                    </View>
                  )}
                </View>
              )}
            </Section>

            <Section title="Changed files" count={changedFiles.length}>
              {changedFiles.length === 0 ? <Empty /> : changedFiles.map((f) => (
                <View key={f.path} style={{ marginBottom: T.sXs }}>
                  <Pressable onPress={() => toggle(f.path)} style={({ pressed }) => [s.fileRow, pressed && { opacity: 0.7 }]}>
                    <Txt variant="ui" mono style={{ flex: 1 }} numberOfLines={1}>{f.path}</Txt>
                    <Txt variant="caption" color={colors.add}>+{f.added}</Txt>
                    <Txt variant="caption" color={colors.del}>−{f.removed}</Txt>
                    <Text style={s.chev}>{expanded.has(f.path) ? "▾" : "▸"}</Text>
                  </Pressable>
                  {expanded.has(f.path) && f.diff ? (
                    <View style={s.diffBox}>
                      <Text style={s.diffText}>{f.diff}</Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </Section>
      </ScrollView>
    </Sheet>
  );
}


function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    bulletRow: { flexDirection: "row", gap: T.sXs, alignItems: "center", paddingVertical: 2 },
    dot: { fontFamily: "SF Mono", fontSize: T.textUi },
    trailLine: { marginBottom: T.s2xs, lineHeight: T.textCaption * 1.4 },
    subagentSummary: { flexDirection: "row", alignItems: "center", gap: T.sXs },
    subagentDetail: { gap: T.s2xs, marginTop: T.sXs, paddingTop: T.sXs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
    subagentTranscript: { color: colors.textSecondary, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * T.leadingCode },
    checkpointActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: T.sXs, marginTop: T.s2xs },
    smallButton: { minHeight: 32, justifyContent: "center", paddingHorizontal: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusSm },
    fileRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, backgroundColor: colors.surfaceSubtle, borderRadius: T.radiusSm, paddingHorizontal: T.sXs, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft },
    chev: { color: colors.textSubtle, fontFamily: "SF Mono", fontSize: T.textUi },
    diffBox: { marginTop: T.s2xs, backgroundColor: colors.panel, borderRadius: T.radiusXs, padding: T.sXs, borderWidth: 1, borderColor: colors.borderSoft },
    diffText: { color: colors.textSecondary, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * T.leadingCode },
  });
}
