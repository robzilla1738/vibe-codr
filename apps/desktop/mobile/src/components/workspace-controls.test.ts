import { describe, expect, it, vi } from "vitest";
import type { ActivityInfo } from "@shared/types";
import { checkpointCommand } from "./InspectorSheet";
import { activityRowsForDisplay, cancelActivityCommand } from "./ActivityDrawer";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
  View: () => null,
  Text: () => null,
  ScrollView: () => null,
  Pressable: () => null,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("./Sheet", () => ({ Sheet: () => null }));
vi.mock("./activity-shared", () => ({
  MetaBlock: () => null,
  MetaRow: () => null,
  Section: () => null,
  StatusDot: () => null,
  TaskRow: () => null,
  Empty: () => null,
  formatGitLine: () => null,
  formatGoalLine: () => null,
}));
vi.mock("./icons", () => ({ Icon: () => null }));
vi.mock("./primitives", () => ({ Txt: () => null, Card: () => null, Divider: () => null, Chip: () => null }));
vi.mock("./GitWorkspace", () => ({ GitWorkspace: () => null }));
vi.mock("../theme/ThemeProvider", () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock("../theme/tokens", () => ({ staticTokens: {} }));
vi.mock("../hooks/useAccessibilitySettings", () => ({ useAccessibilitySettings: () => ({ reduceMotion: true }) }));
vi.mock("@shared/context-usage", () => ({ contextUsagePercent: () => null }));
vi.mock("@shared/modes", () => ({ modeWord: (mode: string) => mode }));
vi.mock("@shared/changed-files", () => ({
  fileBasename: (path: string) => path,
  fileParentDir: () => "",
  changedFilesTotals: () => ({ count: 0, added: 0, removed: 0 }),
}));

const activity = (kind: ActivityInfo["kind"], id: string, status: ActivityInfo["status"] = "running"): ActivityInfo => ({
  id,
  kind,
  status,
  label: `${kind} activity`,
});

describe("checkpoint controls", () => {
  it("maps only the supported desktop checkpoint actions to typed slash commands", () => {
    expect(checkpointCommand("undo")).toEqual({ type: "run-slash", name: "undo", args: "" });
    expect(checkpointCommand("redo")).toEqual({ type: "run-slash", name: "redo", args: "" });
  });
});

describe("workspace activities", () => {
  it("preserves every engine-reported activity category", () => {
    const rows = activityRowsForDisplay([
      activity("shell", "shell-1"),
      activity("subagent", "subagent-1"),
      activity("tasks", "tasks-1"),
      activity("monitor", "monitor-1"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["shell", "subagent", "tasks", "monitor"]);
  });

  it("bounds activity rows while retaining the newest stable IDs", () => {
    const rows = activityRowsForDisplay(Array.from({ length: 105 }, (_, index) => activity("tasks", `activity-${index}`)));
    expect(rows).toHaveLength(100);
    expect(rows[0]?.id).toBe("activity-5");
    expect(rows.at(-1)?.id).toBe("activity-104");
  });

  it("only makes running activities cancellable and preserves their exact ID", () => {
    expect(cancelActivityCommand(activity("monitor", "stable-monitor-id"))).toEqual({
      type: "cancel-activity",
      id: "stable-monitor-id",
    });
    expect(cancelActivityCommand(activity("monitor", "done-id", "completed"))).toBeNull();
    expect(cancelActivityCommand(activity("monitor", "", "running"))).toBeNull();
  });
});
