import { describe, expect, it } from "vitest";
import { commandsExpectBusy } from "./command-busy";
import { lineToCommands } from "./slash";

describe("commandsExpectBusy", () => {
  it("marks plain prompts and plan/execute-with-text as busy work", () => {
    expect(commandsExpectBusy(lineToCommands("fix the bug"))).toBe(true);
    expect(commandsExpectBusy(lineToCommands("/plan add oauth"))).toBe(true);
    expect(commandsExpectBusy(lineToCommands("/execute ship it"))).toBe(true);
    expect(commandsExpectBusy([{ type: "compact" }])).toBe(true);
    expect(commandsExpectBusy([{ type: "steer", id: "q1" }])).toBe(true);
    expect(commandsExpectBusy([{
      type: "command-batch",
      commands: [
        { type: "set-mode", mode: "plan" },
        { type: "submit-prompt", text: "inspect it" },
      ],
    }])).toBe(true);
  });

  it("does not mark pure slash / mode / model commands as busy", () => {
    expect(commandsExpectBusy(lineToCommands("/theme graphite"))).toBe(false);
    expect(commandsExpectBusy(lineToCommands("/help"))).toBe(false);
    expect(commandsExpectBusy(lineToCommands("/model openai/gpt-5"))).toBe(false);
    expect(commandsExpectBusy(lineToCommands("/plan"))).toBe(false);
    expect(commandsExpectBusy([{ type: "set-mode", mode: "execute" }])).toBe(false);
    expect(commandsExpectBusy([{ type: "set-approvals", mode: "auto" }])).toBe(false);
    expect(commandsExpectBusy([{ type: "run-slash", name: "details", args: "quiet" }])).toBe(false);
    expect(commandsExpectBusy([{ type: "abort" }])).toBe(false);
    expect(commandsExpectBusy([{ type: "resolve-plan", decision: "keep-planning" }])).toBe(false);
  });

  it("marks plan accept/edit and non-empty goals as busy", () => {
    expect(commandsExpectBusy([{ type: "resolve-plan", decision: "accept" }])).toBe(true);
    expect(commandsExpectBusy([{ type: "resolve-plan", decision: "edit", edit: "more research" }])).toBe(
      true,
    );
    expect(commandsExpectBusy([{ type: "set-goal", goal: "ship v1" }])).toBe(true);
    expect(commandsExpectBusy([{ type: "set-goal", goal: null }])).toBe(false);
  });
});
