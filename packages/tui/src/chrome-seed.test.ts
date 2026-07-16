import { test, expect } from "bun:test";
import { seedChromeFromSessionStart } from "./chrome-seed.ts";

test("seedChromeFromSessionStart prefers snapshot over event when both present (BUG-107)", () => {
  const seeded = seedChromeFromSessionStart(
    { model: "event/model", mode: "plan" },
    {
      model: "snap/model",
      mode: "execute",
      approvalMode: "auto",
      goal: "ship it",
      theme: "tokyonight",
      accentColor: "#ff00aa",
      details: "verbose",
      mouse: false,
    },
  );
  expect(seeded).toEqual({
    model: "snap/model",
    mode: "execute",
    approvalMode: "auto",
    goal: "ship it",
    theme: "tokyonight",
    accentColor: "#ff00aa",
    details: "verbose",
    mouse: false,
  });
});

test("seedChromeFromSessionStart falls back to event when snapshot is PLACEHOLDER-empty (BUG-107)", () => {
  // Worker ready() soft-deadline left App on empty model; session-start
  // carries the real identity even before the snapshot RPC lands.
  const seeded = seedChromeFromSessionStart(
    { model: "anthropic/claude-opus-4-8", mode: "execute" },
    { model: "", mode: "execute", approvalMode: "ask", goal: null, theme: "default" },
  );
  expect(seeded.model).toBe("anthropic/claude-opus-4-8");
  expect(seeded.mode).toBe("execute");
  expect(seeded.approvalMode).toBe("ask");
});

test("seedChromeFromSessionStart works with a null snapshot (BUG-107)", () => {
  const seeded = seedChromeFromSessionStart({ model: "xai/grok", mode: "plan" }, null);
  expect(seeded.model).toBe("xai/grok");
  expect(seeded.mode).toBe("plan");
  expect(seeded.approvalMode).toBe("ask");
  expect(seeded.theme).toBe("default");
});
