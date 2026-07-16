import { test, expect } from "bun:test";
import { createBlackboard, formatNotes } from "./blackboard.ts";

test("post + read returns notes in chronological order (newest last)", () => {
  const b = createBlackboard();
  b.post("lead", "taking src/a.ts", "claim", 1);
  b.post("sub:1234", "interface settled as Foo", "decision", 2);
  expect(b.read().map((n) => n.text)).toEqual(["taking src/a.ts", "interface settled as Foo"]);
  expect(b.read(1).map((n) => n.text)).toEqual(["interface settled as Foo"]);
  expect(b.size()).toBe(2);
});

test("kind defaults to info and round-trips on the stored note", () => {
  const b = createBlackboard();
  const info = b.post("lead", "fyi", undefined, 1); // no kind → info
  const decision = b.post("lead", "we use zod", "decision", 2);
  expect(info.kind).toBe("info");
  expect(decision.kind).toBe("decision");
});

test("read filters by kind (newest last, honoring limit within the kind)", () => {
  const b = createBlackboard();
  b.post("lead", "taking a.ts", "claim", 1);
  b.post("lead", "we use zod", "decision", 2);
  b.post("sub:1", "taking b.ts", "claim", 3);
  b.post("sub:2", "clash on the api", "conflict", 4);
  expect(b.read(undefined, "claim").map((n) => n.text)).toEqual(["taking a.ts", "taking b.ts"]);
  expect(b.read(undefined, "decision").map((n) => n.text)).toEqual(["we use zod"]);
  // limit applies AFTER the kind filter → the most recent claim only.
  expect(b.read(1, "claim").map((n) => n.text)).toEqual(["taking b.ts"]);
  expect(b.read(undefined, "info")).toEqual([]);
});

test("caps the note count, evicting the oldest", () => {
  const b = createBlackboard();
  for (let i = 0; i < 250; i++) b.post("x", `note ${i}`, "info", i);
  expect(b.size()).toBe(200);
  expect(b.read(1)[0]!.text).toBe("note 249"); // newest retained
  expect(b.read().some((n) => n.text === "note 0")).toBe(false); // oldest evicted
});

test("trim policy: a load-bearing decision survives a flood of info; oldest info evicts first", () => {
  const b = createBlackboard();
  // An early decision, then fill well past the cap with info notes.
  b.post("lead", "we use zod for schemas", "decision", 0);
  for (let i = 1; i <= 250; i++) b.post("x", `info ${i}`, "info", i);
  expect(b.size()).toBe(200);
  // The decision is load-bearing and must NOT be evicted while any info remains.
  const decisions = b.read(undefined, "decision");
  expect(decisions.map((n) => n.text)).toEqual(["we use zod for schemas"]);
  // The oldest info notes were evicted first; the newest info is retained.
  expect(b.read().some((n) => n.text === "info 1")).toBe(false);
  expect(b.read().some((n) => n.text === "info 250")).toBe(true);
});

test("trim policy: claims evict before decisions/conflicts too", () => {
  const b = createBlackboard();
  b.post("lead", "settled: interface Foo", "decision", 0);
  b.post("lead", "clash needs the lead", "conflict", 1);
  for (let i = 2; i <= 250; i++) b.post("x", `claim ${i}`, "claim", i);
  expect(b.size()).toBe(200);
  // Both load-bearing notes survive the claim flood.
  expect(b.read(undefined, "decision").map((n) => n.text)).toEqual(["settled: interface Foo"]);
  expect(b.read(undefined, "conflict").map((n) => n.text)).toEqual(["clash needs the lead"]);
  expect(b.read().some((n) => n.text === "claim 2")).toBe(false); // oldest claim evicted
});

test("trims and length-caps each note", () => {
  const b = createBlackboard();
  const n = b.post("x", `  ${"y".repeat(5000)}  `, "info", 1);
  expect(n.text.length).toBe(2000);
});

test("clear() drops every note (fresh coordination context)", () => {
  const b = createBlackboard();
  b.post("lead", "we use zod", "decision", 1);
  b.post("lead", "taking a.ts", "claim", 2);
  expect(b.size()).toBe(2);
  b.clear();
  expect(b.size()).toBe(0);
  expect(b.read()).toEqual([]);
});

test("formatNotes renders the kind tag, attributed lines, and an empty state", () => {
  expect(formatNotes([])).toContain("No shared notes");
  const rendered = formatNotes([{ from: "lead", text: "decided X", kind: "decision", at: 1 }]);
  expect(rendered).toContain("[DECISION]");
  expect(rendered).toContain("[lead] decided X");
});
