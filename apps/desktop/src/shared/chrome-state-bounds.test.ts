import { describe, expect, it } from "vitest";
import {
  JOB_COMMAND_MAX_CHARS,
  JOB_OUTPUT_TAIL_MAX_CHARS,
  JOB_SERVER_MAX_ITEMS,
  MAX_RETAINED_COMMAND_NAMES,
  MAX_RETAINED_JOB_ITEMS,
  MAX_RETAINED_QUEUE_ITEMS,
  MAX_RETAINED_TASK_ITEMS,
  QUEUE_LABEL_MAX_CHARS,
  retainCommandNames,
  retainJobState,
  retainQueueState,
  retainTaskState,
} from "./chrome-state-bounds";
import type { JobInfo } from "./types";

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

describe("session chrome retained-state bounds", () => {
  it("keeps queue head and tail with an honest authoritative total", () => {
    const pending = Array.from({ length: 1_500 }, (_, index) => ({
      id: `queue-${index}`,
      label: index === 0 ? "x".repeat(QUEUE_LABEL_MAX_CHARS * 2) : `Queued ${index}`,
    }));
    const retained = retainQueueState(pending);

    expect(retained.total).toBe(1_500);
    expect(retained.items).toHaveLength(MAX_RETAINED_QUEUE_ITEMS);
    expect(retained.items[0]?.id).toBe("queue-0");
    expect(retained.items.at(-1)?.id).toBe("queue-1499");
    expect(retained.items[0]?.label.length).toBe(QUEUE_LABEL_MAX_CHARS);
  });

  it("preserves running jobs, newest settled jobs, and bounded payload fields", () => {
    const jobs = Array.from({ length: 700 }, (_, index) => job(index));
    jobs[3] = {
      ...job(3, "running"),
      command: "c".repeat(JOB_COMMAND_MAX_CHARS * 2),
      outputTail: "o".repeat(JOB_OUTPUT_TAIL_MAX_CHARS * 2),
      servers: Array.from({ length: 60 }, (_, index) => `http://localhost:${3000 + index}`),
    };
    const retained = retainJobState(jobs);

    expect(retained.total).toBe(700);
    expect(retained.items).toHaveLength(MAX_RETAINED_JOB_ITEMS);
    const running = retained.items.find((item) => item.id === "job-3");
    expect(running?.command.length).toBe(JOB_COMMAND_MAX_CHARS);
    expect(running?.outputTail.length).toBe(JOB_OUTPUT_TAIL_MAX_CHARS);
    expect(running?.servers).toHaveLength(JOB_SERVER_MAX_ITEMS);
    expect(retained.items.at(-1)?.id).toBe("job-699");
  });

  it("drops unusable oversized ids instead of retaining or exposing them", () => {
    const retained = retainQueueState([{ id: "x".repeat(2_000), label: "bad" }]);
    expect(retained).toEqual({ items: [], total: 1 });
  });

  it("prioritizes unfinished tasks while retaining authoritative counts", () => {
    const tasks = Array.from({ length: 1_500 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: index < 1_200 ? "completed" as const : "pending" as const,
    }));
    const retained = retainTaskState(tasks);

    expect(retained.items).toHaveLength(MAX_RETAINED_TASK_ITEMS);
    expect(retained.items.filter((task) => task.status === "pending")).toHaveLength(300);
    expect(retained).toMatchObject({ total: 1_500, completed: 1_200, unfinished: 300 });
  });

  it("deduplicates and caps the command-recognition catalog", () => {
    const names = [
      "help",
      "help",
      ...Array.from({ length: MAX_RETAINED_COMMAND_NAMES + 20 }, (_, index) => `cmd-${index}`),
      `bad\0name`,
    ];
    const retained = retainCommandNames(names);
    expect(retained).toHaveLength(MAX_RETAINED_COMMAND_NAMES);
    expect(retained[0]).toBe("help");
    expect(new Set(retained).size).toBe(retained.length);
  });
});
