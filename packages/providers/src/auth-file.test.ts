import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenFile, expandHome } from "./auth-file.ts";

async function fixture(name: string, content: string): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "vibe-auth-")), name);
  await Bun.write(path, content);
  return path;
}

test("expandHome expands a leading ~", () => {
  expect(expandHome("/abs/path")).toBe("/abs/path");
  expect(expandHome("~").length).toBeGreaterThan(0);
  expect(expandHome("~/x")).toContain("/x");
});

test("missing file yields undefined", () => {
  expect(readTokenFile("/no/such/file.json")).toBeUndefined();
});

test("plain-text token file is used verbatim (trimmed)", async () => {
  const path = await fixture("token.txt", "  sk-plain-123\n");
  expect(readTokenFile(path)).toBe("sk-plain-123");
});

test("JSON file: common key fields are found (OPENAI_API_KEY, access_token)", async () => {
  const a = await fixture("a.json", JSON.stringify({ OPENAI_API_KEY: "sk-from-json" }));
  expect(readTokenFile(a)).toBe("sk-from-json");
  const b = await fixture("b.json", JSON.stringify({ tokens: { access_token: "oauth-abc" } }));
  expect(readTokenFile(b)).toBe("oauth-abc");
});

test("JSON file: an explicit dot-path is honored", async () => {
  const path = await fixture("c.json", JSON.stringify({ tokens: { access_token: "deep-xyz" } }));
  expect(readTokenFile(path, "tokens.access_token")).toBe("deep-xyz");
  expect(readTokenFile(path, "tokens.missing")).toBeUndefined();
});
