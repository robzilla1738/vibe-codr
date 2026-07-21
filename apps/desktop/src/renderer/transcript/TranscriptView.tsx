import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  showThinkingRows,
  type TranscriptDensity,
  thinkingCollapsed,
  toolCollapsed,
} from "../../shared/density";
import type { Block, Turn } from "../../shared/reducer";
import { collapsedHint, toolDurationLabel } from "../../shared/reducer";
import { isScrollAnchored } from "../../shared/scroll-anchor";
import { parseSearchResults } from "../../shared/sources";
import { TtlLruCache } from "../../shared/ttl-lru-cache";
import { CopyButton } from "../CopyButton";
import { IconCheck, IconChevron, IconContinue, IconRename } from "../icons";
import { StatusDot } from "../primitives";
import { isSubagentTool, stripToolGlyph, ToolGlyph } from "../tool-glyph";
import { MarkdownView } from "./MarkdownView";
import { SourceList } from "./SourceList";
import { groupTranscriptItems, type ProcessSummary } from "./transcript-groups";

/** Keep each session's reading position while the app remains open. A fresh
 * launch intentionally starts at the latest content instead of restoring a
 * potentially stale offset from disk. */
const sessionScrollPositions = new TtlLruCache<string, number>(
  128,
  24 * 60 * 60 * 1_000,
);
const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** JS smooth-scroll must honor the OS reduced-motion setting (I19/P04); CSS
 *  `scroll-behavior: smooth` is already disabled by the media query, but
 *  `scrollTo({ behavior: "smooth" })` is not. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

function scrollBehavior(pref: ScrollBehavior): ScrollBehavior {
  return pref === "smooth" && prefersReducedMotion() ? "auto" : pref;
}

function formatMessageTime(timestamp: number): string {
  return messageTimeFormatter.format(timestamp);
}

function processSummaryLabel(summary: ProcessSummary): string {
  const parts: string[] = [];
  if (summary.durationMs >= 1_000) {
    const seconds = Math.max(1, Math.round(summary.durationMs / 1_000));
    parts.push(`Worked ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}`);
  } else {
    parts.push("Process");
  }
  if (summary.tools > 0) parts.push(`${summary.tools} tool${summary.tools === 1 ? "" : "s"}`);
  if (summary.subagents > 0) parts.push(`${summary.subagents} agent${summary.subagents === 1 ? "" : "s"}`);
  if (summary.sources > 0) parts.push(`${summary.sources} source${summary.sources === 1 ? "" : "s"}`);
  if (summary.failures > 0) parts.push(`${summary.failures} failed`);
  return parts.join(" · ");
}

