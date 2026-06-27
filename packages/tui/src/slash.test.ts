import { test, expect } from "bun:test";
import { lineToCommand } from "./slash.ts";

test("plain text becomes a prompt submission", () => {
  expect(lineToCommand("fix the bug")).toEqual({
    type: "submit-prompt",
    text: "fix the bug",
  });
});

test("/model keeps its argument (the dropped-args regression)", () => {
  expect(lineToCommand("/model openrouter/anthropic/claude-3.5")).toEqual({
    type: "set-model",
    model: "openrouter/anthropic/claude-3.5",
  });
});

test("/model with no argument falls through to run-slash", () => {
  expect(lineToCommand("/model")).toEqual({
    type: "run-slash",
    name: "model",
    args: "",
  });
});

test("/plan and /execute map to mode changes", () => {
  expect(lineToCommand("/plan")).toEqual({ type: "set-mode", mode: "plan" });
  expect(lineToCommand("/execute")).toEqual({ type: "set-mode", mode: "execute" });
});

test("/goal sets and clears", () => {
  expect(lineToCommand("/goal ship it")).toEqual({
    type: "set-goal",
    goal: "ship it",
  });
  expect(lineToCommand("/goal")).toEqual({ type: "set-goal", goal: null });
});

test("unknown slash commands pass through with their args", () => {
  expect(lineToCommand("/queue clear")).toEqual({
    type: "run-slash",
    name: "queue",
    args: "clear",
  });
  expect(lineToCommand("/loop 30s check --max 3")).toEqual({
    type: "run-slash",
    name: "loop",
    args: "30s check --max 3",
  });
});
