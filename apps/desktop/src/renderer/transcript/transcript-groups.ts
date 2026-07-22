import type { Block } from "../../shared/reducer";

export type ProcessSummary = {
  tools: number;
  subagents: number;
  failures: number;
  sources: number;
  durationMs: number;
};

export type TranscriptItemGroup =
  | { kind: "block"; block: Block }
  | { kind: "process"; blocks: Block[]; summary: ProcessSummary };

function isFinalAnswer(block: Block): boolean {
  return block.kind === "assistant" && block.phase !== "commentary" && Boolean(block.text.trim());
}

function summarizeProcess(blocks: readonly Block[], turnDurationMs?: number): ProcessSummary {
  const tools = blocks.filter((block) => block.kind === "tool");
  return {
    tools: tools.length,
    subagents: tools.filter((block) => /subagent|agent/i.test(block.toolName ?? "")).length,
    failures: tools.filter((block) => block.isError).length,
    sources: tools.reduce((count, block) => {
      if (!block.isSources) return count;
      return count + block.output.filter((line) => /^\d+\.\s/.test(line)).length;
    }, 0),
    durationMs: turnDurationMs
      ?? tools.reduce((total, block) => total + (block.elapsedMs ?? 0), 0),
  };
}

/**
 * Live turns keep every event in exact arrival order. Once a final answer lands,
 * the process that led to it becomes one disclosure while the outcome and any
 * following evidence notices remain first-class. Nothing is discarded.
 */
export function groupTranscriptItems(
  items: Block[],
  visibleStart = 0,
  compactCompleted = false,
): TranscriptItemGroup[] {
  const visible = items.slice(Math.max(0, visibleStart));
  if (!compactCompleted) return visible.map((block) => ({ kind: "block", block }));

  const finalIndex = visible.findIndex(isFinalAnswer);
  if (finalIndex <= 0) return visible.map((block) => ({ kind: "block", block }));

  const process = visible.slice(0, finalIndex);
  const finalAnswer = visible[finalIndex];
  return [
    {
      kind: "process",
      blocks: process,
      summary: summarizeProcess(process, finalAnswer?.turnDurationMs),
    },
    ...visible.slice(finalIndex).map((block): TranscriptItemGroup => ({ kind: "block", block })),
  ];
}
