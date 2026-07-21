import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard: streaming markdown must not reparse with Streamdown/Shiki
 * on every flush. Static path still uses Streamdown + CodeBlock.
 */
describe("MarkdownView streaming cost", () => {
  const source = readFileSync(
    join(process.cwd(), "src/renderer/transcript/MarkdownView.tsx"),
    "utf8",
  );
  const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  it("uses a plain streaming path without Streamdown or CodeBlock", () => {
    expect(source).toContain("function StreamingPlain");
    expect(source).toContain("md-streaming-plain");
    // Streaming branch must not mount Streamdown
    const streamingBranch = source.slice(
      source.indexOf("if (streaming)"),
      source.indexOf("return (\n    <Streamdown"),
    );
    expect(streamingBranch).toContain("StreamingPlain");
    expect(streamingBranch).not.toContain("<Streamdown");
    expect(streamingBranch).not.toContain("<CodeBlock");
  });

  it("keeps Shiki CodeBlock on the static path only", () => {
    expect(source).toMatch(/staticComponents[\s\S]*code:\s*Code/);
    expect(source).toContain("<CodeBlock");
    expect(source).toContain('mode="static"');
  });

  it("keeps partial assistant output in the prose flow with an inline caret", () => {
    expect(styles).toMatch(/\.md \.md-streaming-pre\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font:\s*inherit;/s);
    expect(styles).toContain(".md-streaming-pre::after");
    expect(styles).not.toContain('.block-assistant.streaming::after');
  });
});

describe("session delta coalescing", () => {
  const source = readFileSync(
    join(process.cwd(), "src/renderer/hooks/useSession.ts"),
    "utf8",
  );

  it("does not synchronously flush each assistant token", () => {
    const assistantCase = source.slice(
      source.indexOf('case "assistant-text-delta"'),
      source.indexOf('case "reasoning-delta"'),
    );
    expect(assistantCase).not.toMatch(/landReasoning\(\);\s*flushDeltas\(\);/);
    expect(assistantCase).toContain("event.phase !== deltaPhase.current) flushDeltas();");
    expect(assistantCase).toContain("deltaBuf.current = appendRollingText");
    expect(source).toMatch(/const flushDeltas[\s\S]*window\.clearTimeout\(flushTimer\.current\)/);
  });
});
