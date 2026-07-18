// Live approval surfaces — permission, plan, question, and queue cards. These
// are the interactive gates where the user steers the agent; they send the
// same resolve-* EngineCommands the desktop cards do. Styled to match the
// desktop .card / .card.perm / .card.plan / .card-actions / .chip buttons.
import { useState } from "react";
import { StyleSheet, Text, View, Pressable, TextInput } from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, shadowFloat } from "../theme/tokens";
import { Txt } from "./primitives";
import { permissionInputForDisplay } from "@shared/permission-input";
import type { EngineCommand } from "@shared/commands";
import type { SessionChrome } from "@hooks/session-state";
import type { PendingPerm } from "@shared/reducer";
import type { StructuredQuestion } from "@shared/types";
import type { PendingCapabilityRequest } from "@shared/cloud";

interface Props {
  chrome: SessionChrome;
  pendingCapabilities: PendingCapabilityRequest[];
  onSend: (commands: EngineCommand[]) => Promise<boolean>;
}

export function LivePanels({ chrome, pendingCapabilities, onSend }: Props) {
  return (
    <View style={{ paddingHorizontal: T.sBase, paddingBottom: T.sXs, gap: T.sXs }}>
      {pendingCapabilities[0] ? <CapabilityCard request={pendingCapabilities[0]} onSend={onSend} /> : null}
      {chrome.perms.length > 0 ? <PermissionCard perm={chrome.perms[0]!} onSend={onSend} /> : null}
      {chrome.plan ? <PlanCard onSend={onSend} approvals={chrome.approvals} /> : null}
      {chrome.question ? <QuestionCard question={chrome.question} onSend={onSend} /> : null}
      {chrome.queuePending.length > 0 ? <QueueCard chrome={chrome} onSend={onSend} /> : null}
    </View>
  );
}

function CapabilityCard({ request, onSend }: { request: PendingCapabilityRequest; onSend: (c: EngineCommand[]) => Promise<boolean> }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  let preview = "";
  try {
    const encoded = JSON.stringify(request.arguments, null, 2);
    preview = encoded.length > 4_000 ? `${encoded.slice(0, 4_000)}\n…` : encoded;
  } catch { preview = "Arguments could not be displayed"; }
  return (
    <CardSurface style={[s.perm, { borderColor: colors.notice }]}>
      <View style={s.head}>
        <Text style={[s.eyebrow, { color: colors.notice }]}>NEEDS YOUR MAC · {request.integration.toUpperCase()}</Text>
        <Text style={s.title}>{request.toolName} is local-only</Text>
      </View>
      <Text style={s.detail}>The local capability relay is not enabled in this experimental build. Deny this request to let the Cloud turn continue.</Text>
      {preview ? <Text style={s.detail} numberOfLines={5}>{preview}</Text> : null}
      <View style={s.actions}>
        <Chip label="Deny and continue" variant="danger" onPress={() => void onSend([{
          type: "resolve-external-capability",
          id: request.id,
          decision: "deny",
          error: "Local capability relay is not enabled in this experimental build",
        }])} />
      </View>
    </CardSurface>
  );
}

function permPreview(perm: PendingPerm): string {
  try {
    const projected = permissionInputForDisplay(perm.input);
    return typeof projected === "string" ? projected : JSON.stringify(projected, null, 2);
  } catch {
    return "";
  }
}

