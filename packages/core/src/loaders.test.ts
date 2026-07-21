import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyArgs,
  loadCommandFiles,
  loadCommandsFrom,
  loadSkills,
  loadSkillsFrom,
  MAX_BODY_CHARS,
} from "./loaders.ts";

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
  const result = await review.run("src/index.ts");
  expect(result.kind).toBe("prompt");
  expect(result.kind === "prompt" && result.text).toBe("Review the file src/index.ts carefully.");
});

test("loadSkills surfaces name/description and lazily loads the body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-skill-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "pdf", "SKILL.md"),
    `---\nname: pdf\ndescription: Work with PDFs\nwhen_to_use: when a PDF is involved\n---\nDetailed PDF instructions here.`,
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "deploy", "SKILL.md"),
    `---\nname: deploy\ndescription: Ship apps\nwhenToUse: when deployment is requested\n---\nDeploy carefully.`,
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "both", "SKILL.md"),
    `---\nname: both\ndescription: Both keys\nwhenToUse: camel\nwhen_to_use: snake\n---\nBody.`,
  );
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(3);
  const pdf = skills.find((s) => s.name === "pdf")!;
  expect(pdf.name).toBe("pdf");
  expect(pdf.description).toBe("Work with PDFs");
  expect(pdf.whenToUse).toBe("when a PDF is involved");
  expect(await pdf.load()).toContain("Detailed PDF instructions");
  expect(skills.find((s) => s.name === "deploy")?.whenToUse).toBe("when deployment is requested");
  expect(skills.find((s) => s.name === "both")?.whenToUse).toBe("snake");
});

test("loadSkills parses disable-model-invocation and user-invocable flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-skill-inv-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "manual", "SKILL.md"),
    `---\nname: manual\ndescription: User only\ndisable-model-invocation: true\n---\nBody.`,
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "bg", "SKILL.md"),
    `---\nname: bg\ndescription: Background\nuser-invocable: false\n---\nBody.`,
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "normal", "SKILL.md"),
    `---\nname: normal\ndescription: Default\n---\nBody.`,
  );
  const skills = await loadSkills(dir);
  expect(skills.find((s) => s.name === "manual")?.disableModelInvocation).toBe(true);
  expect(skills.find((s) => s.name === "bg")?.userInvocable).toBe(false);
  expect(skills.find((s) => s.name === "normal")?.disableModelInvocation).toBeUndefined();
  expect(skills.find((s) => s.name === "normal")?.userInvocable).toBeUndefined();
});

test("command and skill bodies are read lazily at invocation, not retained from startup", async () => {
  // The body used to be captured eagerly in the run/load closure — an edit
  // after startup was invisible, and a huge file sat in memory for the whole
  // session. Rewriting the file between load and invocation proves the read
  // happens at invocation time.
  const dir = mkdtempSync(join(tmpdir(), "vibe-lazy-"));
  const cmdFile = join(dir, ".vibe", "commands", "ship.md");
  await Bun.write(cmdFile, "old command body");
  const skillFile = join(dir, ".vibe", "skills", "pdf", "SKILL.md");
  await Bun.write(skillFile, "---\ndescription: PDFs\n---\nold skill body");

  const cmds = await loadCommandFiles(dir);
  const skills = await loadSkills(dir);
  await Bun.write(cmdFile, "new command body");
  await Bun.write(skillFile, "---\ndescription: PDFs\n---\nnew skill body");

  const result = await cmds[0]!.run("");
  expect(result.kind === "prompt" && result.text).toBe("new command body");
  expect(await skills[0]!.load()).toBe("new skill body");
});

test("an oversized command/skill body is capped with an honest truncation marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cap-"));
  const huge = "x".repeat(MAX_BODY_CHARS + 5_000);
  await Bun.write(join(dir, ".vibe", "commands", "big.md"), huge);
  await Bun.write(
    join(dir, ".vibe", "skills", "big", "SKILL.md"),
    `---\ndescription: big\n---\n${huge}`,
  );

  const cmd = (await loadCommandFiles(dir))[0]!;
  const result = await cmd.run("");
  expect(result.kind).toBe("prompt");
  const text = result.kind === "prompt" ? result.text : "";
  // Head-capped, not the full multi-MB body — plus a marker pointing at the file.
  expect(text.length).toBeLessThan(MAX_BODY_CHARS + 300);
  expect(text).toContain(`truncated at ${MAX_BODY_CHARS} chars`);

  const skillBody = await (await loadSkills(dir))[0]!.load();
  expect(skillBody.length).toBeLessThan(MAX_BODY_CHARS + 300);
  expect(skillBody).toContain(`truncated at ${MAX_BODY_CHARS} chars`);
});

test("a command/skill file deleted after startup fails honestly, not with a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-gone-"));
  const cmdFile = join(dir, ".vibe", "commands", "gone.md");
  await Bun.write(cmdFile, "body");
  const skillFile = join(dir, ".vibe", "skills", "gone", "SKILL.md");
  await Bun.write(skillFile, "body");

  const cmds = await loadCommandFiles(dir);
  const skills = await loadSkills(dir);
  rmSync(cmdFile);
  rmSync(skillFile);

  // Lazy reads must not throw into the slash dispatcher / use_skill.
  const result = await cmds[0]!.run("");
  expect(result.kind).toBe("notice");
  expect(result.kind === "notice" && result.message).toContain("could not read");
  expect(await skills[0]!.load()).toContain("could not be read");
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

test("loaders skip markdown files with unclosed frontmatter fences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-frontmatter-bad-"));
  await Bun.write(
    join(dir, ".vibe", "skills", "broken", "SKILL.md"),
    "---\nname: broken\ndescription: missing close\nBody that should not become metadata",
  );
  await Bun.write(
    join(dir, ".vibe", "skills", "valid", "SKILL.md"),
    "---\nname: valid\ndescription: OK\n---\nBody.",
  );
  await Bun.write(
    join(dir, ".vibe", "commands", "broken.md"),
    "---\nname: broken-command\ndescription: missing close\nPrompt.",
  );
  await Bun.write(
    join(dir, ".vibe", "commands", "valid.md"),
    "---\nname: valid-command\n---\nPrompt.",
  );

  expect((await loadSkills(dir)).map((s) => s.name)).toEqual(["valid"]);
  expect((await loadCommandFiles(dir)).map((c) => c.name)).toEqual(["valid-command"]);
});

test("loadCommandsFrom skips names the slash parser can never invoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cmd-invalid-"));
  await Bun.write(join(dir, ".vibe", "commands", "ship-it.md"), "Ship it.");
  await Bun.write(join(dir, ".vibe", "commands", "api.users.md"), "Dead command.");
  await Bun.write(
    join(dir, ".vibe", "commands", "bad.md"),
    `---\nname: bad/name\n---\nDead command.`,
  );

  const cmds = await loadCommandFiles(dir);
  expect(cmds.map((c) => c.name)).toEqual(["ship-it"]);
});
