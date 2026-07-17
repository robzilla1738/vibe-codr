import type { Block } from "../../shared/reducer";

export type TranscriptItemGroup =
  | { kind: "activity"; blocks: Block[] }
  | { kind: "block"; block: Block };

function isActivityBlock(block: Block): boolean {
  return block.kind === "tool" || block.kind === "thinking";
}

/**
 * A turn may interleave short assistant progress notes with many reasoning and
 * tool bursts. Keep that whole work phase in one disclosure while leaving the
 * final answer outside it. This preserves event order without making every
 * model action look like a separate transcript section.
 */
export function groupTranscriptItems(items: Block[], visibleStart = 0): TranscriptItemGroup[] {
  const firstActivity = items.findIndex(isActivityBlock);
  if (firstActivity < 0) return items.slice(Math.max(0, visibleStart)).map((block) => ({ kind: "block", block }));

  let lastActivity = firstActivity;
  for (let index = items.length - 1; index > firstActivity; index -= 1) {
    if (isActivityBlock(items[index]!)) {
      lastActivity = index;
      break;
    }
  }

  const workPhase = items.slice(0, lastActivity + 1);
  const groups: TranscriptItemGroup[] = [
    { kind: "activity", blocks: workPhase },
    ...items.slice(lastActivity + 1).map((block) => ({ kind: "block" as const, block })),
  ];
  if (visibleStart <= 0) return groups;

  const visibleIds = new Set(items.slice(visibleStart).map((block) => block.id));
  return groups.flatMap((group): TranscriptItemGroup[] => {
    if (group.kind === "block") return visibleIds.has(group.block.id) ? [group] : [];
    const blocks = group.blocks.filter((block) => visibleIds.has(block.id));
    return blocks.length ? [{ kind: "activity", blocks }] : [];
  });
}
