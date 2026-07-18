// Transcript renderer — turns the shared reducer's Block[] (grouped into Turns)
// into native threaded rows. Mirrors the desktop transcript: user bubbles,
// assistant markdown, collapsible tool rows with streaming tail, thinking
// bursts, and notices. Token-first; mono for code/tool output, sans for prose.
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View, Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, shadowFloat } from "../theme/tokens";
import { Txt, IconButton } from "./primitives";
import { Markdown } from "./Markdown";
import { Icon } from "./icons";
import { GLYPH } from "@shared/glyphs";
import type { Block, Turn } from "@shared/reducer";
import { parseSources } from "@shared/sources";
import { safeExternalUrl } from "@shared/external-url";
import { Linking } from "react-native";

export function Transcript({ turns, thinkingStream, foldedTurns, onToggleFold, onEditUser, itemWindowFor, onRevealItems }: { turns: Turn[]; thinkingStream: string; foldedTurns: Set<number>; onToggleFold: (key: number) => void; onEditUser: (text: string) => void; itemWindowFor: (key: number, count: number) => { start: number; hidden: number; revealPage: number }; onRevealItems: (key: number, hidden: number) => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const listRef = useRef<FlatList>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    if (turns.length) {
      const last = turns[turns.length - 1]!;
      const items = last.items.length;
      const t = setTimeout(() => listRef.current?.scrollToOffset({ offset: 1e9, animated: true }), 60);
      return () => clearTimeout(t);
      void items;
    }
  }, [turns]);

  const data = useMemo(() => turns.flatMap((t) => [
    { key: `u-${t.key}`, turn: t },
  ]), [turns]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function copy(id: number, text: string) {
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setCopiedId(id);
    setTimeout(() => setCopiedId((current) => current === id ? null : current), 1600);
  }

  return (
    <FlatList
      ref={listRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingVertical: T.sSm, paddingHorizontal: T.sBase }}
      data={data}
      keyExtractor={(item) => item.key}
      renderItem={({ item }: { item: { key: string; turn: Turn } }) => (
        <View style={{ marginBottom: T.sMd }}>
          {item.turn.user ? <UserBubble block={item.turn.user} folded={foldedTurns.has(item.turn.key)} hiddenItems={item.turn.items.length} copied={copiedId === item.turn.user.id} onToggle={() => onToggleFold(item.turn.key)} onCopy={() => void copy(item.turn.user!.id, item.turn.user!.text)} onEdit={() => onEditUser(item.turn.user!.text)} /> : null}
          {foldedTurns.has(item.turn.key) ? null : (() => {
            const w = itemWindowFor(item.turn.key, item.turn.items.length);
            const visibleItems = item.turn.items.slice(w.start);
            return (
              <>
                {w.hidden > 0 ? (
                  <Pressable onPress={() => onRevealItems(item.turn.key, w.hidden)} style={{ alignItems: "center", paddingVertical: 4 }}>
                    <Txt variant="caption" color={colors.textSubtle}>↑ Reveal {w.revealPage} more items</Txt>
                  </Pressable>
                ) : null}
                {visibleItems.map((b: Block) => <BlockRow key={b.id} block={b} expanded={expanded.has(b.id)} copied={copiedId === b.id} onCopy={() => void copy(b.id, blockText(b))} onToggle={() => toggle(b.id)} />)}
              </>
            );
          })()}
          {item.turn === turns[turns.length - 1] && thinkingStream ? (
            <View style={s.thinking}>
              <Text style={s.thinkingDot}>{GLYPH.think}</Text>
              <Txt variant="ui" color={colors.textSecondary} numberOfLines={1}>{thinkingStream}</Txt>
            </View>
          ) : null}
        </View>
      )}
    />
  );
}

