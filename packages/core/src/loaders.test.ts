import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyArgs, loadCommandFiles, loadCommandsFrom, loadSkills, loadSkillsFrom } from "./loaders.ts";

test("loadCommandsFrom + loadSkillsFrom read an arbitrary (e.g. global) directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-global-"));
  await Bun.write(join(dir, "commands", "deploy.md"), "Deploy the app.");
  await Bun.write(
    join(dir, "skills", "my-skill", "SKILL.md"),
    `---\ndescription: a global skill\n---\nbody`,
  );
  const cmds = await loadCommandsFrom(join(dir, "commands"));
  expect(cmds.map((c) => c.name)).toEqual(["deploy"]);
  const skills = await loadSkillsFrom(join(dir, "skills"));
  expect(skills.map((s) => s.name)).toEqual(["my-skill"]);
});

test("applyArgs substitutes $ARGUMENTS and positional $1/$2", () => {
  expect(applyArgs("run $ARGUMENTS now", "a b c")).toBe("run a b c now");
  expect(applyArgs("first=$1 second=$2", "x y")).toBe("first=x second=y");
});

test("loadCommandFiles builds a prompt command from a markdown file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cmd-"));
  await Bun.write(
    join(dir, ".vibe", "commands", "review.md"),
    `---\ndescription: Review a file\n---\nReview the file $1 carefully.`,
  );
  const cmds = await loadCommandFiles(dir);
  expect(cmds).toHaveLength(1);
  const review = cmds[0]!;
  expect(review.name).toBe("review");
  expect(review.description).toBe("Review a file");
  const result = review.run("src/index.ts");
  expect(result.kind).toBe("prompt");
  expect(result.kind === "prompt" && result.text).toBe(
    "Review the file src/index.ts carefully.",
  );
});

test("loadSkills surfaces name/description and lazily loads the body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-skill-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "pdf", "SKILL.md"),
    `---\nname: pdf\ndescription: Work with PDFs\nwhen_to_use: when a PDF is involved\n---\nDetailed PDF instructions here.`,
  );
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  const pdf = skills[0]!;
  expect(pdf.name).toBe("pdf");
  expect(pdf.description).toBe("Work with PDFs");
  expect(pdf.whenToUse).toBe("when a PDF is involved");
  expect(await pdf.load()).toContain("Detailed PDF instructions");
});

test("loaders tolerate missing directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-empty-"));
  expect(await loadCommandFiles(dir)).toEqual([]);
  expect(await loadSkills(dir)).toEqual([]);
});

test("an explicitly EMPTY name:/description: falls back like an absent field", async () => {
  // A bare `name:` line parses to "" — with a `??` fallback the skill would
  // register under the empty string: unreachable via /skill and a blank
  // `- : …` line polluting the system prompt's skills block.
  const dir = mkdtempSync(join(tmpdir(), "vibe-skill-blank-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "deploy", "SKILL.md"),
    `---\nname:\ndescription:\n---\nBody.`,
  );
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("deploy"); // directory-name fallback
  expect(skills[0]!.description).toBe("deploy"); // name fallback

  await Bun.write(join(dir, ".vibe", "commands", "ship.md"), `---\nname:\n---\nShip it.`);
  const cmds = await loadCommandFiles(dir);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]!.name).toBe("ship"); // file-name fallback
});