// Desktop .card: radius-lg, border border 34%, surface-subtle 88% bg, elev-rest.
function CardSurface({ children, style }: { children: React.ReactNode; style?: any }) {
  const { colors } = useTheme();
  return <View style={[makeCardStyle(colors).card, style]}>{children}</View>;
}
// Desktop .chip/.button: height 34 (perm/plan), radius-sm, border, surface bg, caption medium; primary = assistant bg.
function Chip({ label, onPress, variant, style }: { label: string; onPress: () => void; variant?: "primary" | "ghost" | "danger"; style?: any }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  const bg = variant === "primary" ? colors.assistant : variant === "danger" ? "transparent" : colors.surfaceSubtle;
  const fg = variant === "primary" ? colors.bg : variant === "danger" ? colors.del : colors.muted;
  const border = variant === "primary" ? "transparent" : variant === "danger" ? colors.del : colors.borderSoft;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.chip, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.7 : 1 }, style]}>
      <Text style={[s.chipText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

function PermissionCard({ perm, onSend }: { perm: PendingPerm; onSend: (c: EngineCommand[]) => Promise<boolean> }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  const tap = (decision: "once" | "always" | "deny") => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    void onSend([{ type: "resolve-permission", id: perm.id, decision }]);
  };
  const preview = permPreview(perm);
  return (
    <CardSurface style={s.perm}>
      <View style={s.head}>
        <Text style={s.eyebrow}>PERMISSION</Text>
        <Text style={s.title}>{perm.toolName}</Text>
      </View>
      {preview ? <Text style={s.detail} numberOfLines={6}>{preview}</Text> : null}
      <View style={s.actions}>
        <Chip label="Allow once" variant="primary" onPress={() => tap("once")} style={{ flex: 1 }} />
        <Chip label="Always" onPress={() => tap("always")} style={{ flex: 1 }} />
        <Chip label="Deny" variant="danger" onPress={() => tap("deny")} style={{ flex: 1 }} />
      </View>
    </CardSurface>
  );
}

function PlanCard({ onSend, approvals }: { onSend: (c: EngineCommand[]) => Promise<boolean>; approvals: "ask" | "auto" }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  const [edit, setEdit] = useState("");
  const accept = (auto: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    void onSend([{ type: "resolve-plan", decision: "accept", ...(auto ? { approvals: "auto" as const } : {}) }]);
  };
  return (
    <CardSurface style={[s.perm, { borderColor: colors.plan }]}>
      <View style={s.head}>
        <Text style={[s.eyebrow, { color: colors.plan }]}>PLAN READY</Text>
        <Text style={s.title}>Accept this plan to start</Text>
      </View>
      <View style={s.actions}>
        <Chip label="Accept" variant="primary" onPress={() => accept(approvals === "auto")} style={{ flex: 1 }} />
        <Chip label="Y (YOLO)" onPress={() => accept(true)} style={{ flex: 1 }} />
        <Chip label="Keep planning" onPress={() => onSend([{ type: "resolve-plan", decision: "keep-planning" }])} style={{ flex: 1 }} />
      </View>
      <TextInput style={s.editInput} placeholder="Revise plan…" placeholderTextColor={colors.textSubtle} value={edit} onChangeText={setEdit} multiline />
      <Chip label="Send revision" onPress={() => { if (edit.trim()) { void onSend([{ type: "resolve-plan", decision: "edit", edit: edit.trim() }]); setEdit(""); } }} />
    </CardSurface>
  );
}

function QuestionCard({ question, onSend }: { question: StructuredQuestion; onSend: (c: EngineCommand[]) => Promise<boolean> }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  const [selected, setSelected] = useState<string[]>([]);
  const [freeform, setFreeform] = useState("");
  const toggle = (label: string) => setSelected((prev) => prev.includes(label) ? prev.filter((l) => l !== label) : question.multiple ? [...prev, label] : [label]);
  const canSubmit = selected.length > 0 || (question.allowFreeform && freeform.trim().length > 0);
  const submit = () => {
    if (!canSubmit) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    void onSend([{ type: "resolve-question", id: question.id, answers: selected, freeform: freeform.trim() || undefined }]);
    setSelected([]); setFreeform("");
  };
  return (
    <CardSurface style={s.perm}>
      <View style={s.head}>
        <Text style={s.eyebrow}>QUESTION</Text>
        <Text style={s.title}>{question.header ?? "Answer the agent"}</Text>
      </View>
      <Text style={s.detail}>{question.question}</Text>
      {question.choices.length > 0 ? (
        <View style={s.actions}>
          {question.choices.map((choice) => {
            const active = selected.includes(choice.label);
            return (
              <Pressable key={choice.label} onPress={() => toggle(choice.label)} style={({ pressed }) => [s.chip, { backgroundColor: active ? colors.assistant : colors.surfaceSubtle, borderColor: active ? "transparent" : colors.borderSoft, opacity: pressed ? 0.7 : 1 }, { flex: 1 }]}>
                <Text style={[s.chipText, { color: active ? colors.bg : colors.muted }]}>{choice.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {question.allowFreeform ? <TextInput style={s.editInput} placeholder="Type an answer…" placeholderTextColor={colors.textSubtle} value={freeform} onChangeText={setFreeform} multiline /> : null}
      <Chip label="Reply" variant="primary" onPress={submit} />
    </CardSurface>
  );
}

function QueueCard({ chrome, onSend }: { chrome: SessionChrome; onSend: (c: EngineCommand[]) => Promise<boolean> }) {
  const { colors } = useTheme();
  const s = makeCardStyle(colors);
  return (
    <CardSurface>
      <View style={s.head}><Text style={s.eyebrow}>QUEUE · {chrome.queuePending.length} WAITING</Text></View>
      {chrome.queuePending.slice(0, 3).map((item) => (
        <View key={item.id} style={s.queueItem}>
          <Text style={s.queueLabel} numberOfLines={1}>{item.label}</Text>
          <Pressable onPress={() => onSend([{ type: "steer", id: item.id }])}><Text style={[s.queueAction, { color: colors.notice }]}>steer</Text></Pressable>
          <Pressable onPress={() => onSend([{ type: "dequeue", id: item.id }])}><Text style={[s.queueAction, { color: colors.del }]}>drop</Text></Pressable>
        </View>
      ))}
    </CardSurface>
  );
}

function makeCardStyle(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    card: { padding: T.sSm, paddingHorizontal: T.sBase, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle, ...shadowFloat(colors) },
    perm: { padding: T.sMd },
    head: { gap: 2, marginBottom: T.sSm },
    eyebrow: { color: colors.textSubtle, fontSize: T.textMicro, fontWeight: "600", letterSpacing: T.trackingUi, lineHeight: 1.2 * T.textMicro, textTransform: "uppercase" },
    title: { color: colors.assistant, fontSize: T.textTitle, fontWeight: "600", letterSpacing: T.trackingTight, lineHeight: 1.3 * T.textTitle },
    detail: { color: colors.muted, fontSize: T.textUi, lineHeight: 1.45 * T.textUi, letterSpacing: T.trackingUi, marginTop: T.s2xs },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: T.sXs, marginTop: T.sMd, paddingTop: T.sSm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
    chip: { height: 34, minHeight: 34, paddingHorizontal: T.sSm, borderRadius: T.radiusSm, borderWidth: 1, alignItems: "center", justifyContent: "center" },
    chipText: { fontSize: T.textCaption, fontWeight: "500", letterSpacing: T.trackingUi },
    editInput: { color: colors.assistant, fontSize: T.textUi, backgroundColor: colors.surfaceSubtle, borderRadius: T.radiusSm, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft, minHeight: 40, marginTop: T.sXs },
    queueItem: { flexDirection: "row", alignItems: "center", gap: T.sSm, paddingVertical: T.s2xs },
    queueLabel: { flex: 1, color: colors.muted, fontSize: T.textUi, letterSpacing: T.trackingUi },
    queueAction: { fontSize: T.textCaption, fontWeight: "500" },
  });
}
function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) { return makeCardStyle(colors); }