function UserBubble({ block, folded, hiddenItems, copied, onToggle, onCopy, onEdit }: { block: Extract<Block, { kind: "user" }>; folded: boolean; hiddenItems: number; copied: boolean; onToggle: () => void; onCopy: () => void; onEdit: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.userStack}>
      <Pressable onPress={onToggle} style={({ pressed }) => [s.userBubble, pressed && { opacity: 0.82 }]}>
        <Txt variant="prose" style={s.userText}>{block.text}</Txt>
        {folded && hiddenItems > 0 ? <Txt variant="caption" color={colors.textSubtle} style={{ marginTop: T.s2xs }}>{hiddenItems} hidden</Txt> : null}
        {block.label ? <Txt variant="caption" color={colors.textSubtle} style={{ marginTop: T.s2xs }}>{block.label}</Txt> : null}
      </Pressable>
      <View style={s.messageActions}>
        <Pressable accessibilityLabel="Copy message" onPress={onCopy} hitSlop={8} style={s.actionButton}><Icon name={copied ? "Check" : "Copy"} size={13} color={copied ? colors.add : colors.textSubtle} /></Pressable>
        <Pressable accessibilityLabel="Edit message" onPress={onEdit} hitSlop={8} style={s.actionButton}><Icon name="Pencil" size={13} color={colors.textSubtle} /></Pressable>
        <Txt variant="micro" color={colors.textSubtle}>{formatMessageTime(block.timestamp)}</Txt>
      </View>
    </View>
  );
}

