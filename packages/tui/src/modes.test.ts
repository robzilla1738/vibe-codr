import { test, expect } from "bun:test";
import {
  deriveUiMode,
  nextUiMode,
  commandsForUiMode,
  modeLabel,
  type UiMode,
} from "./modes.ts";

test("deriveUiMode collapses (mode, approvals) into the 3-way mode", () => {
  expect(deriveUiMode("plan", "ask")).toBe("plan");
  expect(deriveUiMode("plan", "auto")).toBe("plan"); // plan ignores approvals
  expect(deriveUiMode("execute", "ask")).toBe("execute");
  expect(deriveUiMode("execute", "auto")).toBe("yolo");
});

test("nextUiMode cycles plan -> execute -> yolo -> plan", () => {
  expect(nextUiMode("plan")).toBe("execute");
  expect(nextUiMode("execute")).toBe("yolo");
  expect(nextUiMode("yolo")).toBe("plan");
});

test("commandsForUiMode sets the right engine state for each mode", () => {
  expect(commandsForUiMode("plan")).toEqual([
    { type: "set-mode", mode: "plan" },
    { type: "set-approvals", mode: "ask" },
  ]);
  expect(commandsForUiMode("execute")).toEqual([
    { type: "set-mode", mode: "execute" },
    { type: "set-approvals", mode: "ask" },
  ]);
  expect(commandsForUiMode("yolo")).toEqual([
    { type: "set-mode", mode: "execute" },
    { type: "set-approvals", mode: "auto" },
  ]);
});

test("applying a mode's commands round-trips back to that mode", () => {
  // Simulate the engine applying the commands, then re-derive the UI mode.
  const apply = (target: UiMode) => {
    let mode = "execute";
    let approvals = "ask";
    for (const cmd of commandsForUiMode(target)) {
      if (cmd.type === "set-mode") mode = cmd.mode;
      if (cmd.type === "set-approvals") approvals = cmd.mode;
    }
    return deriveUiMode(mode, approvals);
  };
  for (const m of ["plan", "execute", "yolo"] as UiMode[]) {
    expect(apply(m)).toBe(m);
  }
});

test("a full Shift+Tab cycle visits every mode and returns to start", () => {
  let cur: UiMode = "execute";
  const seen: UiMode[] = [cur];
  for (let i = 0; i < 3; i++) {
    cur = nextUiMode(cur);
    seen.push(cur);
  }
  expect(seen).toEqual(["execute", "yolo", "plan", "execute"]);
});

test("modeLabel is distinct and non-empty per mode", () => {
  const labels = new Set(["plan", "execute", "yolo"].map((m) => modeLabel(m as UiMode)));
  expect(labels.size).toBe(3);
});
