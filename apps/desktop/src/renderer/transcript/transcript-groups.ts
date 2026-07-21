import type { Block } from "../../shared/reducer";

export type TranscriptItemGroup = { kind: "block"; block: Block };

/** Keep every transcript event first-class and in arrival order. Reasoning and
 * tool output own their individual disclosures; assistant commentary must
 * never disappear inside a turn-wide "Work" container. */
export function groupTranscriptItems(items: Block[], visibleStart = 0): TranscriptItemGroup[] {
  return items.slice(Math.max(0, visibleStart)).map((block) => ({ kind: "block", block }));
}