function BlockRow({ block, expanded, copied, onCopy, onToggle }: { block: Block; expanded: boolean; copied: boolean; onCopy: () => void; onToggle: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  switch (block.kind) {
    case "assistant":
      return (
        <View style={s.assistant}>
          {block.gap ? <View style={s.gap} /> : null}
          <Markdown text={block.text} />
          {block.streaming ? <Text style={s.cursor}>▋</Text> : null}
          {!block.streaming && block.text ? <View style={s.assistantActions}><Pressable accessibilityLabel="Copy answer" onPress={onCopy} hitSlop={8} style={s.actionButton}><Icon name={copied ? "Check" : "Copy"} size={13} color={copied ? colors.add : colors.textSubtle} /></Pressable><Txt variant="micro" color={colors.textSubtle}>{formatMessageTime(block.timestamp)}</Txt></View> : null}
        </View>
      );
    case "tool":
      return (
        <Pressable onPress={onToggle} style={({ pressed }) => [s.tool, pressed && { backgroundColor: colors.surfaceSubtle }]}>
          <View style={s.toolHead}>
            <Text style={[s.toolGlyph, { color: block.isError ? colors.del : colors.tool }]}>{block.done ? (block.isError ? "✕" : "✓") : "›"}</Text>
            <Txt variant="caption" color={colors.textSubtle} style={{ flex: 1, fontWeight: "400" }} numberOfLines={1}>{block.label}</Txt>
            {block.tail && !block.done ? <Txt variant="caption" mono color={colors.textSubtle} numberOfLines={1} style={{ flexShrink: 1 }}>{block.tail}</Txt> : null}
            {block.output.length > 0 ? <Pressable accessibilityLabel="Copy tool output" onPress={onCopy} hitSlop={8} style={s.actionButton}><Icon name={copied ? "Check" : "Copy"} size={13} color={copied ? colors.add : colors.textSubtle} /></Pressable> : null}
            <Text style={s.chev}>{expanded ? "▾" : "▸"}</Text>
          </View>
          {expanded && block.output.length > 0 ? (
            <View style={s.toolOutput}>
              {block.isSources ? renderSources(block.output.join("\n"), colors, s) : null}
              {block.isMarkdown ? <Markdown text={block.output.join("\n")} /> : null}
              {!block.isSources && !block.isMarkdown ? <Text style={s.toolOutputText}>{block.output.join("\n")}</Text> : null}
            </View>
          ) : null}
        </Pressable>
      );
    case "thinking":
      return (
        <Pressable onPress={onToggle} style={({ pressed }) => [s.thinkingRow, pressed && { backgroundColor: colors.surfaceSubtle }]}>
          <View style={s.toolHead}>
            <Text style={s.thinkGlyph}>✻</Text>
            <Txt variant="caption" color={colors.muted} style={{ flex: 1 }} numberOfLines={1}>{block.seconds ? `Thinking · ${block.seconds}s` : "Thinking"}</Txt>
            {block.text ? <Pressable accessibilityLabel="Copy reasoning" onPress={onCopy} hitSlop={8} style={s.actionButton}><Icon name={copied ? "Check" : "Copy"} size={13} color={copied ? colors.add : colors.textSubtle} /></Pressable> : null}
            <Text style={s.chev}>{expanded ? "▾" : "▸"}</Text>
          </View>
          {expanded ? <View style={s.toolOutput}><Text style={s.toolOutputText}>{block.text}</Text></View> : null}
        </Pressable>
      );
    case "notice": {
      const c = block.level === "error" ? colors.del : block.level === "warn" ? colors.notice : colors.muted;
      return (
        <View style={s.notice}>
          <Txt variant="ui" color={c} style={s.noticeText}>{block.text}</Txt>
        </View>
      );
    }
  }
}

function blockText(block: Block): string {
  if (block.kind === "assistant" || block.kind === "thinking" || block.kind === "user") return block.text;
  if (block.kind === "tool") return block.output.join("\n");
  return block.text;
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function renderSources(body: string, colors: ReturnType<typeof useTheme>["colors"], s: ReturnType<typeof makeStyles>) {
  const items = parseSources(body);
  if (items.length === 0) return <Text style={s.toolOutputText}>{body}</Text>;
  return (
    <View style={{ gap: T.sXs }}>
      {items.map((src, i) => {
        const safe = src.url ? safeExternalUrl(src.url) : null;
        return (
          <Pressable key={i} onPress={() => { if (safe) Linking.openURL(safe).catch(() => undefined); }} style={({ pressed }) => [s.sourceCard, pressed && { opacity: 0.7 }]}>
            <View style={{ flexDirection: "row", gap: T.sXs, alignItems: "flex-start" }}>
              <Text style={s.sourceIdx}>{String(i + 1).padStart(2, "0")}</Text>
              <View style={{ flex: 1 }}>
                <Txt variant="ui" color={safe ? colors.user : colors.assistant} numberOfLines={1}>{src.title}</Txt>
                {src.domain ? <Txt variant="caption" color={colors.textSubtle}>{src.domain}</Txt> : null}
                {src.snippet ? <Txt variant="caption" color={colors.textSecondary} numberOfLines={3}>{src.snippet}</Txt> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    userStack: { alignItems: "flex-end", marginBottom: T.sSm },
    userBubble: { maxWidth: "88%", backgroundColor: colors.bubbleUserBg, borderRadius: T.radiusXl, paddingHorizontal: T.sBase, paddingVertical: T.sSm, borderWidth: 1, borderColor: colors.bubbleUserBorder },
    userText: { color: colors.assistant, fontSize: T.textProse, lineHeight: T.textProse * 1.6, letterSpacing: T.trackingUi },
    messageActions: { minHeight: 26, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingTop: T.s2xs, paddingHorizontal: T.s2xs },
    assistantActions: { minHeight: 26, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingTop: T.s2xs },
    actionButton: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: T.radiusSm },
    assistant: { marginBottom: T.sSm },
    gap: { height: T.sSm },
    cursor: { color: colors.accent, fontFamily: "SF Mono", fontSize: T.textCode },
    tool: { borderRadius: T.radiusSm, paddingHorizontal: T.sXs, paddingVertical: 3, marginBottom: 2, minHeight: 30 },
    toolHead: { flexDirection: "row", alignItems: "center", gap: T.sXs, minHeight: 30 },
    toolGlyph: { fontFamily: "SF Mono", fontSize: T.textCaption },
    chev: { color: colors.textSubtle, fontFamily: "SF Mono", fontSize: T.textCaption, opacity: 0.72 },
    toolOutput: { marginTop: T.sXs, backgroundColor: colors.panel, borderRadius: T.radiusXs, padding: T.sXs },
    toolOutputText: { color: colors.textSecondary, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * T.leadingCode },
    sourceCard: { backgroundColor: colors.panel, borderRadius: T.radiusSm, padding: T.sXs, borderWidth: 1, borderColor: colors.borderSoft, ...shadowFloat(colors) },
    sourceIdx: { color: colors.textSubtle, fontFamily: "SF Mono", fontSize: T.textCaption },
    thinkingRow: { borderRadius: T.radiusSm, paddingHorizontal: T.sXs, paddingVertical: 3, marginBottom: 2, minHeight: 30 },
    thinkGlyph: { color: colors.plan, fontFamily: "SF Mono", fontSize: T.textCaption },
    thinking: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sXs, paddingVertical: 3, minHeight: 30, opacity: 0.82 },
    thinkingDot: { color: colors.plan, fontFamily: "SF Mono", fontSize: T.textCaption },
    notice: { marginHorizontal: "auto", marginVertical: T.sXs, paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderRadius: T.radiusMd, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle, maxWidth: "100%" },
    noticeText: { lineHeight: T.textUi * 1.5 },
  });
}

export { IconButton };
