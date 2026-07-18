// Composer — the message input. Routes typed lines through the same shared
// `lineToCommands` + `classifySubmitLine` the desktop uses, so slash commands,
// `/plan <text>` mode+submit, and `/clear`/`/new` behave identically. Mode chip
// cycles with the shared `cycleModeAction`; busy shows Stop (abort).
import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View, Pressable, KeyboardAvoidingView, Platform, ScrollView, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, shadowFloat } from "../theme/tokens";
import { Txt, Spinner } from "./primitives";
import { SlashPalette } from "./SlashPalette";
import { Icon, type IconName } from "./icons";
import { lineToCommands, routePendingPermLine } from "@shared/slash";
import { classifySubmitLine } from "@shared/submit-routing";
import { commandsExpectBusy } from "@shared/command-busy";
import { contextUsagePercent } from "@shared/context-usage";
import { modeWord, type UiMode } from "@shared/modes";
import type { EngineCommand } from "@shared/commands";
import type { SessionChrome } from "@hooks/session-state";
import { GlassBackdrop } from "./GlassBackdrop";
import { appendAttachmentTokens, MOBILE_COMPOSER_MAX_ATTACHMENTS, type MobileComposerAttachment } from "../attachments/attachment-commands";

interface ComposerProps {
  chrome: SessionChrome;
  uiMode: "plan" | "execute" | "yolo";
  modeColor: string;
  text: string;
  setText: (t: string) => void;
  onSend: (commands: EngineCommand[]) => Promise<boolean>;
  onAbort: () => void;
  onCycleMode: () => void;
  onSelectMode: (mode: UiMode) => void;
  onClear: () => void;
  executionTarget: "local" | "cloud";
  onOpenCloud: () => void;
  onOpenWorkspace: (target: "session" | "changes" | "git" | "terminal" | "jobs") => void;
  workspaceBadges: Partial<Record<"session" | "changes" | "git" | "jobs", boolean>>;
  onShellRoute: (kind: "keys" | "settings" | "jobs" | "git") => void;
  onPickAttachments: (kind: "photo" | "file", remaining: number) => Promise<MobileComposerAttachment[]>;
  onHeightChange?: (height: number) => void;
}

