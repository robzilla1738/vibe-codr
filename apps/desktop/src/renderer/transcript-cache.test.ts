import { describe, expect, test } from "vitest";
import { initialTranscript, reduceTranscript } from "../shared/reducer";
import {
  decodeTranscriptCacheRecord,
  deleteTranscriptCache,
  deleteTranscriptCachesForCwd,
  loadTranscriptCache,
  saveTranscriptCache,
  transcriptCacheKeyBelongsToCwd,
  transcriptCacheRecordSize,
  transcriptContentSignature,
  transcriptConversationSignature,
} from "./transcript-cache";

function cacheRecord(state: ReturnType<typeof initialTranscript>) {
  const serialized = JSON.stringify(state);
  return {
    key: "/repo\u0000s1",
    savedAt: 1,
    signature: transcriptContentSignature(state),
    state: serialized,
    size: serialized.length,
  };
}

describe("transcriptContentSignature", () => {
  test("ignores presentation state but detects all authoritative content changes", () => {
    let state = reduceTranscript(initialTranscript(), { type: "user", text: "Build it" });
    state = reduceTranscript(state, { type: "delta", text: "Done" });
    state = reduceTranscript(state, { type: "finalize" });
    const baseline = transcriptContentSignature(state);
    const withThinking = reduceTranscript(state, { type: "thinking", text: "Reasoning" });
    expect(transcriptContentSignature(withThinking)).not.toBe(baseline);
    expect(transcriptContentSignature({
      ...state,
      blocks: state.blocks.map((block) => ({ ...block, id: block.id + 10 })),
    })).toBe(baseline);
    expect(transcriptContentSignature({
      ...withThinking,
      blocks: withThinking.blocks.map((block) =>
        block.kind === "thinking" ? { ...block, seconds: 42, collapsed: false } : block
      ),
    })).toBe(transcriptContentSignature(withThinking));
    const changed = reduceTranscript(state, { type: "delta", text: "More" });
    expect(transcriptContentSignature(changed)).not.toBe(baseline);
    expect(transcriptContentSignature({
      ...state,
      changedFiles: [{ path: "src/app.ts", added: 1, removed: 0, diff: "+new" }],
    })).not.toBe(baseline);
  });

  test("round-trips an explicitly unknown historical line count", () => {
    const state = {
      ...initialTranscript(),
      changedFiles: [{ path: "src/app.ts", added: 0, removed: 0, countsKnown: false }],
    };
    const encoded = JSON.stringify(state);
    expect(decodeTranscriptCacheRecord({
      key: "/repo\u0000s",
      savedAt: 1,
      signature: transcriptContentSignature(state),
      state: encoded,
      size: encoded.length,
    })?.changedFiles[0]?.countsKnown).toBe(false);
  });
});

describe("transcriptConversationSignature", () => {
  test("ignores non-reconstructible file chrome but validates authoritative tool content", () => {
    let authoritative = reduceTranscript(initialTranscript(), { type: "user", text: "Build it" });
    authoritative = reduceTranscript(authoritative, { type: "delta", text: "Done" });
    authoritative = reduceTranscript(authoritative, { type: "finalize" });
    const cached = reduceTranscript(authoritative, {
      type: "notice",
      text: "Checkpoint created",
      level: "info",
    });
    expect(transcriptConversationSignature(cached)).toBe(
      transcriptConversationSignature(authoritative),
    );
    expect(transcriptConversationSignature({
      ...cached,
      changedFiles: [{ path: "src/app.ts", added: 1, removed: 0, diff: "+new" }],
    })).toBe(transcriptConversationSignature(authoritative));
    let withTool = reduceTranscript(authoritative, {
      type: "tool-start",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "src/app.ts" },
    });
    withTool = reduceTranscript(withTool, {
      type: "tool-finish",
      toolCallId: "call-1",
      output: "original",
      isError: false,
    });
    const alteredTool = {
      ...withTool,
      blocks: withTool.blocks.map((block) =>
        block.kind === "tool" ? { ...block, output: ["altered"] } : block
      ),
    };
    expect(transcriptConversationSignature(alteredTool)).not.toBe(
      transcriptConversationSignature(withTool),
    );
    const foldedDiff = reduceTranscript(withTool, {
      type: "file-changed",
      toolCallId: "missing-call",
      path: "src/app.ts",
      action: "edit",
      added: 1,
      removed: 1,
      diff: "-old\n+new",
    });
    expect(transcriptConversationSignature(foldedDiff)).toBe(
      transcriptConversationSignature(withTool),
    );
    expect(
      transcriptConversationSignature(
        reduceTranscript(authoritative, { type: "delta", text: "Different" }),
      ),
    ).not.toBe(transcriptConversationSignature(authoritative));
  });
});

describe("transcript cache key ownership", () => {
  test("matches only session records for the exact cwd", () => {
    expect(transcriptCacheKeyBelongsToCwd("/repo\u0000ses_1", "/repo")).toBe(true);
    expect(transcriptCacheKeyBelongsToCwd("/repo-two\u0000ses_1", "/repo")).toBe(false);
  });
});

describe("transcript cache eviction metadata", () => {
  test("rejects corrupt rows without dereferencing invalid state", () => {
    expect(transcriptCacheRecordSize(null)).toBeNull();
    expect(transcriptCacheRecordSize({ state: 42 })).toBeNull();
    expect(transcriptCacheRecordSize({ state: "abc", size: -1 })).toBeNull();
    expect(transcriptCacheRecordSize({ state: "abc", size: 2 })).toBeNull();
    expect(transcriptCacheRecordSize({ state: "abc" })).toBe(3);
    expect(transcriptCacheRecordSize({ state: "abc", size: 3 })).toBe(3);
  });
});

describe("transcript cache decoding", () => {
  test("accepts a settled cache and rejects impossible block shapes", () => {
    const valid = reduceTranscript(initialTranscript(), { type: "user", text: "hello" });
    expect(decodeTranscriptCacheRecord(cacheRecord(valid))).toEqual(valid);

    const invalid = {
      ...valid,
      blocks: [{ kind: "future-corrupt-kind", id: 0 }],
    };
    expect(decodeTranscriptCacheRecord({
      ...cacheRecord(valid),
      state: JSON.stringify(invalid),
      size: JSON.stringify(invalid).length,
      signature: "forged",
    })).toBeNull();
  });

  test("rejects inconsistent record size before accepting content", () => {
    const state = initialTranscript();
    expect(decodeTranscriptCacheRecord({ ...cacheRecord(state), size: 1 })).toBeNull();
  });

  test("fails closed when IndexedDB is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open: () => { throw new DOMException("blocked", "SecurityError"); } },
    });
    try {
      await expect(loadTranscriptCache("/repo", "s1")).resolves.toBeNull();
      await expect(saveTranscriptCache("/repo", "s1", initialTranscript())).resolves.toBeUndefined();
      await expect(deleteTranscriptCache("/repo", "s1")).resolves.toBeUndefined();
      await expect(deleteTranscriptCachesForCwd("/repo")).resolves.toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    }
  });
});
