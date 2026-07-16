import { describe, expect, it } from "vitest";
import { permissionInputForDisplay } from "./permission-input";

describe("permissionInputForDisplay", () => {
  it("bounds large strings and collections while retaining both ends", () => {
    const input = {
      command: `safe-head-${"x".repeat(300_000)}-dangerous-tail`,
      edits: Array.from({ length: 10_000 }, (_, index) => ({ index })),
    };
    const projected = permissionInputForDisplay(input) as {
      command: string;
      edits: unknown[];
    };
    expect(projected.command.startsWith("safe-head-")).toBe(true);
    expect(projected.command.endsWith("-dangerous-tail")).toBe(true);
    expect(projected.command).toContain("middle characters omitted");
    expect(projected.edits).toHaveLength(201);
    expect(projected.edits[100]).toBe("… 9800 middle items omitted …");
    expect(JSON.stringify(projected).length).toBeLessThan(400_000);
  });

  it("caps depth and ignores prototype-polluting keys", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":{"next":{"next":{"next":1}}}}');
    const projected = permissionInputForDisplay(input) as Record<string, unknown>;
    expect(projected).not.toHaveProperty("__proto__");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let index = 0; index < 20; index += 1) {
      nested.next = {};
      nested = nested.next as Record<string, unknown>;
    }
    expect(JSON.stringify(permissionInputForDisplay(root))).toContain("nested input omitted");
  });
});