export function Composer({ chrome, uiMode, modeColor, text, setText, onSend, onAbort, onCycleMode, onSelectMode, onClear, executionTarget, onOpenCloud, onOpenWorkspace, workspaceBadges, onShellRoute, onPickAttachments, onHeightChange }: ComposerProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const s = makeStyles(colors);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [attachments, setAttachments] = useState<MobileComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const MODE_HINT: Record<UiMode, string> = { plan: "Plan before editing", execute: "Edit with approvals", yolo: "Run without asking" };
  const MODE_ICON: Record<UiMode, IconName> = { plan: "Check", execute: "Settings", yolo: "SquareTerminal" };
  const MODES: UiMode[] = ["plan", "execute", "yolo"];
  const WORKSPACE: { id: "session" | "changes" | "git" | "terminal" | "jobs"; label: string; icon: IconName }[] = [
    { id: "session", label: "Session", icon: "LayoutDashboard" },
    { id: "changes", label: "Changes", icon: "FileText" },
    { id: "git", label: "Git", icon: "GitBranch" },
    { id: "terminal", label: "Terminal", icon: "SquareTerminal" },
    { id: "jobs", label: "Jobs", icon: "Cloud" },
  ];

  const ctxPct = contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow);
  const ctxLabel = ctxPct != null && ctxPct > 0 ? `${ctxPct}%` : null;

  async function submitCommands(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const route = classifySubmitLine(trimmed);
    if (route.kind !== "engine") { onShellRoute(route.kind); return; }
    // When a permission is pending, a plain message is a permission decision
    // (y/a/n/p or free-text deny-with-feedback) — not a prompt (desktop parity).
    if (trimmed && chrome.perms.length > 0 && !trimmed.startsWith("/")) {
      const permRoute = routePendingPermLine(trimmed);
      if (permRoute.kind === "perm") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        await onSend([{ type: "resolve-permission", id: chrome.perms[0]!.id, decision: permRoute.decision, ...(permRoute.feedback ? { feedback: permRoute.feedback } : {}) }]);
        return;
      }
    }
    // When a plan is pending, a plain message (not a slash) is plan revision
    // feedback — send resolve-plan:edit, not submit-prompt (desktop parity).
    if (trimmed && chrome.plan && !trimmed.startsWith("/")) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      await onSend([{ type: "resolve-plan", decision: "edit", edit: trimmed }]);
      return;
    }
    const bareCatalog = ["/model", "/providers", "/agents", "/skills", "/mcp"];
    if (bareCatalog.includes(trimmed)) { setText(""); return; }
    if (trimmed === "/exit" || trimmed === "/quit") { setText(""); return; }
    const commands = lineToCommands(trimmed);
    if (trimmed === "/clear" || trimmed === "/new") {
      if (chrome.busy) onAbort();
      onClear();
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    await onSend(commands);
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const route = trimmed ? classifySubmitLine(trimmed) : { kind: "engine" as const };
    if (route.kind !== "engine") {
      onShellRoute(route.kind);
      setText("");
      return;
    }
    if (chrome.perms.length > 0 && !trimmed.startsWith("/")) {
      const permRoute = routePendingPermLine(trimmed);
      if (permRoute.kind === "perm") {
        setText("");
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        await onSend([{ type: "resolve-permission", id: chrome.perms[0]!.id, decision: permRoute.decision, ...(permRoute.feedback ? { feedback: permRoute.feedback } : {}) }]);
        return;
      }
    }
    if (chrome.plan && !trimmed.startsWith("/")) {
      setText("");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      await onSend([{ type: "resolve-plan", decision: "edit", edit: trimmed }]);
      return;
    }
    const bareCatalog = ["/model", "/providers", "/agents", "/skills", "/mcp"];
    if (bareCatalog.includes(trimmed)) { setText(""); return; }
    if (trimmed === "/exit" || trimmed === "/quit") { setText(""); return; }
    const includeAttachments = !trimmed.startsWith("/");
    const baseCommands: EngineCommand[] = trimmed ? lineToCommands(trimmed) : [{ type: "submit-prompt", text: "" }];
    const commands = includeAttachments ? appendAttachmentTokens(baseCommands, attachments) : baseCommands;
    if (trimmed === "/clear" || trimmed === "/new") {
      if (chrome.busy) onAbort();
      onClear();
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    const accepted = await onSend(commands);
    if (accepted) {
      setText("");
      if (includeAttachments) setAttachments([]);
    }
  }

  async function addAttachments(kind: "photo" | "file") {
    if (uploading) return;
    setUploading(true);
    try {
      const picked = await onPickAttachments(kind, MOBILE_COMPOSER_MAX_ATTACHMENTS - attachments.length);
      if (picked.length) setAttachments((current) => [...current, ...picked].slice(0, MOBILE_COMPOSER_MAX_ATTACHMENTS));
    } finally {
      setUploading(false);
    }
  }

  const busy = chrome.busy;
  const reportHeight = (event: LayoutChangeEvent) => onHeightChange?.(Math.ceil(event.nativeEvent.layout.height));

  return (
    <KeyboardAvoidingView onLayout={reportHeight} behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 20 }}>
      {modeMenuOpen ? (
        <View style={{ position: "absolute", left: T.sBase, right: T.sBase, bottom: "100%", marginBottom: 8, zIndex: 40 }}>
          <View style={[s.menu, { width: 280 }]}>
            <View style={s.modeMenuHead}><Txt variant="label" color={colors.textSubtle}>How should Vibe work?</Txt><Txt variant="caption" color={colors.textSubtle}>⇧Tab to cycle</Txt></View>
            {MODES.map((m) => {
              const active = uiMode === m;
              return (
                <Pressable key={m} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined); onSelectMode(m); setModeMenuOpen(false); }} style={({ pressed }) => [s.modeOpt, active && s.modeOptActive, pressed && { opacity: 0.7 }]}>
                  <View style={[s.modeOptIcon, { backgroundColor: modeColorFor(m, colors) }]}><Icon name={MODE_ICON[m]} size={14} color={colors.bg} /></View>
                  <View style={{ flex: 1 }}>
                    <Txt variant="ui" style={{ fontWeight: "500" }}>{modeWord(m)}</Txt>
                    <Txt variant="caption" color={colors.textSubtle}>{MODE_HINT[m]}</Txt>
                  </View>
                  {active ? <Icon name="Check" size={15} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      <View style={[s.composerBackdrop, { paddingBottom: insets.bottom + T.sSm }]}>
        <View style={s.composerShell}>
          <GlassBackdrop intensity={64} />
          {workspaceOpen ? (
            <View>
              <View style={s.attachmentActions}>
                <Pressable accessibilityLabel="Attach photos" accessibilityRole="button" disabled={uploading} onPress={() => void addAttachments("photo")} style={({ pressed }) => [s.attachmentAction, pressed && s.workspaceItemPressed]}>
                  <Icon name="Paperclip" size={16} color={colors.textSecondary} />
                  <Txt variant="caption" color={colors.textSecondary}>Photos</Txt>
                </Pressable>
                <Pressable accessibilityLabel="Attach documents" accessibilityRole="button" disabled={uploading} onPress={() => void addAttachments("file")} style={({ pressed }) => [s.attachmentAction, pressed && s.workspaceItemPressed]}>
                  <Icon name="FileText" size={16} color={colors.textSecondary} />
                  <Txt variant="caption" color={colors.textSecondary}>Files</Txt>
                </Pressable>
                {uploading ? <View style={s.uploading}><Spinner size="small" /><Txt variant="caption" color={colors.textSubtle}>Uploading securely…</Txt></View> : null}
              </View>
              <View style={s.workspaceTray}>
                {WORKSPACE.map((item) => (
                  <Pressable key={item.id} accessibilityLabel={`Open ${item.label}`} onPress={() => { setWorkspaceOpen(false); onOpenWorkspace(item.id); }} style={({ pressed }) => [s.workspaceItem, pressed && s.workspaceItemPressed]}>
                    <View>
                      <Icon name={item.icon} size={17} color={colors.textSecondary} />
                      {item.id !== "terminal" && workspaceBadges[item.id] ? <View style={s.workspaceDot} /> : null}
                    </View>
                    <Txt variant="micro" color={colors.textSubtle}>{item.label}</Txt>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {text.startsWith("/") ? <SlashPalette draft={text} commandNames={chrome.commandNames} onPick={(draft, done) => { if (done) { setText(""); void submitCommands(draft); } else setText(draft); }} /> : null}
          {attachments.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.attachments} accessibilityLabel={`${attachments.length} attached file${attachments.length === 1 ? "" : "s"}`}>
              {attachments.map((attachment) => (
                <View key={attachment.id} style={s.attachmentChip}>
                  <Icon name="Paperclip" size={13} color={colors.textSecondary} />
                  <Txt variant="caption" numberOfLines={1} style={s.attachmentName}>{attachment.name}</Txt>
                  <Pressable accessibilityLabel={`Remove ${attachment.name}`} accessibilityRole="button" onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} style={s.attachmentRemove}>
                    <Icon name="X" size={13} color={colors.textSubtle} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder={busy ? "Working…" : "Message, or / for commands"}
            placeholderTextColor={colors.textSubtle}
            multiline
            editable={!busy}
          />
          <View style={s.footer}>
            <View style={s.footerLeft}>
              <Pressable accessibilityLabel="Workspace tools" accessibilityRole="button" onPress={() => setWorkspaceOpen((open) => !open)} style={({ pressed }) => [s.toolButton, workspaceOpen && s.toolButtonActive, pressed && { opacity: 0.6 }]}>
                <Icon name="Plus" size={17} color={workspaceOpen ? colors.assistant : colors.textSecondary} />
              </Pressable>
              <Pressable accessibilityLabel={`Mode: ${modeWord(uiMode)}`} accessibilityRole="button" onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); setModeMenuOpen((o) => !o); }} style={({ pressed }) => [s.modeChip, { borderColor: modeMenuOpen ? modeColor : colors.borderSoft }, pressed && { opacity: 0.6 }]}>
                <Text style={[s.modeText, { color: modeColor }]}>{modeWord(uiMode)}</Text>
              </Pressable>
              <Pressable accessibilityLabel={`Runtime: ${executionTarget === "cloud" ? "Cloud" : "Local"}`} accessibilityRole="button" onPress={onOpenCloud} style={({ pressed }) => [s.runtimeChip, pressed && { opacity: 0.6 }]}>
                <Icon name={executionTarget === "cloud" ? "Cloud" : "Laptop"} size={13} color={executionTarget === "cloud" ? colors.tool : colors.textSecondary} />
                <Txt variant="caption" color={executionTarget === "cloud" ? colors.tool : colors.textSecondary}>{executionTarget === "cloud" ? "Cloud" : "Local"}</Txt>
              </Pressable>
              {chrome.model ? <Txt variant="caption" color={colors.textSubtle} numberOfLines={1} style={s.modelLabel}>{chrome.model}</Txt> : null}
            </View>
            {ctxLabel ? <Txt variant="caption" color={colors.ctx}>{ctxLabel}</Txt> : null}
            {busy ? (
              <Pressable accessibilityLabel="Stop generation" accessibilityRole="button" onPress={onAbort} style={({ pressed }) => [s.sendBtn, { backgroundColor: colors.del, opacity: pressed ? 0.7 : 1 }]}>
                <Icon name="Square" size={16} color={colors.bg} />
              </Pressable>
            ) : (
              <Pressable accessibilityLabel="Send message" accessibilityRole="button" onPress={submit} disabled={uploading || (!text.trim() && attachments.length === 0)} style={({ pressed }) => [s.sendBtn, { backgroundColor: colors.accent, opacity: pressed ? 0.7 : uploading || (!text.trim() && attachments.length === 0) ? 0.35 : 1 }]}>
                <Icon name="ArrowUp" size={18} color={colors.bg} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function modeColorFor(m: UiMode, colors: ReturnType<typeof useTheme>["colors"]): string {
  if (m === "plan") return colors.plan;
  if (m === "yolo") return colors.del;
  return colors.accent;
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    composerBackdrop: { paddingHorizontal: T.sSm, paddingTop: T.sXs, backgroundColor: "transparent" },
    composerShell: { width: "100%", maxWidth: 760, alignSelf: "center", backgroundColor: "transparent", borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft, overflow: "hidden", ...shadowFloat(colors) },
    menu: { backgroundColor: colors.overlay, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, overflow: "hidden", ...shadowFloat(colors) },
    modeChip: { minHeight: 36, paddingHorizontal: 10, borderRadius: T.radiusPill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle, alignItems: "center", justifyContent: "center" },
    runtimeChip: { minHeight: 36, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 4, borderRadius: T.radiusPill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle },
    modeMenuHead: { paddingHorizontal: T.sSm, paddingTop: T.sXs, paddingBottom: T.s2xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    modeOpt: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sSm, paddingVertical: T.sXs },
    modeOptActive: { backgroundColor: colors.navActiveBg },
    modeOptIcon: { width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" },
    modeText: { fontSize: T.textCaption, fontWeight: "500", letterSpacing: T.trackingUi },
    attachmentActions: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sXs, paddingTop: T.sXs },
    attachmentAction: { minHeight: 38, paddingHorizontal: T.sSm, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle },
    uploading: { flex: 1, flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6, paddingRight: T.sXs },
    workspaceTray: { flexDirection: "row", alignItems: "stretch", paddingHorizontal: T.sXs, paddingTop: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    workspaceItem: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 3, borderRadius: T.radiusMd },
    workspaceItemPressed: { backgroundColor: colors.surfaceSubtle },
    workspaceDot: { position: "absolute", top: -2, right: -4, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.notice },
    attachments: { gap: T.sXs, paddingHorizontal: T.sSm, paddingTop: T.sXs },
    attachmentChip: { maxWidth: 240, minHeight: 34, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: T.sXs, paddingRight: 2, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft },
    attachmentName: { flexShrink: 1 },
    attachmentRemove: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
    input: {
      color: colors.assistant, fontSize: T.textProse, lineHeight: T.textProse * T.leadingProse,
      backgroundColor: "transparent", paddingHorizontal: T.sSm, paddingVertical: T.sSm,
      minHeight: 58, maxHeight: T.composerInputMax, paddingTop: T.sSm,
    },
    footer: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sXs, paddingBottom: T.sXs },
    footerLeft: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: T.sXs },
    toolButton: { width: 40, height: 40, borderRadius: T.radiusPill, alignItems: "center", justifyContent: "center" },
    toolButtonActive: { backgroundColor: colors.surfaceSubtle },
    modelLabel: { flexShrink: 1, maxWidth: 130 },
    sendBtn: { width: 40, height: 40, borderRadius: T.radiusPill, alignItems: "center", justifyContent: "center" },
    sendText: { fontSize: T.textUi, fontWeight: "600", letterSpacing: T.trackingUi },
  });
}

export { Spinner };
