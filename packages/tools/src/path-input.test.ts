import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { ToolContext, UIEvent } from "@vibe/shared";
import {
  PATH_FIELD_ALIASES,
  pickPathField,
  normalizePathAliases,
} from "./path-input.ts";
import { writeTool } from "./builtins/write.ts";
import { editTool } from "./builtins/edit.ts";
import { readTool } from "./builtins/read.ts";
import { toAISDKTool } from "./toolset.ts";
import { FreshnessRegistry } from "./builtins/freshness.ts";

/** Built-ins always carry a Zod schema (not raw JSON Schema). */
function parseSchema(schema: unknown, input: unknown): unknown {
  return (schema as ZodType).parse(input);
}

const freshness = new FreshnessRegistry();

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: "ses_path_alias",
    abortSignal: new AbortController().signal,
    emit: () => {},
    toolCallId: "call_1",
    freshness,
  };
}

test("PATH_FIELD_ALIASES lists the documented name first", () => {
  expect(PATH_FIELD_ALIASES[0]).toBe("path");
  expect(PATH_FIELD_ALIASES).toContain("file_path");
  expect(PATH_FIELD_ALIASES).toContain("filePath");
  expect(PATH_FIELD_ALIASES).toContain("file");
});

test("pickPathField prefers path, then file_path, filePath, file", () => {
  expect(pickPathField({ path: "a.ts", file_path: "b.ts" })).toBe("a.ts");
  expect(pickPathField({ file_path: "b.ts" })).toBe("b.ts");
  expect(pickPathField({ filePath: "c.ts" })).toBe("c.ts");
  expect(pickPathField({ file: "d.ts" })).toBe("d.ts");
  expect(pickPathField({ content: "nope" })).toBeUndefined();
  expect(pickPathField(null)).toBeUndefined();
});

test("normalizePathAliases copies the first alias into path", () => {
  expect(normalizePathAliases({ file_path: "x.ts", content: "hi" })).toEqual({
    file_path: "x.ts",
    content: "hi",
    path: "x.ts",
  });
  // Already-canonical path is left alone (not overwritten by an alias).
  expect(normalizePathAliases({ path: "a.ts", file_path: "b.ts" })).toEqual({
    path: "a.ts",
    file_path: "b.ts",
  });
  expect(normalizePathAliases({ content: "only" })).toEqual({ content: "only" });
  // Empty path does not block a usable alias.
  expect(normalizePathAliases({ path: "", file_path: "real.ts" })).toEqual({
    path: "real.ts",
    file_path: "real.ts",
  });
  expect(pickPathField({ path: "", file: "via-file.ts" })).toBe("via-file.ts");
});

test("write/edit/read schemas accept path under each alias", () => {
  for (const alias of ["file_path", "filePath", "file"] as const) {
    expect(
      parseSchema(writeTool.inputSchema, { [alias]: "out.txt", content: "body\n" }),
    ).toEqual({ path: "out.txt", content: "body\n" });
    expect(parseSchema(readTool.inputSchema, { [alias]: "in.txt" })).toEqual({
      path: "in.txt",
    });
    expect(
      parseSchema(editTool.inputSchema, {
        [alias]: "e.txt",
        oldString: "a",
        newString: "b",
      }),
    ).toMatchObject({ path: "e.txt", oldString: "a", newString: "b" });
  }
  // Canonical path still works.
  expect(parseSchema(writeTool.inputSchema, { path: "c.txt", content: "x" })).toEqual({
    path: "c.txt",
    content: "x",
  });
});

test("write schema still rejects content-only (no recoverable path)", () => {
  // The session data point: model sent only content. Aliases recover when a
  // path is present under another name — not when path is wholly omitted.
  expect(() => parseSchema(writeTool.inputSchema, { content: "# syllabus\n" })).toThrow();
});

test("shipped AI-SDK write tool executes when path is only under file_path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-path-alias-"));
  const events: UIEvent[] = [];
  const ai = toAISDKTool(writeTool, {
    cwd: dir,
    sessionId: "s",
    emit: (e) => events.push(e),
    freshness,
  });
  // AI SDK validates against the schema then calls execute with the parsed
  // (alias-normalized) input — this is the real model → tool path.
  const out = await ai.execute!(
    { file_path: "via-alias.txt", content: "hello-alias\n" },
    { toolCallId: "t1", messages: [], abortSignal: new AbortController().signal },
  );
  expect(String(out)).toContain("via-alias.txt");
  expect(await Bun.file(join(dir, "via-alias.txt")).text()).toBe("hello-alias\n");
});

test("shipped AI-SDK read tool resolves filePath alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-path-alias-read-"));
  writeFileSync(join(dir, "note.md"), "line-one\n");
  const ai = toAISDKTool(readTool, {
    cwd: dir,
    sessionId: "s",
    emit: () => {},
    freshness,
  });
  const out = await ai.execute!(
    { filePath: "note.md" },
    { toolCallId: "t2", messages: [], abortSignal: new AbortController().signal },
  );
  expect(String(out)).toContain("line-one");
});

test("shipped AI-SDK edit tool resolves file alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-path-alias-edit-"));
  writeFileSync(join(dir, "x.ts"), "const a = 1;\n");
  // Seed freshness so stale-write doesn't block (edit requires a prior read).
  await readTool.execute({ path: "x.ts" }, ctx(dir));
  const ai = toAISDKTool(editTool, {
    cwd: dir,
    sessionId: "ses_path_alias",
    emit: () => {},
    freshness,
  });
  const out = await ai.execute!(
    { file: "x.ts", oldString: "const a = 1;", newString: "const a = 2;" },
    { toolCallId: "t3", messages: [], abortSignal: new AbortController().signal },
  );
  expect(String(out)).not.toMatch(/^ERROR:/);
  expect(await Bun.file(join(dir, "x.ts")).text()).toBe("const a = 2;\n");
});
