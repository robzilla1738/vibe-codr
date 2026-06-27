import { test, expect } from "bun:test";
import { Toolset } from "./toolset.ts";

test("plan mode exposes only read-only tools", () => {
  const ts = new Toolset();
  const planNames = ts.names("plan");
  expect(planNames).toContain("read");
  expect(planNames).toContain("glob");
  expect(planNames).not.toContain("write");
  expect(planNames).not.toContain("edit");
  expect(planNames).not.toContain("bash");
});

test("execute mode exposes side-effecting tools", () => {
  const ts = new Toolset();
  const names = ts.names("execute");
  expect(names).toContain("write");
  expect(names).toContain("bash");
});

test("every plan-mode tool is marked readOnly", () => {
  const ts = new Toolset();
  for (const tool of ts.forMode("plan")) {
    expect(tool.readOnly).toBe(true);
  }
});

test("present_plan is available only in plan mode", () => {
  const ts = new Toolset();
  expect(ts.names("plan")).toContain("present_plan");
  expect(ts.names("execute")).not.toContain("present_plan");
});
