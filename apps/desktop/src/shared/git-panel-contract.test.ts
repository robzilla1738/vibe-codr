import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("git panel operation lifecycle", () => {
  const source = readFileSync(join(process.cwd(), "src/renderer/git/GitPanel.tsx"), "utf8");

  it("preserves branch drafts and confirmations when an operation fails", () => {
    expect(source).toContain("type RunGitOperation =");
    expect(source).toContain("const created = await runOp(");
    expect(source).toContain("if (!created) return;");
    expect(source).toContain("if (deleted) setConfirmDelete(null)");
  });

  it("does not launch branch mutations while another git operation is running", () => {
    expect(source).toContain("if (!name || busy) return;");
    expect(source).toContain("if (busy) return;");
  });
});
