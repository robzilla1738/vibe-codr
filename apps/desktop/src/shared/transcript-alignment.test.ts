import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../renderer/styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(styles)?.[1] ?? "";
}

describe("transcript activity alignment", () => {
  it("uses one font-independent measure for every conversational output row", () => {
    expect(styles).toMatch(/--transcript-measure:\s*40rem;/);
    expect(styles).toMatch(/--prose-max:\s*var\(--transcript-measure\);/);
    expect(styles).toMatch(/--composer-max:\s*var\(--transcript-measure\);/);
    for (const selector of [".block-assistant", ".thinking-row", ".notice", ".status-notice"]) {
      expect(rule(selector)).toContain("width: min(100%, var(--prose-max))");
    }
  });

  it("keeps commentary and reasoning on the shared transcript edge", () => {
    expect(rule(".block-assistant.is-commentary")).not.toContain("margin-left");
    expect(rule(".thinking-row")).toMatch(/margin:\s*0 auto;/);
  });

  it("owns transcript spacing at the flow container instead of child margins", () => {
    expect(styles).toMatch(/--transcript-flow-gap:\s*var\(--space-md\);/);
    expect(rule(".transcript-content")).toContain("gap: var(--transcript-flow-gap)");
    expect(rule(".turn-content")).toContain("gap: var(--transcript-flow-gap)");
    expect(rule(".block-automation")).toMatch(/margin:\s*0 auto;/);
    expect(rule(".earlier")).toContain("calc((100% - var(--prose-max)) / 2)");
  });

  it("uses one compact height for transcript controls and activity rows", () => {
    expect(styles).toMatch(/--transcript-compact-row-h:\s*30px;/);
    for (const selector of [
      ".block-automation-summary",
      ".tool-head, .thinking-head",
      ".status-notice",
      ".status-notice-summary",
      ".earlier",
      ".jump-latest",
      ".changed-files-pill",
    ]) {
      expect(rule(selector)).toContain("min-height: var(--transcript-compact-row-h)");
    }
  });
});
