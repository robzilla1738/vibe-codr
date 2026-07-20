import { describe, expect, it } from "vitest";
import { PALETTE_COMMANDS } from "./commands-catalog";

describe("commands catalog", () => {
  it("exposes engine-owned memory controls to desktop and mobile palettes", () => {
    const memory = PALETTE_COMMANDS.find((command) => command.name === "memory");
    expect(memory?.description).toContain("manage saved notes");
    expect(memory?.arg).toContain("pin <id>");
    expect(memory?.arg).toContain("merge <ids>");
  });
});
