import { test, expect } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import {
  buildUseSkillTool,
  PLAN_MODE_SKILL_PREFIX,
  type SessionToolsHandle,
} from "./session-tools.ts";
import type { Skill } from "@vibe/plugins";

// A minimal handle exposing skills whose bodies we control.
function handleWithSkills(
  skills: Skill[],
  opts: { mode?: "plan" | "execute" | "yolo" } = {},
): SessionToolsHandle {
  const map = new Map(skills.map((s) => [s.name, s]));
  return {
    id: "s",
    depth: 0,
    mode: opts.mode,
    deps: { skills: { get: (n: string) => map.get(n) } },
    setTasks: () => [],
  } as unknown as SessionToolsHandle;
}

function handleWithSkill(
  body: string,
  dir = "/tmp/skills/big",
  extra: Partial<Skill> = {},
  opts: { mode?: "plan" | "execute" | "yolo" } = {},
): SessionToolsHandle {
  const skill: Skill = {
    name: "big",
    description: "d",
    dir,
    load: async () => body,
    ...extra,
  };
  return handleWithSkills([skill], opts);
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

test("use_skill discloses the skill directory on every load", async () => {
  // A skill body referencing bundled files is useless without the directory, so
  // the locator line must appear even when the body is small (not truncated).
  const res = await buildUseSkillTool(handleWithSkill("short body")).execute({ name: "big" }, ctx);
  const out = String(res.output);
  expect(out).toContain("Skill directory: /tmp/skills/big");
});

test("use_skill omits the directory line when a skill has no dir", async () => {
  const res = await buildUseSkillTool(handleWithSkill("short body", "")).execute({ name: "big" }, ctx);
  const out = String(res.output);
  expect(out).toContain("short body");
  expect(out).not.toContain("Skill directory:");
});

test("use_skill rejects disable-model-invocation skills", async () => {
  const res = await buildUseSkillTool(
    handleWithSkill("body", "/tmp/s", { disableModelInvocation: true }),
  ).execute({ name: "big" }, ctx);
  expect(res.isError).toBe(true);
  expect(String(res.output)).toMatch(/user-invoked only|disable-model-invocation/i);
  expect(String(res.output)).not.toContain("body");
});

test("use_skill in plan mode prefixes the body with plan discipline", async () => {
  const res = await buildUseSkillTool(
    handleWithSkill("skill body here", "/tmp/s", {}, { mode: "plan" }),
  ).execute({ name: "big" }, ctx);
  const out = String(res.output);
  expect(out.startsWith(PLAN_MODE_SKILL_PREFIX)).toBe(true);
  expect(out).toContain("skill body here");
  expect(out).toMatch(/present_plan/i);
});

test("use_skill in execute mode does not add the plan prefix", async () => {
  const res = await buildUseSkillTool(
    handleWithSkill("skill body here", "/tmp/s", {}, { mode: "execute" }),
  ).execute({ name: "big" }, ctx);
  const out = String(res.output);
  expect(out).not.toContain("PLAN MODE:");
  expect(out).toContain("skill body here");
});
