import { describe, expect, it } from "vitest";
import { classifySubmitLine } from "./submit-routing";

describe("classifySubmitLine", () => {
  it("routes shell-local commands", () => {
    expect(classifySubmitLine("/jobs")).toEqual({ kind: "jobs" });
    expect(classifySubmitLine("/keys")).toEqual({ kind: "keys" });
    expect(classifySubmitLine("/settings")).toEqual({ kind: "settings" });
    expect(classifySubmitLine("/config")).toEqual({ kind: "settings" });
    expect(classifySubmitLine("/git")).toEqual({ kind: "git" });
    expect(classifySubmitLine("/branches")).toEqual({ kind: "git" });
  });

  it("forwards everything else to the engine", () => {
    expect(classifySubmitLine("hello")).toEqual({ kind: "engine" });
    expect(classifySubmitLine("/model")).toEqual({ kind: "engine" });
    expect(classifySubmitLine("/clear")).toEqual({ kind: "engine" });
  });
});
