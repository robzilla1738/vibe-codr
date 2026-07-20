import { test, expect } from "bun:test";
import {
  cleanProactiveRecallSeed,
  isProactiveTopicShift,
  ProactiveRecallController,
} from "./proactive-recall.ts";

test("cleanProactiveRecallSeed keeps natural-language intent, strips absolute image paths", () => {
  const prompt =
    "/Users/robert/Desktop/Screenshot\\ 2026-07-09\\ at\\ 5.04.46 PM.png " +
    "/Users/robert/Desktop/Screenshot\\ 2026-07-09\\ at\\ 5.04.41 PM.png " +
    "make a website that looks like these images";
  const seed = cleanProactiveRecallSeed(null, prompt);
  expect(seed.toLowerCase()).toContain("website");
  expect(seed.toLowerCase()).toContain("images");
  expect(seed).not.toMatch(/Users|robert|Desktop|Screenshot/i);
  expect(seed).not.toMatch(/2026|5\.04/);
  expect(seed).not.toMatch(/\.png/i);
});

test("cleanProactiveRecallSeed includes the goal when present", () => {
  const seed = cleanProactiveRecallSeed("ship neon postgres", "remind me what we picked");
  expect(seed).toContain("ship neon postgres");
  expect(seed).toContain("remind me what we picked");
});

test("cleanProactiveRecallSeed strips URLs", () => {
  const seed = cleanProactiveRecallSeed(
    null,
    "see https://example.com/docs and use the neon pooler",
  );
  expect(seed).not.toContain("https://");
  expect(seed).not.toContain("example.com");
  expect(seed.toLowerCase()).toContain("neon");
});

test("cleanProactiveRecallSeed returns empty when the prompt is only paths", () => {
  const seed = cleanProactiveRecallSeed(
    null,
    "/Users/me/Desktop/Screenshot 2026-07-09 at 5.04.46 PM.png",
  );
  // Path + date noise stripped; nothing intentional left.
  expect(seed.trim().length).toBeLessThan(8);
});

test("topic shift is lexical and rejects small edits to the same topic", () => {
  expect(
    isProactiveTopicShift(["postgres", "neon", "pooling"], ["postgres", "neon", "migration"]),
  ).toBe(false);
  expect(
    isProactiveTopicShift(["postgres", "neon", "pooling"], ["swiftui", "watchos", "recorder"]),
  ).toBe(true);
});

test("controller counts only user turns, leaves three turns between attempts, and caps at three", () => {
  const c = new ProactiveRecallController();
  expect(c.consider("user", null, "postgres neon pooling").attempt).toBe(true); // turn 1
  c.recordRecall();

  // Engine-authored continuations neither count nor trigger a lookup.
  for (let i = 0; i < 6; i++) {
    expect(c.consider("engine", null, "swiftui watchos recorder").attempt).toBe(false);
  }
  // Three complete user turns between attempts: turns 2, 3, 4.
  expect(c.consider("user", null, "swiftui watchos recorder").attempt).toBe(false);
  expect(c.consider("user", null, "rust ratatui harness").attempt).toBe(false);
  expect(c.consider("user", null, "pixijs game renderer").attempt).toBe(false);
  expect(c.consider("user", null, "swiftui watchos recorder").attempt).toBe(true); // turn 5
  c.recordRecall();

  expect(c.consider("user", null, "nextjs website design").attempt).toBe(false);
  expect(c.consider("user", null, "electron desktop shell").attempt).toBe(false);
  expect(c.consider("user", null, "python mlx inference").attempt).toBe(false);
  expect(c.consider("user", null, "rust terminal harness").attempt).toBe(true); // turn 9
  c.recordRecall();

  for (let i = 0; i < 8; i++) {
    expect(c.consider("user", null, `new unrelated topic ${i} alpha beta`).attempt).toBe(false);
  }
  expect(c.snapshot()).toMatchObject({ attempts: 3, recalls: 3 });
});

test("controller snapshot restores the durable budget and legacy recall counts once", () => {
  const first = new ProactiveRecallController();
  first.consider("user", "ship database", "postgres neon pooling");
  first.recordRecall();
  const resumed = new ProactiveRecallController(first.snapshot());
  expect(resumed.snapshot()).toEqual(first.snapshot());

  const legacy = ProactiveRecallController.fromLegacy(7, true);
  expect(legacy.snapshot()).toMatchObject({ userTurns: 7, attempts: 1, recalls: 1 });
  // A legacy block cannot be injected as a fourth recall after restoration.
  legacy.restore({ userTurns: 20, attempts: 99, recalls: 99, lastAttemptTurn: 1 });
  expect(legacy.consider("user", null, "entirely fresh coding topic").attempt).toBe(false);
  expect(legacy.snapshot()).toMatchObject({ attempts: 3, recalls: 3 });
});
