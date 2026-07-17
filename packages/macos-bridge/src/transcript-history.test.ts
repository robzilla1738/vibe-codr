import { describe, expect, test } from "bun:test";
import type { PersistedSession } from "@vibe/core";
import { fitTranscriptPayload, structuredTranscript } from "./transcript-history.ts";

function session(modelUser = "Build it"): PersistedSession {
  return {
    meta: {
      id: "ses_test",
      model: "test/model",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    },
    history: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Build it" }], createdAt: 1 },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "flattened" }], createdAt: 2 },
    ],
    modelMessages: [
      { role: "user", content: modelUser },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Inspect first" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: { type: "text", value: "source" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ],
  } as PersistedSession;
}

describe("structuredTranscript", () => {
  test("restores reasoning and tool structure from persisted model messages", () => {
    expect(structuredTranscript(session())[1]?.parts).toEqual([
      { type: "reasoning", text: "Inspect first" },
      { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
      { type: "tool-result", toolCallId: "call_1", toolName: "read", output: "source" },
      { type: "text", text: "Done" },
    ]);
  });

  test("keeps the display history when turn alignment is uncertain", () => {
    const value = session("Different prompt");
    expect(structuredTranscript(value)).toBe(value.history);
    const prefixOnly = session("Build it more thoroughly");
    expect(structuredTranscript(prefixOnly)).toBe(prefixOnly.history);
  });

  test("restores string-form partial assistant replies", () => {
    const value = session();
    value.modelMessages = [
      value.modelMessages[0]!,
      { role: "assistant", content: "Partial reply before interruption" },
    ];
    expect(structuredTranscript(value)[1]?.parts).toEqual([
      { type: "text", text: "Partial reply before interruption" },
    ]);
  });

  test("restores provider-native tool failures as errors without guessing from text", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: { type: "text", value: "ERROR: permission denied" },
        },
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "write",
          output: { type: "error-text", value: "disk full" },
        },
      ],
    } as PersistedSession["modelMessages"][number];
    const results = structuredTranscript(value)[1]?.parts.filter(
      (part) => part.type === "tool-result",
    );
    expect(results).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "read",
        output: "ERROR: permission denied",
      },
      {
        type: "tool-result",
        toolCallId: "call_2",
        toolName: "write",
        output: "disk full",
        isError: true,
      },
    ]);
  });

  test("does not classify successful ERROR-prefixed output as a failure", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: { type: "text", value: "ERROR: this is quoted file content" },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    expect(result?.type === "tool-result" ? result.isError : undefined).toBeUndefined();
  });

  test("restores the aligned suffix after model-context compaction", () => {
    const value = session();
    value.history = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Old request" }], createdAt: 1 },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "Old answer" }], createdAt: 2 },
      ...value.history,
    ];
    value.modelMessages = [
      { role: "user", content: "Summary of older compacted context" },
      { role: "assistant", content: "Summary acknowledged" },
      ...value.modelMessages,
    ];
    const restored = structuredTranscript(value);
    expect(restored[1]?.parts).toEqual([{ type: "text", text: "Old answer" }]);
    expect(restored[3]?.parts.some((part) => part.type === "reasoning")).toBe(true);
  });

  test("aligns a prompt carrying a folded compaction summary", () => {
    const value = session("[Summary of earlier conversation]\nOlder context\n\nBuild it");
    expect(structuredTranscript(value)[1]?.parts.some((part) => part.type === "reasoning")).toBe(
      true,
    );
  });

  test("aligns a folded multi-paragraph prompt without guessing its final paragraph", () => {
    const value = session(
      "[Summary of earlier conversation]\nOlder context\n\nBuild the first section.\n\nThen verify it.",
    );
    value.history[0] = {
      ...value.history[0]!,
      parts: [{ type: "text", text: "Build the first section.\n\nThen verify it." }],
    };
    expect(structuredTranscript(value)[1]?.parts.some((part) => part.type === "reasoning")).toBe(
      true,
    );
  });

  test("aligns folded prompts joined to the summary by one newline", () => {
    const value = session("[Summary of earlier conversation]\nOlder context\nBuild it");
    expect(structuredTranscript(value)[1]?.parts.some((part) => part.type === "reasoning")).toBe(
      true,
    );
  });

  test("reconstructs flat turns while preserving already-structured turns", () => {
    const value = session();
    value.history.push(
      { id: "u2", role: "user", parts: [{ type: "text", text: "Second" }], createdAt: 3 },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Exact persisted reasoning" },
          { type: "text", text: "Second answer" },
        ],
        createdAt: 4,
      },
    );
    value.modelMessages.push(
      { role: "user", content: "Second" },
      { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
    );
    const restored = structuredTranscript(value);
    expect(restored[1]?.parts.some((part) => part.type === "reasoning")).toBe(true);
    expect(restored[3]?.parts).toEqual([
      { type: "reasoning", text: "Exact persisted reasoning" },
      { type: "text", text: "Second answer" },
    ]);
  });

  test("keeps compact goal-run display flat when its internal prompt cannot be proven", () => {
    const value = session("Full internal goal-run directive");
    value.history[0] = {
      ...value.history[0]!,
      parts: [{ type: "text", text: "★ goal — round 2/10: continue" }],
    };
    expect(structuredTranscript(value)[1]?.parts).toEqual([{ type: "text", text: "flattened" }]);
  });

  test("does not pair an engine-authored turn with a compaction summary", () => {
    const value = session("Summary of older compacted context");
    value.history[0] = {
      ...value.history[0]!,
      parts: [{ type: "text", text: "★ goal — round 2/10: continue" }],
      metadata: { origin: "engine", label: "Goal" },
    };
    value.modelMessages[0] = {
      role: "user",
      content: "[Summary of earlier conversation]\nSummary of older compacted context",
    };
    expect(structuredTranscript(value)[1]?.parts).toEqual([{ type: "text", text: "flattened" }]);
  });

  test("does not pair an engine-authored turn with a later persisted prompt", () => {
    const value = session("A later prompt written before the display history");
    value.history[0] = {
      ...value.history[0]!,
      parts: [{ type: "text", text: "★ goal — round 2/10: continue" }],
      metadata: { origin: "engine", label: "Goal run" },
    };
    expect(structuredTranscript(value)[1]?.parts).toEqual([{ type: "text", text: "flattened" }]);
  });

  test("keeps history flat when persisted messages are one repeated turn ahead", () => {
    const value = session("continue");
    value.history[0] = {
      ...value.history[0]!,
      parts: [{ type: "text", text: "continue" }],
    };
    value.modelMessages.push(
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "reasoning", text: "Newer reasoning" }] },
    );
    expect(structuredTranscript(value)[1]?.parts).toEqual([{ type: "text", text: "flattened" }]);
  });

  test("keeps duplicate display prompts flat when alignment is ambiguous", () => {
    const value = session("continue");
    value.history = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "continue" }], createdAt: 0 },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "Older" }], createdAt: 0 },
      { ...value.history[0]!, parts: [{ type: "text", text: "continue" }] },
      value.history[1]!,
    ];
    value.modelMessages = [
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "Older" }] },
      ...value.modelMessages,
    ];
    expect(structuredTranscript(value)[3]?.parts).toEqual([{ type: "text", text: "flattened" }]);
  });

  test("aligns image annotations when model-only workspace state is present", () => {
    const value = session();
    value.history[0] = {
      ...value.history[0]!,
      parts: [
        { type: "text", text: "Build it" },
        { type: "text", text: "[image: /tmp/design.png]" },
      ],
    };
    value.modelMessages[0] = {
      role: "user",
      content: [
        {
          type: "text",
          text: "Build it\n\n<workspace-state>\nTasks: t1\n</workspace-state>",
        },
        { type: "image", image: new Uint8Array([1]), mediaType: "image/png" },
      ],
    };
    expect(structuredTranscript(value)[1]?.parts.some((part) => part.type === "reasoning")).toBe(
      true,
    );
  });

  test("caps unwrapped JSON tool outputs", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: { type: "json", value: { payload: "x".repeat(600 * 1024) } },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    expect(result?.type === "tool-result" ? typeof result.output : null).toBe("string");
    expect(result?.type === "tool-result" ? String(result.output).length : 0).toBeLessThanOrEqual(
      512 * 1024,
    );
  });

  test("preserves wrapper-shaped values inside JSON output", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: { type: "json", value: { type: "text", value: "literal payload" } },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    expect(result?.type === "tool-result" ? result.output : null).toEqual({
      type: "text",
      value: "literal payload",
    });
  });

  test("removes nested media payloads from JSON output", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: {
            type: "json",
            value: {
              type: "content",
              value: [
                { type: "text", text: "Readable result" },
                { type: "media", data: "secret-binary", mediaType: "image/png" },
                {
                  type: "image-data",
                  data: "secret-image-data",
                  mediaType: "image/png",
                },
              ],
            },
          },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    const output = result?.type === "tool-result" ? result.output : null;
    expect(output).toEqual({
      type: "content",
      value: [{ type: "text", text: "Readable result" }, "[media omitted]", "[binary omitted]"],
    });
    expect(JSON.stringify(output)).not.toContain("secret-binary");
    expect(JSON.stringify(output)).not.toContain("secret-image-data");
  });

  test("preserves non-binary records that use a file discriminator", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: {
            type: "json",
            value: { type: "file", path: "src/a.ts", status: "changed" },
          },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    expect(result?.type === "tool-result" ? result.output : null).toEqual({
      type: "file",
      path: "src/a.ts",
      status: "changed",
    });
  });

  test("normalizes content-form tool output without retaining binary payloads", () => {
    const value = session();
    value.modelMessages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Readable result" },
              { type: "image-data", data: "a".repeat(1024), mediaType: "image/png" },
            ],
          },
        },
      ],
    };
    const result = structuredTranscript(value)[1]?.parts.find(
      (part) => part.type === "tool-result",
    );
    expect(result?.type === "tool-result" ? result.output : null).toBe(
      "Readable result\n[binary omitted]",
    );
  });

  test("bounds large native structured histories below the bridge protocol cap", () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      id: `a${index}`,
      role: "assistant" as const,
      parts: [
        {
          type: "text" as const,
          text: "x".repeat(512 * 1024),
        },
      ],
      createdAt: index,
    }));
    const bounded = fitTranscriptPayload(history);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(bounded[0]?.id).toBe("transcript:restore-window");
  });

  test("labels legacy plan handoffs as engine context", () => {
    const value = session();
    const prompt =
      "The plan you presented was approved by the user — proceed with implementing it now.";
    value.history[0] = { ...value.history[0]!, parts: [{ type: "text", text: prompt }] };
    value.modelMessages[0] = { role: "user", content: prompt };
    expect(structuredTranscript(value)[0]?.metadata).toEqual({
      origin: "engine",
      label: "Plan approved",
    });
  });
});
