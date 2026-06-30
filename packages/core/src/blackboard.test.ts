import { test, expect } from "bun:test";
import { createBlackboard, formatNotes } from "./blackboard.ts";

test("post + read returns notes in chronological order (newest last)", () => {
  const b = createBlackboard();
  b.post("lead", "taking src/a.ts", 1);
  b.post("sub:1234", "interface settled as Foo", 2);
  expect(b.read().map((n) => n.text)).toEqual(["taking src/a.ts", "interface settled as Foo"]);
  expect(b.read(1).map((n) => n.text)).toEqual(["interface settled as Foo"]);
  expect(b.size()).toBe(2);
});

test("caps the note count, evicting the oldest", () => {
  const b = createBlackboard();
  for (let i = 0; i < 250; i++) b.post("x", `note ${i}`, i);
  expect(b.size()).toBe(200);
  expect(b.read(1)[0]!.text).toBe("note 249"); // newest retained
  expect(b.read().some((n) => n.text === "note 0")).toBe(false); // oldest evicted
});

test("trims and length-caps each note", () => {
  const b = createBlackboard();
  const n = b.post("x", `  ${"y".repeat(5000)}  `, 1);
  expect(n.text.length).toBe(2000);
});

test("formatNotes renders attributed lines and an empty state", () => {
  expect(formatNotes([])).toContain("No shared notes");
  expect(formatNotes([{ from: "lead", text: "decided X", at: 1 }])).toContain("[lead] decided X");
});
