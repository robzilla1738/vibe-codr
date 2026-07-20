import { expect, test } from "bun:test";
import type { PersistedSession } from "./store.ts";
import { renderSessionShareHtml } from "./session-share.ts";

test("local session HTML is escaped, path/secret redacted, and tool/reasoning content-free", () => {
  const session: PersistedSession = {
    meta: { id: "ses_share", model: "mock/x", mode: "execute", goal: null, createdAt: 1, updatedAt: 2 },
    modelMessages: [],
    history: [
      { id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", text: "Open /Users/alice/work/app.ts with api_key=secret-value <script>alert(1)</script>" }] },
      { id: "a1", role: "assistant", createdAt: 2, parts: [
        { type: "reasoning", text: "private chain" },
        { type: "tool-call", toolCallId: "c1", toolName: "write", input: { token: "raw-secret", path: "/Users/alice/work/x" } },
        { type: "tool-result", toolCallId: "c1", toolName: "write", output: "raw output" },
        { type: "text", text: "Done in /Users/alice/work" },
      ] },
    ],
  };
  const html = renderSessionShareHtml(session, { cwd: "/Users/alice/work" });
  expect(html).toContain("[workspace]/app.ts");
  expect(html).toContain("api_key=***");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("arguments omitted");
  expect(html).toContain("output omitted");
  expect(html).not.toContain("private chain");
  expect(html).not.toContain("raw-secret");
  expect(html).not.toContain("raw output");
  expect(html).not.toContain("<script>");
});
