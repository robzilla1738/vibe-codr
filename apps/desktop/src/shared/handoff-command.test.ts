import { describe, expect, test } from "vitest";
import { parseHandoffCommand, resolveHandoffCommandAction } from "./handoff-command";

describe("parseHandoffCommand", () => {
  test("separates the cloud provider from the continuation instruction", () => {
    expect(parseHandoffCommand("/handoff cloud vercel continue the release")).toEqual({
      target: "cloud",
      provider: "vercel",
      instruction: "continue the release",
    });
  });

  test("keeps non-provider cloud text as the instruction", () => {
    expect(parseHandoffCommand("/handoff cloud continue the release")).toEqual({
      target: "cloud",
      instruction: "continue the release",
    });
  });

  test("parses local and rejects unrelated slash commands", () => {
    expect(parseHandoffCommand("/handoff local")).toEqual({ target: "local" });
    expect(parseHandoffCommand("/help")).toBeNull();
  });
});

describe("resolveHandoffCommandAction", () => {
  test("honors explicit directions and treats satisfied targets as no-ops", () => {
    expect(resolveHandoffCommandAction({ target: "local" }, false)).toBe("already-local");
    expect(resolveHandoffCommandAction({ target: "local" }, true)).toBe("local");
    expect(resolveHandoffCommandAction({ target: "cloud" }, false)).toBe("cloud");
    expect(resolveHandoffCommandAction({ target: "cloud" }, true)).toBe("already-cloud");
  });

  test("uses the current owner when no direction is supplied", () => {
    expect(resolveHandoffCommandAction({}, false)).toBe("cloud");
    expect(resolveHandoffCommandAction({}, true)).toBe("local");
  });
});
