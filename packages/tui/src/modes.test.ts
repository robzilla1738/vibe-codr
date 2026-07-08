import { test, expect } from "bun:test";
import {
  deriveUiMode,
  nextUiMode,
  commandsForUiMode,
  cycleModeAction,
  engineStateForUiMode,
  modeColor,
  MODE_COLORS,
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

test("commandsForUiMode sets the right engine state for each mode — quietly", () => {
  // All Shift+Tab approval flips are quiet (the mode chip is the feedback);
  // the transcript confirm is reserved for a typed /approvals.
  expect(commandsForUiMode("plan")).toEqual([
    { type: "set-mode", mode: "plan" },
    { type: "set-approvals", mode: "ask", quiet: true },
  ]);
  expect(commandsForUiMode("execute")).toEqual([
    { type: "set-mode", mode: "execute" },
    { type: "set-approvals", mode: "ask", quiet: true },
  ]);
  expect(commandsForUiMode("yolo")).toEqual([
    { type: "set-mode", mode: "execute" },
    { type: "set-approvals", mode: "auto", quiet: true },
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

test("modeColor maps ASK→blue, PLAN→green, YOLO→red (distinct hexes)", () => {
  expect(modeColor("execute")).toBe(MODE_COLORS.execute); // ASK
  expect(modeColor("plan")).toBe(MODE_COLORS.plan);
  expect(modeColor("yolo")).toBe(MODE_COLORS.yolo);
  const hexes = new Set([modeColor("execute"), modeColor("plan"), modeColor("yolo")]);
  expect(hexes.size).toBe(3);
  for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/);
});

test("engineStateForUiMode round-trips through deriveUiMode for every mode", () => {
  for (const target of ["plan", "execute", "yolo"] as UiMode[]) {
    const { mode, approvals } = engineStateForUiMode(target);
    expect(deriveUiMode(mode, approvals)).toBe(target);
  }
});

test("optimistic mirrors let two rapid Shift+Tab presses advance two full steps", () => {
  // Model the app's cycleMode: read the local mirror, compute next, and update
  // the mirror OPTIMISTICALLY (before the engine echoes). Two presses in a row
  // must advance plan → execute → yolo, not stick on execute (the stale-mirror bug).
  let mode = "plan";
  let approvals = "ask";
  const press = () => {
    const action = cycleModeAction(deriveUiMode(mode, approvals));
    if (action.optimistic) {
      mode = action.optimistic.mode;
      approvals = action.optimistic.approvals;
      return action.optimistic.uiMode;
    }
    return deriveUiMode(mode, approvals);
  };
  expect(press()).toBe("execute");
  expect(press()).toBe("yolo");
  expect(press()).toBe("plan");
});

test("cycleModeAction with a live plan does not flip chip or set-approvals", () => {
  // Engine refuses bare plan→execute when a plan is waiting. The TUI must not
  // optimistically show ASK/YOLO or send set-approvals auto (YOLO would stick
  // and the next Enter would inherit unattended approvals).
  const action = cycleModeAction("plan", { planPending: true });
  expect(action.optimistic).toBeNull();
  expect(action.commands).toEqual([{ type: "set-mode", mode: "execute" }]);
  // No set-approvals in the command list.
  expect(action.commands.every((c) => c.type === "set-mode")).toBe(true);

  // Without a pending plan, normal cycle still works.
  const free = cycleModeAction("plan", { planPending: false });
  expect(free.optimistic?.uiMode).toBe("execute");
  expect(free.commands.some((c) => c.type === "set-approvals")).toBe(true);
});
