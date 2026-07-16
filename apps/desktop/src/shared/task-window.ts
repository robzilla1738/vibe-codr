import type { Task } from "./types";

export function hasUnfinishedTasks(tasks: Task[]): boolean {
  return tasks.some((task) => task.status !== "completed");
}

/** Keep active work visible while collapsing older completed rows, as the CLI does. */
export function windowTasks(tasks: Task[], max: number): { lead: number; visible: Task[]; trailing: number } {
  if (tasks.length <= max) return { lead: 0, visible: tasks, trailing: 0 };
  const firstActive = tasks.findIndex((task) => task.status !== "completed");
  const start = Math.max(0, Math.min(firstActive === -1 ? tasks.length : firstActive, tasks.length - max));
  return {
    lead: start,
    visible: tasks.slice(start, start + max),
    trailing: Math.max(0, tasks.length - start - max),
  };
}
