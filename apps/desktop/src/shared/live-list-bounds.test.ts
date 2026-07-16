import { describe, expect, it } from "vitest";
import { jobsForDisplay, queueRowsForDisplay } from "./live-list-bounds";
import type { JobInfo, QueuedItem } from "./types";

function job(index: number, status: JobInfo["status"] = "exited"): JobInfo {
  return {
    id: `job-${index}`,
    command: `command ${index}`,
    status,
    exitCode: status === "running" ? null : 0,
    servers: [],
    outputTail: "",
  };
}

describe("live list bounds", () => {
  it("keeps the front and tail of a large queue with an honest omitted count", () => {
    const rows: QueuedItem[] = Array.from({ length: 500 }, (_, index) => ({
      id: `q-${index}`,
      label: `Queued ${index}`,
    }));
    const visible = queueRowsForDisplay(rows);
    expect(visible.head).toHaveLength(100);
    expect(visible.tail).toHaveLength(100);
    expect(visible.omitted).toBe(300);
    expect(visible.head[0]?.id).toBe("q-0");
    expect(visible.tail.at(-1)?.id).toBe("q-499");
  });

  it("preserves running jobs and fills remaining slots with newest settled jobs", () => {
    const rows = Array.from({ length: 300 }, (_, index) => job(index));
    rows[5] = job(5, "running");
    rows[25] = job(25, "running");
    const visible = jobsForDisplay(rows, 20);
    expect(visible.items).toHaveLength(20);
    expect(visible.omitted).toBe(280);
    expect(visible.items.map((item) => item.id)).toContain("job-5");
    expect(visible.items.map((item) => item.id)).toContain("job-25");
    expect(visible.items.at(-1)?.id).toBe("job-299");
  });
});
