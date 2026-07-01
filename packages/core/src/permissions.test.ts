import { test, expect } from "bun:test";
import { PermissionChecker } from "./permissions.ts";

test("allows tools with no matching rule", async () => {
  const checker = new PermissionChecker([]);
  expect(await checker.check("bash", {})).toEqual({ allowed: true });
});

test("denies tools matched by a deny glob", async () => {
  const checker = new PermissionChecker([{ tool: "bash", action: "deny" }]);
  const res = await checker.check("bash", { command: "rm -rf /" });
  expect(res.allowed).toBe(false);
});

test("glob matches a family of tools", async () => {
  const checker = new PermissionChecker([{ tool: "web*", action: "deny" }]);
  expect((await checker.check("webfetch", {})).allowed).toBe(false);
  expect((await checker.check("read", {})).allowed).toBe(true);
});

test("ask consults the resolver", async () => {
  const allow = new PermissionChecker(
    [{ tool: "write", action: "ask" }],
    () => true,
  );
  const deny = new PermissionChecker(
    [{ tool: "write", action: "ask" }],
    () => false,
  );
  expect((await allow.check("write", {})).allowed).toBe(true);
  expect((await deny.check("write", {})).allowed).toBe(false);
});

// ---------------------------------------------------------------- scoped rules + egress

test("content-scoped rules: bash command globs allow/deny specific commands", async () => {
  const checker = new PermissionChecker(
    [
      { tool: "bash", match: "git push*", action: "deny" },
      { tool: "bash", match: "git *", action: "allow" },
      { tool: "bash", action: "ask" },
    ],
    () => false, // resolver denies — proves 'ask' was consulted
  );
  expect((await checker.check("bash", { command: "git status" })).allowed).toBe(true);
  expect((await checker.check("bash", { command: "git push origin main" })).allowed).toBe(false);
  // Unmatched content falls to the name-only ask rule → resolver → denied.
  expect((await checker.check("bash", { command: "rm -rf /" })).allowed).toBe(false);
});

test("deny beats allow regardless of rule order", async () => {
  const checker = new PermissionChecker([
    { tool: "edit", action: "allow" },
    { tool: "edit", match: "*prod*", action: "deny" },
  ]);
  expect((await checker.check("edit", { path: "src/dev.ts" })).allowed).toBe(true);
  expect((await checker.check("edit", { path: "config/prod.env" })).allowed).toBe(false);
});

test("path-scoped write rules and URL-scoped fetch rules", async () => {
  const checker = new PermissionChecker([
    { tool: "write", match: "docs/*", action: "allow" },
    { tool: "webfetch", match: "*internal.corp*", action: "deny" },
  ]);
  expect((await checker.check("write", { path: "docs/readme.md" })).allowed).toBe(true);
  expect((await checker.check("webfetch", { url: "https://internal.corp/secret" })).allowed).toBe(false);
  expect((await checker.check("webfetch", { url: "https://example.com" }, { fallback: "allow" })).allowed).toBe(true);
});

test("the fallback option overrides the default for unmatched network tools", async () => {
  // Default action 'ask' (approvalMode) + a resolver that denies…
  const checker = new PermissionChecker([], () => false, "ask");
  // …a normal side-effecting tool asks (and is denied):
  expect((await checker.check("bash", { command: "x" })).allowed).toBe(false);
  // …but a network read-only tool passes its allow fallback (no prompt):
  expect((await checker.check("webfetch", { url: "https://x.dev" }, { fallback: "allow" })).allowed).toBe(true);
});