function memoryNotice(text: string): { count: string; details: string[] } | null {
  const match = text.match(
    /^Recalled\s+(\d+)\s+prior note\(s\)(?:\s*\([^)]*\))?:\s*([\s\S]*)$/i,
  );
  if (!match) return null;
  return {
    count: match[1] ?? "0",
    details: (match[2] ?? "")
      .split(/\s*##\s*/)
      .map((detail) => detail.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  };
}

function multilineNotice(text: string): { summary: string; detail: string } | null {
  const [summary = "", ...rest] = text.split("\n");
  const detail = rest.join("\n").trim();
  return summary.trim() && detail ? { summary: summary.trim(), detail } : null;
}

function gateStatusNotice(text: string): { tone: "success" | "warning" | "neutral"; label: string; meta: string } | null {
  const match = /^Gate:\s*(GREEN|RED|UNVERIFIED|ABORTED)(?:\s+—\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;
  const outcome = match[1]!.toUpperCase();
  return {
    tone: outcome === "GREEN" ? "success" : outcome === "RED" ? "warning" : "neutral",
    label: outcome === "GREEN" ? "Checks passed" : outcome === "RED" ? "Checks failed" : `Checks ${outcome.toLowerCase()}`,
    meta: (match[2] ?? "").replace(/\s*✓/g, "").trim(),
  };
}

function visualStatusNotice(text: string): {
  consoleErrors: number;
  deadControls: number;
  detail: string;
} | null {
  const match = /^Visual check:\s*rendered OK,\s*(\d+)\s+console errors?,\s*(\d+)\s+dead controls?:?\s*(?:\n([\s\S]+))?$/i.exec(text.trim());
  if (!match) return null;
  return {
    consoleErrors: Number(match[1]),
    deadControls: Number(match[2]),
    detail: (match[3] ?? "").trim(),
  };
}

function DiffBody({ lines }: { lines: string[] }) {
  const text = lines.join("\n");
  return (
    <div className="tool-body has-copy">
      <CopyButton text={text} label="Copy diff" />
      {lines.map((line, i) => {
        const cls = line.startsWith("+")
          ? "diff-add"
          : line.startsWith("-")
            ? "diff-del"
            : line.startsWith("@@")
              ? "diff-hunk"
              : undefined;
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function PlainToolBody({
  id,
  text,
  children,
}: {
  id?: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-body has-copy" id={id}>
      {text ? <CopyButton text={text} label="Copy output" /> : null}
      {children}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  density,
  theme,
  now,
  onSetExpanded,
  onReviewDiff,
}: {
  block: Block;
  density: TranscriptDensity;
  theme: string;
  now: number;
  onSetExpanded: (id: number, expanded: boolean) => void;
  onReviewDiff?: () => void;
}) {
  switch (block.kind) {
    case "assistant": {
      const commentary = block.phase === "commentary";
      return (
        <div className={`block-assistant${commentary ? " is-commentary" : " is-final"}${!commentary && !block.streaming && block.text ? " has-actions" : ""}${block.streaming ? " streaming" : ""}`}>
          <div className="md">
            <MarkdownView streaming={block.streaming} theme={theme}>
              {block.text}
            </MarkdownView>
          </div>
          {!commentary && !block.streaming && block.text ? (
            <div className="assistant-actions hover-reveal" role="toolbar" aria-label="Assistant message actions">
              <CopyButton text={block.text} label="Copy answer" />
              <time className="message-time" dateTime={new Date(block.timestamp).toISOString()}>
                {formatMessageTime(block.timestamp)}
              </time>
            </div>
          ) : null}
        </div>
      );
    }
    case "tool": {
      const collapsed = toolCollapsed(density, block);
      const expandable = block.output.length > 0;
      const dur = toolDurationLabel(block, now);
      const outputText = block.output.join("\n");
      if (isSubagentTool(block.toolName)) {
        const label = stripToolGlyph(block.label);
        return (
          <div className="tool-row subagent-row">
            <button
              type="button"
              className={`tool-head subagent-head${block.isError ? " error" : ""}${!block.done ? " live" : ""}`}
              onClick={() => onSetExpanded(block.id, collapsed)}
              aria-expanded={!collapsed}
              aria-controls={`tool-body-${block.id}`}
              aria-label={`Subagent ${label}, ${block.done ? "done" : "running"}`}
            >
              <span className="tool-label">
                <IconChevron open={!collapsed} size={13} />
                <StatusDot status={block.done ? "done" : "running"} />
                <span>{label}</span>
              </span>
              <span className="tool-meta">
                {!block.done && block.tail ? " …" : ""}
                {dur ? ` ${dur}` : ""}
              </span>
            </button>
            {!collapsed && (outputText || block.tail) ? (
              <PlainToolBody id={`tool-body-${block.id}`} text={outputText || block.tail || ""}>
                {block.isMarkdown && outputText ? (
                  <div className="md"><MarkdownView theme={theme}>{outputText}</MarkdownView></div>
                ) : outputText || block.tail}
              </PlainToolBody>
            ) : null}
          </div>
        );
      }
      return (
        <div className="tool-row">
          {expandable ? (
            <button
              type="button"
              className={`tool-head${block.isError ? " error" : ""}${!block.done ? " live" : ""}`}
              onClick={() => onSetExpanded(block.id, collapsed)}
              aria-expanded={!collapsed}
              aria-controls={`tool-body-${block.id}`}
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${block.label}`}
            >
              <span className="tool-label">
                <IconChevron open={!collapsed} size={13} />
                <ToolGlyph toolName={block.toolName} />
                <span>{stripToolGlyph(block.label)}</span>
              </span>
              <span className="tool-meta">
                {collapsed && block.done ? collapsedHint(block) : ""}
                {!block.done && block.tail ? " …" : ""}
                {dur ? ` ${dur}` : ""}
              </span>
            </button>
          ) : (
            <div
              className={`tool-head is-static${block.isError ? " error" : ""}${!block.done ? " live" : ""}`}
              role="status"
              aria-label={`${stripToolGlyph(block.label)}, ${block.done ? block.isError ? "failed with no output" : "completed with no output" : "running"}`}
            >
              <span className="tool-label">
                <span className="tool-disclosure-dot" aria-hidden>·</span>
                <ToolGlyph toolName={block.toolName} />
                <span>{stripToolGlyph(block.label)}</span>
              </span>
              <span className="tool-meta">
                {block.done ? (block.isError ? "failed · no output" : "done · no output") : "running"}
                {dur ? ` ${dur}` : ""}
              </span>
            </div>
          )}
          {!collapsed && block.isDiff && (
            <div id={`tool-body-${block.id}`}>
              <DiffBody lines={block.output} />
              {onReviewDiff ? (
                <button type="button" className="tool-artifact-open" onClick={onReviewDiff}>
                  Open in Changes
                </button>
              ) : null}
            </div>
          )}
          {!collapsed && !block.isDiff && block.output.length > 0 && (
            <PlainToolBody
              id={`tool-body-${block.id}`}
              text={block.isSources ? "" : outputText}
            >
              {block.isSources ? (
                <SourceList sources={parseSearchResults(outputText)} />
              ) : block.isMarkdown ? (
                <div className="md">
                  <MarkdownView theme={theme}>{outputText}</MarkdownView>
                </div>
              ) : (
                outputText
              )}
            </PlainToolBody>
          )}
          {!block.done && block.tail && (
            <PlainToolBody
              id={collapsed || block.output.length === 0 ? `tool-body-${block.id}` : undefined}
              text={block.tail.slice(-400)}
            >
              {block.tail.slice(-400)}
            </PlainToolBody>
          )}
        </div>
      );
    }
    case "thinking": {
      if (!showThinkingRows(density)) return null;
      const collapsed = thinkingCollapsed(density, block.collapsed, block.expandedOverride);
      const label =
        block.seconds != null && block.seconds >= 1
          ? `Thought for ${block.seconds}s`
          : "Thinking";
      const text = block.text?.replace(/^\s+/, "") ?? "";
      return (
        <div className={`thinking-row${!collapsed ? " is-open" : ""}`}>
          <div className="thinking-head-row">
            <button
              type="button"
              className="thinking-head"
              onClick={() => onSetExpanded(block.id, collapsed)}
              aria-expanded={!collapsed}
              aria-controls={`thinking-body-${block.id}`}
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
            >
              <span className="thinking-label">
                <IconChevron open={!collapsed} size={13} />
                <span>{label}</span>
              </span>
            </button>
            {!collapsed && text ? (
              <CopyButton text={text} label="Copy thinking" className="thinking-copy" />
            ) : null}
          </div>
          {!collapsed && text ? (
            <div className="thinking-body" id={`thinking-body-${block.id}`}>
              {text}
            </div>
          ) : null}
        </div>
      );
    }
    case "notice":
      {
        const memory = memoryNotice(block.text);
        if (!memory) {
          const gate = gateStatusNotice(block.text);
          if (gate) {
            return (
              <div className={`status-notice is-${gate.tone}`} role="status">
                <span className="status-notice-mark" aria-hidden>
                  {gate.tone === "success" ? <IconCheck size={12} strokeWidth={2.2} /> : null}
                </span>
                <span className="status-notice-label">{gate.label}</span>
                {gate.meta ? <span className="status-notice-meta">{gate.meta}</span> : null}
              </div>
            );
          }
          const visual = visualStatusNotice(block.text);
          if (visual) {
            const hasIssues = visual.consoleErrors > 0 || visual.deadControls > 0;
            const meta = `Rendered · ${visual.consoleErrors} console ${visual.consoleErrors === 1 ? "error" : "errors"} · ${visual.deadControls} dead ${visual.deadControls === 1 ? "control" : "controls"}`;
            if (!visual.detail) {
              return (
                <div className={`status-notice is-${hasIssues ? "warning" : "success"}`} role="status">
                  <span className="status-notice-mark" aria-hidden>
                    {!hasIssues ? <IconCheck size={12} strokeWidth={2.2} /> : null}
                  </span>
                  <span className="status-notice-label">Visual check</span>
                  <span className="status-notice-meta">{meta}</span>
                </div>
              );
            }
            return (
              <details className={`status-notice status-notice-details is-${hasIssues ? "warning" : "success"}`} role="status">
                <summary className="status-notice-summary">
                  <span className="status-notice-mark" aria-hidden>
                    {!hasIssues ? <IconCheck size={12} strokeWidth={2.2} /> : null}
                  </span>
                  <span className="status-notice-label">Visual check</span>
                  <span className="status-notice-meta">{meta}</span>
                  <span className="status-notice-chevron" aria-hidden><IconChevron size={12} /></span>
                </summary>
                <div className="status-notice-detail">{visual.detail}</div>
              </details>
            );
          }
          const warning = block.level === "warn" ? multilineNotice(block.text) : null;
          if (warning) {
            return (
              <details className="notice warn warning-notice" role="status">
                <summary className="warning-notice-toggle">
                  <span className="warning-notice-chevron" aria-hidden="true">
                    <IconChevron size={12} />
                  </span>
                  <span>{warning.summary}</span>
                </summary>
                <div className="warning-notice-detail">{warning.detail}</div>
              </details>
            );
          }
          return (
            <div className={`notice ${block.level}`} role={block.level === "error" ? "alert" : "status"}>
              {block.text}
            </div>
          );
        }
        return (
          <details className={`notice ${block.level} memory-notice`} role="status">
            <summary className="memory-notice-toggle">
              <span className="memory-notice-chevron" aria-hidden="true">
                <IconChevron size={13} />
              </span>
              <span className="memory-notice-title">Memory</span>
              <span className="memory-notice-count">
                {memory.count} {memory.count === "1" ? "note" : "notes"}
              </span>
            </summary>
            {memory.details.length > 0 ? (
              <ul className="memory-notice-detail">
                {memory.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
              </ul>
            ) : null}
          </details>
        );
      }
    default:
      return null;
  }
});

const TranscriptTurn = memo(function TranscriptTurn({
  turn, folded, itemStart, itemHidden, itemRevealPage, active, liveThinking, density, theme, now,
  onSetBlockExpanded, onToggleTurn, onEdit, onRevealTurnItems, onReviewDiff,
}: {
  turn: Turn; folded: boolean; itemStart: number; itemHidden: number; itemRevealPage: number;
  active: boolean; liveThinking?: string; density: TranscriptDensity; theme: string; now: number;
  onSetBlockExpanded: (id: number, expanded: boolean) => void; onToggleTurn: (key: number) => void;
  onEdit: (text: string) => void; onRevealTurnItems: (turnKey: number, hidden: number) => void;
  onReviewDiff?: () => void;
}) {
  const [processOpen, setProcessOpen] = useState(false);
  useEffect(() => {
    setProcessOpen(active);
  }, [active, turn.key]);

  const renderBlock = (block: Block) => (
    <BlockView
      key={block.id}
      block={block}
      density={density}
      theme={theme}
      now={now}
      onSetExpanded={onSetBlockExpanded}
      onReviewDiff={onReviewDiff}
    />
  );
  const groupedItems = groupTranscriptItems(turn.items, itemStart, !active);
  const compactProcess = groupedItems.find((item) => item.kind === "process");
  const gateEvidence = turn.items
    .filter((block): block is Extract<Block, { kind: "notice" }> => block.kind === "notice")
    .map((block) => gateStatusNotice(block.text))
    .find(Boolean);
  const visualEvidence = turn.items
    .filter((block): block is Extract<Block, { kind: "notice" }> => block.kind === "notice")
    .map((block) => visualStatusNotice(block.text))
    .find(Boolean);
  const renderedItems = groupedItems.map((item) => {
    if (item.kind === "block") return renderBlock(item.block);
    const label = processSummaryLabel(item.summary);
    return (
      <details
        key={`process-${turn.key}`}
        className={`turn-process${item.summary.failures > 0 ? " has-failures" : ""}`}
        open={processOpen}
        onToggle={(event) => setProcessOpen(event.currentTarget.open)}
      >
        <summary className="turn-process-summary">
          <span className="turn-process-chevron" aria-hidden><IconChevron open={processOpen} size={13} /></span>
          <span>{label}</span>
        </summary>
        <div className="turn-process-items">{item.blocks.map(renderBlock)}</div>
      </details>
    );
  });
  return (
    <section className="turn" aria-label={turn.user?.origin === "engine" ? "Automatic follow-up turn" : turn.user ? "Conversation turn" : "Assistant activity"}>
      <div className="turn-content" id={`turn-items-${turn.key}`}>
        {turn.user?.origin === "engine" ? (
          <details className="block-automation">
            <summary className="block-automation-summary">
              <span className="block-automation-mark" aria-hidden><IconContinue size={13} /></span>
              <span>{turn.user.label ?? "Automatic follow-up"}</span>
              <span className="block-automation-hint">Engine context</span>
            </summary>
            <div className="block-automation-text">{turn.user.text}</div>
          </details>
        ) : turn.user ? (
          <div className="block-user-row"><div className="block-user-stack">
            <div className="block-user" role="button" tabIndex={0} aria-expanded={!folded}
              aria-controls={`turn-items-${turn.key}`} aria-label={folded ? "Expand user message" : "Collapse user message"}
              onClick={() => onToggleTurn(turn.key)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleTurn(turn.key); }
              }}>
              <span className="block-user-text">{turn.user.text}</span>
              {folded ? <span className="folded-hint">{turn.items.length} hidden</span> : null}
            </div>
            <div className="assistant-actions user-message-actions hover-reveal" role="toolbar" aria-label="User message actions">
              <CopyButton text={turn.user.text} label="Copy message" />
              <button type="button" className="assistant-action" onClick={(event) => { event.stopPropagation(); onEdit(turn.user!.text); }} aria-label="Edit message" title="Edit message"><IconRename size={13} /></button>
              <time className="message-time" dateTime={new Date(turn.user.timestamp).toISOString()}>{formatMessageTime(turn.user.timestamp)}</time>
            </div>
          </div></div>
        ) : null}
        {!folded && itemHidden > 0 && (
          <button type="button" className="earlier earlier-items" onClick={() => onRevealTurnItems(turn.key, itemHidden)}>
            Load {itemRevealPage} earlier item{itemRevealPage === 1 ? "" : "s"}<span className="earlier-meta"> · {itemHidden} hidden</span>
          </button>
        )}
        {!folded && renderedItems}
        {!folded && active && liveThinking && density !== "quiet" ? (
          <details className="thinking-row" open>
            <summary className="thinking-head">
              <span className="thinking-label"><IconChevron open size={13} />Thinking</span>
              <span className="thinking-meta">live</span>
            </summary>
            <div className="thinking-body">{liveThinking}</div>
          </details>
        ) : null}
        {!folded && !active && compactProcess ? (
          <button
            type="button"
            className={`turn-evidence${compactProcess.summary.failures > 0 || gateEvidence?.tone === "warning" ? " has-failures" : ""}`}
            onClick={() => setProcessOpen((open) => !open)}
            aria-expanded={processOpen}
          >
            <span className="turn-evidence-label">Evidence</span>
            <span className="turn-evidence-meta">
              {compactProcess.summary.tools} tool{compactProcess.summary.tools === 1 ? "" : "s"}
              {gateEvidence ? ` · ${gateEvidence.label}` : ""}
              {visualEvidence ? ` · visual check${visualEvidence.consoleErrors + visualEvidence.deadControls === 0 ? " passed" : " has issues"}` : ""}
              {compactProcess.summary.sources > 0 ? ` · ${compactProcess.summary.sources} source${compactProcess.summary.sources === 1 ? "" : "s"}` : ""}
            </span>
            <IconChevron open={processOpen} size={12} />
          </button>
        ) : null}
      </div>
    </section>
  );
});

export function TranscriptView({
  sessionId,
  turns,
  busy,
  liveThinking,
  hiddenCount,
  revealPage,
  foldedTurns,
  density,
  theme,
  itemWindowFor,
  onSetBlockExpanded,
  onToggleTurn,
  onEdit,
  onShowEarlier,
  onRevealTurnItems,
  followSignal,
  footerAccessory,
  onReviewDiff,
}: {
  sessionId: string;
  turns: Turn[];
  busy: boolean;
  liveThinking?: string;
  hiddenCount: number;
  revealPage: number;
  foldedTurns: Set<number>;
  density: TranscriptDensity;
  theme: string;
  itemWindowFor: (turnKey: number, itemCount: number) => {
    start: number;
    hidden: number;
    revealPage: number;
  };
  onSetBlockExpanded: (id: number, expanded: boolean) => void;
  onToggleTurn: (key: number) => void;
  onEdit: (text: string) => void;
  onShowEarlier: () => void;
  onRevealTurnItems: (turnKey: number, hidden: number) => void;
  followSignal: number;
  footerAccessory?: ReactNode;
  onReviewDiff?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoringSessionRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const [anchored, setAnchored] = useState(true);
  const [now, setNow] = useState(Date.now());
  const hasLiveTool = turns.some((turn) =>
    turn.items.some((block) => block.kind === "tool" && !block.done),
  );
  const latestTurnKey = turns.at(-1)?.key;

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: scrollBehavior(behavior) });
  };

  useEffect(() => {
    if (!hasLiveTool) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [hasLiveTool]);

  useEffect(() => {
    setAnchored(true);
    window.requestAnimationFrame(() => scrollToLatest("auto"));
  }, [followSignal]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !sessionId) return;
    restoringSessionRef.current = true;
    const savedTop = sessionScrollPositions.get(sessionId);
    element.scrollTop = savedTop ?? element.scrollHeight;
    setAnchored(savedTop == null || isScrollAnchored(element));
    const frame = window.requestAnimationFrame(() => {
      restoringSessionRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId]);

  useEffect(() => {
    if (restoringSessionRef.current) return;
    if (!anchored) return;
    if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollToLatest("auto");
    });
    return () => {
      if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [turns, foldedTurns, density, anchored]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    if (sessionId) sessionScrollPositions.set(sessionId, element.scrollTop);
    setAnchored(isScrollAnchored(element));
  };

  return (
    <div className="transcript-shell">
      <div
        className="transcript"
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="Conversation transcript"
      >
        <div className="transcript-content">
          {hiddenCount > 0 && (
            <button type="button" className="earlier" onClick={onShowEarlier}>
              <span className="earlier-label">
                Load {revealPage} earlier turn{revealPage === 1 ? "" : "s"}
              </span>
              <span className="earlier-meta">{hiddenCount} hidden</span>
            </button>
          )}
          {turns.map((turn) => {
            const folded = foldedTurns.has(turn.key);
            const itemWindow = itemWindowFor(turn.key, turn.items.length);
            const active = busy && turn.key === latestTurnKey;
            return (
              <TranscriptTurn
                key={turn.key}
                turn={turn} folded={folded} itemStart={itemWindow.start}
                itemHidden={itemWindow.hidden} itemRevealPage={itemWindow.revealPage}
                active={active} liveThinking={active ? liveThinking : undefined} density={density} theme={theme} now={active ? now : 0}
                onSetBlockExpanded={onSetBlockExpanded} onToggleTurn={onToggleTurn} onEdit={onEdit}
                onRevealTurnItems={onRevealTurnItems}
                onReviewDiff={onReviewDiff}
              />
            );
          })}
        </div>
      </div>
      {(!anchored || footerAccessory) && (
        <div className="transcript-footer-actions">
          {footerAccessory}
          {!anchored && (
            <button
              type="button"
              className="jump-latest"
              onClick={() => {
                setAnchored(true);
                scrollToLatest("smooth");
              }}
              aria-label="Jump to latest messages"
            >
              Jump to latest
            </button>
          )}
        </div>
      )}
    </div>
  );
}
