import { test, expect } from "bun:test";
import { cleanProactiveRecallSeed } from "./proactive-recall.ts";

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
