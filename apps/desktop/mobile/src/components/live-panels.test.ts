import { describe, expect, it, vi } from "vitest";
import { queueRowsForDisplay } from "@shared/live-list-bounds";
import {
  permissionResolutionCommand,
  planResolutionCommand,
  questionResolutionCommand,
  queueActionCommand,
} from "./activity-shared";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: () => null,
  View: () => null,
}));
vi.mock("../theme/ThemeProvider", () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock("../theme/tokens", () => ({ staticTokens: {} }));
vi.mock("./primitives", () => ({ Txt: () => null }));
vi.mock("./icons", () => ({ Icon: () => null }));

describe("live panel commands", () => {
  it("covers every permission decision, including project persistence", () => {
    expect(permissionResolutionCommand("perm-1", "once")).toEqual({
      type: "resolve-permission",
      id: "perm-1",
      decision: "once",
    });
    expect(permissionResolutionCommand("perm-1", "always")).toEqual({
      type: "resolve-permission",
      id: "perm-1",
      decision: "always",
    });
    expect(permissionResolutionCommand("perm-1", "always-project")).toEqual({
      type: "resolve-permission",
      id: "perm-1",
      decision: "always-project",
    });
    expect(permissionResolutionCommand("perm-1", "deny")).toEqual({
      type: "resolve-permission",
      id: "perm-1",
      decision: "deny",
    });
  });

  it("trims and preserves optional denial feedback", () => {
    expect(permissionResolutionCommand("perm-2", "deny", "  use staging instead  ")).toEqual({
      type: "resolve-permission",
      id: "perm-2",
      decision: "deny",
      feedback: "use staging instead",
    });
    expect(permissionResolutionCommand("perm-2", "once", "not applicable")).not.toHaveProperty("feedback");
  });

  it("builds each plan resolution command", () => {
    expect(planResolutionCommand("accept")).toEqual({ type: "resolve-plan", decision: "accept" });
    expect(planResolutionCommand("accept", { autoApprove: true })).toEqual({
      type: "resolve-plan",
      decision: "accept",
      approvals: "auto",
    });
    expect(planResolutionCommand("keep-planning")).toEqual({
      type: "resolve-plan",
      decision: "keep-planning",
    });
    expect(planResolutionCommand("edit", { edit: "  check the API first  " })).toEqual({
      type: "resolve-plan",
      decision: "edit",
      edit: "check the API first",
    });
  });

  it("builds question and queue control commands", () => {
    expect(questionResolutionCommand("question-1", ["A"], "  context  ")).toEqual({
      type: "resolve-question",
      id: "question-1",
      answers: ["A"],
      freeform: "context",
    });
    expect(queueActionCommand("steer", "queued-1")).toEqual({ type: "steer", id: "queued-1" });
    expect(queueActionCommand("dequeue", "queued-1")).toEqual({ type: "dequeue", id: "queued-1" });
  });
});

describe("queue disclosure", () => {
  it("keeps bounded head and tail rows and reports the omitted middle", () => {
    const pending = Array.from({ length: 8 }, (_, index) => ({ id: String(index), label: `Prompt ${index}` }));
    const visible = queueRowsForDisplay(pending, 4);
    expect(visible.head.map((item) => item.id)).toEqual(["0", "1"]);
    expect(visible.tail.map((item) => item.id)).toEqual(["6", "7"]);
    expect(visible.omitted).toBe(4);
  });
});
