import { test, expect } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { buildUseSkillTool, type SessionToolsHandle } from "./session-tools.ts";

// A minimal handle exposing one skill whose body we control. Only `deps.skills`
// is exercised by use_skill, so the rest is cast away.
function handleWithSkill(body: string): SessionToolsHandle {
  const skill = { name: "big", description: "d", dir: "/tmp/skills/big", load: async () => body };
  return {
    id: "s",
    depth: 0,
    deps: { skills: { get: (n: string) => (n === "big" ? skill : undefined) } },
    setTasks: () => [],
  } as unknown as SessionToolsHandle;
}

const ctx = {} as ToolContext;

test("use_skill caps a huge SKILL.md body and points at the file", async () => {
  const big = "x".repeat(50_000); // > MAX_SKILL_BODY (32k)
  const res = await buildUseSkillTool(handleWithSkill(big)).execute({ name: "big" }, ctx);
  const out = String(res.output);
  // The full body would blow the context window; the injected text is bounded and
  // ends in a pointer to the real file so the model can read the rest if needed.
  expect(out.length).toBeLessThan(big.length);
  expect(out).toContain("truncated");
  expect(out).toContain("/tmp/skills/big/SKILL.md");
});

test("use_skill returns a small body verbatim (no truncation marker)", async () => {
  const res = await buildUseSkillTool(handleWithSkill("short body")).execute({ name: "big" }, ctx);
  const out = String(res.output);
  expect(out).toContain("short body");
  expect(out).not.toContain("truncated");
});
