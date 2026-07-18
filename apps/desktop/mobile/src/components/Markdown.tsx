// Focused markdown renderer for the mobile transcript. Handles the subset the
// vibe-codr engine emits (fenced code, inline code, bold/italic, headings,
// lists, blockquotes, links, tables-as-text) with native typography and the
// token-first palette. Code uses the mono face; prose uses the sans voice.
import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";

export function Markdown({ text }: { text: string }) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <View>{blocks.map((b, i) => renderBlock(b, i, colors))}</View>;
}

type Block =
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "p"; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) { code.push(lines[i]!); i++; }
      i++; // closing fence
      out.push({ kind: "code", lang, lines: code });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)!;
      out.push({ kind: "heading", level: m[1]!.length, text: m[2]! }); i++; continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) { quote.push(lines[i]!.slice(2)); i++; }
      out.push({ kind: "quote", lines: quote }); continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*[-*]\s+/, "")); i++; }
      out.push({ kind: "ul", items }); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push({ kind: "ol", items }); continue;
    }
    if (line.includes("|") && (line.match(/\|/g)?.length ?? 0) >= 2 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      const rows: string[][] = [];
      rows.push(splitRow(line)); i++;
      i++; // separator
      while (i < lines.length && lines[i]!.includes("|")) { rows.push(splitRow(lines[i]!)); i++; }
      out.push({ kind: "table", rows }); continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,6}\s|>\s|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) { para.push(lines[i]!); i++; }
    out.push({ kind: "p", text: para.join("\n") });
  }
  return out;
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function renderBlock(b: Block, key: number, colors: ReturnType<typeof useTheme>["colors"]): ReactNode {
  const s = makeStyles(colors);
  switch (b.kind) {
    case "code":
      return (
        <View key={key} style={s.code}>
          <Text style={s.codeText}>{b.lines.join("\n")}</Text>
        </View>
      );
    case "heading": {
      const size = b.level <= 2 ? T.textHeading : b.level === 3 ? T.textTitle : T.textUi;
      return <Text key={key} style={[s.heading, { fontSize: size, color: colors.heading }]}>{inline(b.text, colors, s)}</Text>;
    }
    case "quote":
      return <View key={key} style={s.quote}>{b.lines.map((l, i) => <Text key={i} style={s.quoteText}>{inline(l, colors, s)}</Text>)}</View>;
    case "ul":
      return <View key={key}>{b.items.map((it, i) => <Text key={i} style={s.li}>{"•  "}{inline(it, colors, s)}</Text>)}</View>;
    case "ol":
      return <View key={key}>{b.items.map((it, i) => <Text key={i} style={s.li}>{`${i + 1}.  `}{inline(it, colors, s)}</Text>)}</View>;
    case "table":
      return (
        <View key={key} style={s.table}>
          {b.rows.map((row, ri) => (
            <View key={ri} style={[s.tableRow, ri === 0 && s.tableHead]}>
              {row.map((cell, ci) => <Text key={ci} style={[s.tableCell, ri === 0 && s.tableHeadCell]}>{cell}</Text>)}
            </View>
          ))}
        </View>
      );
    case "p":
      return <Text key={key} style={s.p}>{inline(b.text, colors, s)}</Text>;
  }
}

// Inline formatting: `code`, **bold**, *italic*, [text](url).
function inline(text: string, colors: ReturnType<typeof useTheme>["colors"], s: ReturnType<typeof makeStyles>): ReactNode {
  const nodes: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Text key={k++}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<Text key={k++} style={s.inlineCode}>{tok.slice(1, -1)}</Text>);
    else if (tok.startsWith("**")) nodes.push(<Text key={k++} style={s.bold}>{tok.slice(2, -2)}</Text>);
    else if (tok.startsWith("*")) nodes.push(<Text key={k++} style={s.italic}>{tok.slice(1, -1)}</Text>);
    else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<Text key={k++} style={s.link}>{mm[1]}</Text>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Text key={k++}>{text.slice(last)}</Text>);
  return nodes as ReactNode;
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    p: { color: colors.assistant, fontSize: T.textProse, lineHeight: T.textProse * T.leadingProse, marginBottom: T.sXs },
    heading: { fontWeight: "600" as const, marginBottom: T.sXs, letterSpacing: T.trackingTight },
    code: { backgroundColor: colors.panel, borderRadius: T.radiusSm, padding: T.sSm, marginBottom: T.sSm, borderWidth: 1, borderColor: colors.borderSoft },
    codeText: { color: colors.code, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * T.leadingCode },
    inlineCode: { color: colors.code, fontFamily: "SF Mono", fontSize: T.textCode, backgroundColor: colors.panel, paddingHorizontal: 3, borderRadius: 3 },
    bold: { fontWeight: "600" as const, color: colors.assistant },
    italic: { fontStyle: "italic" as const, color: colors.assistant },
    link: { color: colors.user, textDecorationLine: "underline" as const },
    quote: { borderLeftWidth: 2, borderLeftColor: colors.gutter, paddingLeft: T.sSm, marginBottom: T.sSm },
    quoteText: { color: colors.textSecondary, fontSize: T.textProse, lineHeight: T.textProse * T.leadingProse },
    li: { color: colors.assistant, fontSize: T.textProse, lineHeight: T.textProse * T.leadingProse, marginBottom: T.s2xs },
    table: { borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusSm, marginBottom: T.sSm, overflow: "hidden" },
    tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    tableHead: { backgroundColor: colors.surfaceSubtle },
    tableCell: { flex: 1, padding: T.sXs, color: colors.assistant, fontSize: T.textUi },
    tableHeadCell: { color: colors.heading, fontWeight: "600" as const },
  });
}
