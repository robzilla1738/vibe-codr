import { describe, expect, it } from "vitest";
import { permissionInputForDisplay } from "./permission-input";
import { permissionPreview } from "./tool-icons";

describe("permissionPreview", () => {
  it("keeps both ends of a long command before approval", () => {
    const command = Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n");
    const preview = permissionPreview("bash", { command });
    expect(preview?.lines[0]).toBe("line-0");
    expect(preview?.lines).toContain("… 300 middle lines omitted …");
    expect(preview?.lines.at(-1)).toBe("line-499");
    expect(preview?.lines).toHaveLength(201);
  });

  it("bounds a pathological one-line command while retaining its tail", () => {
    const command = `start-${"x".repeat(5_000)}-dangerous-tail`;
    const line = permissionPreview("bash", { command })?.lines[0] ?? "";
    expect(line).toContain("chars omitted");
    expect(line.startsWith("start-")).toBe(true);
    expect(line.endsWith("-dangerous-tail")).toBe(true);
    expect(line.length).toBeLessThan(2_200);
  });

  it("tolerates malformed multi-edit members instead of crashing the approval UI", () => {
    expect(() => permissionPreview("multiedit", {
      edits: [null, 4, { oldString: "before", newString: "after" }],
    })).not.toThrow();
    const preview = permissionPreview("multiedit", {
      edits: [null, { oldString: "before", newString: "after" }],
    });
    expect(preview?.lines).toContain("- before");
    expect(preview?.lines).toContain("+ after");
  });

  it("shows bounded arguments for unknown MCP and plugin tools", () => {
    const input = permissionInputForDisplay({
      query: "customers",
      payload: `head-${"x".repeat(300_000)}-sensitive-tail`,
    });
    const preview = permissionPreview("mcp_database_export", input);
    expect(preview?.diff).toBe(false);
    expect(preview?.lines.join("\n")).toContain('"query": "customers"');
    expect(preview?.lines.join("\n")).toContain("sensitive-tail");
    expect(preview?.lines.join("\n")).toContain("omitted");
  });
});
