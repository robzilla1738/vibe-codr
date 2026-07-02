import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a denial's typed feedback lands in the reason the MODEL reads", async () => {
  // "denied by user — use staging instead" steers the next attempt; a bare
  // boolean deny just blocks. Both shapes must produce a reason.
  const withFeedback = new PermissionChecker([{ tool: "bash", action: "ask" }], () => ({
    allowed: false,
    feedback: "use the staging config instead",
  }));
  const res = await withFeedback.check("bash", { command: "deploy prod" });
  expect(res.allowed).toBe(false);
  expect(res.allowed === false && res.reason).toBe(
    "denied by user — use the staging config instead",
  );
  const bare = new PermissionChecker([{ tool: "bash", action: "ask" }], () => ({
    allowed: false,
  }));
  const bareRes = await bare.check("bash", { command: "deploy prod" });
  expect(bareRes.allowed === false && bareRes.reason).toBe("denied by user");
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

test("egress deny rules govern the dedicated git_push / git_commit tools", async () => {
  // The dedicated tools have no command/path/url field, so before scopeString
  // exposed their command form a `match` rule silently never applied and (in
  // approvalMode auto → default allow) the push went out unprompted.
  const bashRecipe = new PermissionChecker(
    [{ tool: "git_push", match: "git push*", action: "deny" }],
    undefined,
    "allow",
  );
  expect((await bashRecipe.check("git_push", { remote: "origin", branch: "main" })).allowed).toBe(false);

  // A targeted glob fires now that git_push carries the command it runs.
  const targeted = new PermissionChecker(
    [{ tool: "git_push", match: "git push origin main*", action: "deny" }],
    undefined,
    "allow",
  );
  expect((await targeted.check("git_push", { remote: "origin", branch: "main" })).allowed).toBe(false);
  expect((await targeted.check("git_push", { remote: "origin", branch: "dev" })).allowed).toBe(true);

  // git_commit is governable the same way.
  const commit = new PermissionChecker(
    [{ tool: "git_commit", match: "git commit*", action: "deny" }],
    undefined,
    "allow",
  );
  expect((await commit.check("git_commit", { message: "wip" })).allowed).toBe(false);
});

test("a name-only DENY is an absolute kill-switch a scoped ALLOW can't punch through", async () => {
  // Regression: the scoped tier used to decide before the name-only tier, so a
  // blanket deny + a scoped allowlist silently ALLOWED the matching commands,
  // contradicting the documented "deny > ask > allow regardless of order".
  const checker = new PermissionChecker(
    [
      { tool: "bash", action: "deny" }, // blanket kill-switch
      { tool: "bash", match: "git *", action: "allow" }, // scoped allow
    ],
    undefined,
    "allow",
  );
  expect((await checker.check("bash", { command: "git push origin main" })).allowed).toBe(false);
  expect((await checker.check("bash", { command: "git status" })).allowed).toBe(false);
});

test("a scoped ALLOW still beats a name-only ASK (allowlists don't prompt)", async () => {
  // Specificity still governs allow-vs-ask: the reason the tiers exist.
  const checker = new PermissionChecker(
    [
      { tool: "bash", action: "ask" },
      { tool: "bash", match: "git *", action: "allow" },
    ],
    () => false, // resolver denies — proves 'ask' was NOT consulted for git
  );
  expect((await checker.check("bash", { command: "git status" })).allowed).toBe(true);
  expect((await checker.check("bash", { command: "rm -rf /" })).allowed).toBe(false);
});

test("a deny can't be dodged by a newline, whitespace-case, or host-case trick", async () => {
  const checker = new PermissionChecker(
    [
      { tool: "bash", match: "*git push*", action: "deny" },
      { tool: "webfetch", match: "*internal.corp*", action: "deny" },
    ],
    undefined,
    "allow",
  );
  // Newline dodge: `.*` must cross newlines for a protective deny (dotAll).
  expect((await checker.check("bash", { command: "true\ngit push origin evil" })).allowed).toBe(false);
  // Case dodge on a host (DNS is case-insensitive).
  expect((await checker.check("webfetch", { url: "https://INTERNAL.CORP/secret" })).allowed).toBe(false);
});

test("an ALLOW stays strict — a trailing command can't be smuggled past it", async () => {
  // The permissive side must NOT be broadened: `allow git *` must not auto-allow
  // a second command hidden after a newline. It falls through to the default.
  const checker = new PermissionChecker(
    [{ tool: "bash", match: "git *", action: "allow" }],
    () => false,
    "ask", // unmatched → ask → resolver denies
  );
  expect((await checker.check("bash", { command: "git status" })).allowed).toBe(true);
  expect((await checker.check("bash", { command: "git status\nrm -rf /" })).allowed).toBe(false);
});

test("command-scoped match rules govern any command-bearing tool, not just bash", async () => {
  // An MCP shell/exec server carries its effect in `command`; a `match` rule must
  // apply to it too (previously only `bash` was command-scoped).
  const checker = new PermissionChecker(
    [{ tool: "mcp__shell__exec", match: "*git push*", action: "deny" }],
    undefined,
    "allow",
  );
  expect((await checker.check("mcp__shell__exec", { command: "git push origin main" })).allowed).toBe(false);
  expect((await checker.check("mcp__shell__exec", { command: "ls -la" })).allowed).toBe(true);
});

test("the resolver learns whether an ask came from an explicit rule vs the default", async () => {
  // F5 wiring: an explicit `{action:"ask"}` rule flags explicit:true so a headless
  // resolver can fail closed; the default/fallback ask flags explicit:false.
  const seen: { explicit: boolean }[] = [];
  const checker = new PermissionChecker(
    [{ tool: "git_push", match: "git push*", action: "ask" }],
    (req) => {
      seen.push({ explicit: req.explicit });
      return true;
    },
    "ask", // default is also ask, but from the fallback, not a rule
  );
  await checker.check("git_push", { remote: "origin", branch: "main" }); // matches the explicit rule
  await checker.check("bash", { command: "echo hi" }); // no rule → default ask
  expect(seen).toEqual([{ explicit: true }, { explicit: false }]);
});

test("a RELATIVE path deny rule can't be evaded by ./ , ../ , or an absolute spelling", async () => {
  // Regression: a natural relative rule `config/prod.env` used to match ONLY the
  // exact raw spelling, so `./config/prod.env` or the absolute path (the SAME
  // file) slipped past it. All spellings of the same file must be denied.
  const checker = new PermissionChecker(
    [{ tool: "edit", match: "config/prod.env", action: "deny" }],
    undefined,
    "allow",
    "/home/user/project",
  );
  for (const path of [
    "config/prod.env",
    "./config/prod.env",
    "/home/user/project/config/prod.env",
    "config/../config/prod.env",
  ]) {
    expect((await checker.check("edit", { path })).allowed).toBe(false);
  }
  // A genuinely different file is still allowed.
  expect((await checker.check("edit", { path: "config/dev.env" })).allowed).toBe(true);
});

test("an in-tree symlink can't route a write past a path deny rule (realpath dereferenced)", async () => {
  // A symlink inside the tree pointing at a denied directory must be judged at its
  // REAL target — `write link/x` where `link -> <secret>` lands in <secret>, so a
  // `<secret>/*` deny must catch it even though the lexical path is `<cwd>/link/x`.
  // realpath the base so the OS's own /var→/private symlink doesn't skew the rule.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vibe-perm-sym-")));
  const proj = join(base, "project");
  const secret = join(base, "secret");
  mkdirSync(proj);
  mkdirSync(secret);
  symlinkSync(secret, join(proj, "link"));
  const checker = new PermissionChecker(
    [{ tool: "write", match: `${secret}/*`, action: "deny" }],
    undefined,
    "allow",
    proj,
  );
  // Write through the symlink → denied (real target is under <secret>).
  expect((await checker.check("write", { path: "link/passwd" })).allowed).toBe(false);
  // A genuine in-tree file is unaffected.
  expect((await checker.check("write", { path: "notes.txt" })).allowed).toBe(true);
});

test("a `../` traversal can't punch a scoped ALLOW through a deny-by-default sandbox", async () => {
  // A path is matched by its NORMALIZED forms only, never the raw input: since a
  // glob's `*`→`.*` spans `/`, a raw `src/../out.ts` would match a `src/*` allow
  // though it RESOLVES outside `src/` — a false-allow sandbox escape (and the
  // reverse, a false-deny). Both directions must be judged on the real target.
  // (Real realpath'd cwd, since allow-list confinement resolves against it.)
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "vibe-perm-esc-")));
  mkdirSync(join(proj, "src"));
  const sandbox = new PermissionChecker(
    [{ tool: "edit", match: "src/*", action: "allow" }],
    () => false,
    "deny", // deny-by-default
    proj,
  );
  // Escapes `src/` → NOT allowed by the `src/*` rule (falls to default deny).
  expect((await sandbox.check("edit", { path: "src/../out.ts" })).allowed).toBe(false);
  // A genuine in-`src` file is still allowed.
  expect((await sandbox.check("edit", { path: "src/app.ts" })).allowed).toBe(true);

  // False-deny direction: a `../` spelling escaping a denied dir is NOT denied.
  const denySecrets = new PermissionChecker(
    [{ tool: "edit", match: "secrets/*", action: "deny" }],
    undefined,
    "allow",
    proj,
  );
  expect((await denySecrets.check("edit", { path: "secrets/../src/ok.ts" })).allowed).toBe(true);
  expect((await denySecrets.check("edit", { path: "secrets/key" })).allowed).toBe(false);
});

test("a planted in-tree symlink can't escape an allow-list sandbox (confinement to the real target)", async () => {
  // deny-by-default + allow `src/*`; a symlink `src/escape -> <outside>` must NOT
  // let a write to `src/escape/x` (which lands OUTSIDE) match the `src/*` allow.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vibe-perm-esc2-")));
  const proj = join(base, "proj");
  const outside = join(base, "outside");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(proj, "src", "escape"));
  const sandbox = new PermissionChecker(
    [{ tool: "write", match: "src/*", action: "allow" }],
    () => false,
    "deny",
    proj,
  );
  // Escapes the sandbox via the symlink → NOT allowed.
  expect((await sandbox.check("write", { path: "src/escape/pwned" })).allowed).toBe(false);
  // A genuine in-`src` file is still allowed.
  expect((await sandbox.check("write", { path: "src/app.ts" })).allowed).toBe(true);
});

test("the cwd-relative path form does not cause a path rule to falsely match a URL tool", async () => {
  // Adding the relative-path scope form must not make a path-shaped deny rule
  // catch a network tool whose scope is a URL that happens to share the substring.
  const checker = new PermissionChecker(
    [{ tool: "webfetch", match: "config/*", action: "deny" }],
    undefined,
    "allow",
    "/home/user/project",
  );
  expect((await checker.check("webfetch", { url: "https://x.dev/config/y" })).allowed).toBe(true);
});

test("path-scoped deny can't be evaded by an equivalent path spelling", async () => {
  const checker = new PermissionChecker(
    [{ tool: "write", match: "/etc/*", action: "deny" }],
    undefined,
    "allow",
    "/home/user/project/pkg", // canonicalization base (the session cwd)
  );
  // A relative traversal that resolves into /etc is denied (was evaded: the raw
  // string `../../../../etc/passwd` never matched `^/etc/.*$`).
  expect((await checker.check("write", { path: "../../../../etc/passwd" })).allowed).toBe(false);
  // A direct absolute path is denied too.
  expect((await checker.check("write", { path: "/etc/hosts" })).allowed).toBe(false);
  // An unrelated in-tree path is still allowed.
  expect((await checker.check("write", { path: "src/index.ts" })).allowed).toBe(true);
});

// ------------------------------------------- dangerouslyUnsandboxed escape hatch

test("dangerouslyUnsandboxed forces an EXPLICIT ask (fails closed) under auto", async () => {
  // approvalMode auto → defaultAction "allow": a normal bash call auto-allows
  // WITHOUT consulting the resolver. The unsandboxed variant must instead be
  // forced to an explicit ask, which a headless resolver (no human) denies.
  const seen: boolean[] = [];
  const checker = new PermissionChecker(
    [],
    (req) => {
      seen.push(req.explicit);
      return !req.explicit; // mirror the engine's headless #askPermission
    },
    "allow",
  );
  // Normal call: auto-allowed, resolver never consulted.
  expect((await checker.check("bash", { command: "git status" })).allowed).toBe(true);
  expect(seen).toHaveLength(0);
  // Unsandboxed variant: forced explicit ask → fails closed (denied).
  const res = await checker.check("bash", { command: "git status", dangerouslyUnsandboxed: true });
  expect(res.allowed).toBe(false);
  expect(seen).toEqual([true]); // the resolver saw explicit:true
});

test('a "!unsandboxed *" allow rule pre-authorizes the escape hatch; a normal allow does not', async () => {
  // The content-scoped rule targets the sentinel scope, so the flagged call is
  // allowed WITHOUT a prompt; a blanket name-only allow would NOT cover it.
  const authorized = new PermissionChecker(
    [{ tool: "bash", match: "!unsandboxed *", action: "allow" }],
    () => false, // would deny if it fell through to an ask
    "ask",
  );
  expect(
    (await authorized.check("bash", { command: "npm publish", dangerouslyUnsandboxed: true })).allowed,
  ).toBe(true);

  // A blanket name-only bash allow does NOT silently cover the unsafe variant:
  // it's still forced to an explicit ask (here denied).
  const blanket = new PermissionChecker(
    [{ tool: "bash", action: "allow" }],
    (req) => !req.explicit,
    "ask",
  );
  expect(
    (await blanket.check("bash", { command: "npm publish", dangerouslyUnsandboxed: true })).allowed,
  ).toBe(false);
  // …but the ordinary sandboxed form IS covered by that same blanket allow.
  expect((await blanket.check("bash", { command: "npm publish" })).allowed).toBe(true);
});

test('the "!unsandboxed *" rule does NOT match the ordinary sandboxed command', async () => {
  // The sentinel-scoped allow must not leak into normal calls: a plain bash call
  // has scope "npm publish" (no prefix), so the rule doesn't apply and the call
  // falls through to the default ask (here denied).
  const checker = new PermissionChecker(
    [{ tool: "bash", match: "!unsandboxed *", action: "allow" }],
    () => false,
    "ask",
  );
  expect((await checker.check("bash", { command: "npm publish" })).allowed).toBe(false);
});

test("a BROAD allow glob that also matches the bare command does NOT cover the escape hatch (fails closed)", async () => {
  // Regression: the fail-closed guard keyed on "no content-scoped rule applies",
  // but a broad allow (`match:"*"`, `match:"*npm*"`) DOES match the "!unsandboxed
  // <cmd>" scope, so it was "applicable" and silently green-lit the UNSAFE variant
  // with zero approval under auto/yolo/headless. A blanket allow that would also
  // cover the bare command must NOT pre-authorize the unsandboxed form.
  for (const match of ["*", "*npm*"]) {
    const checker = new PermissionChecker(
      [{ tool: "bash", match, action: "allow" }],
      (req) => !req.explicit, // mirror the engine's headless #askPermission
      "allow",
    );
    // The ordinary sandboxed form IS covered by the broad allow (no prompt).
    expect((await checker.check("bash", { command: "npm publish" })).allowed).toBe(true);
    // The unsandboxed variant is forced to an explicit ask → fails closed.
    const res = await checker.check("bash", { command: "npm publish", dangerouslyUnsandboxed: true });
    expect(res.allowed).toBe(false);
  }
});

test("a partial sentinel glob authorizes the escape hatch without leaking to the ordinary command", async () => {
  // A scoped allow that targets the "!unsandboxed " sentinel (matches the sentinel
  // form but NOT the bare command) is a deliberate pre-authorization of the unsafe
  // variant, so the flagged call is allowed WITHOUT a prompt…
  const checker = new PermissionChecker(
    [{ tool: "bash", match: "!unsandboxed npm*", action: "allow" }],
    () => false, // would deny if it fell through to an ask
    "ask",
  );
  expect(
    (await checker.check("bash", { command: "npm publish", dangerouslyUnsandboxed: true })).allowed,
  ).toBe(true);
  // …while the ORDINARY sandboxed command is untouched by the sentinel rule and
  // falls through to the default ask (here denied).
  expect((await checker.check("bash", { command: "npm publish" })).allowed).toBe(false);
});

test("a matching deny still wins over the escape hatch (deny is absolute)", async () => {
  const checker = new PermissionChecker(
    [{ tool: "bash", action: "deny" }],
    () => true,
    "allow",
  );
  const res = await checker.check("bash", { command: "rm -rf /", dangerouslyUnsandboxed: true });
  expect(res.allowed).toBe(false);
  expect(res.allowed === false && res.reason).toBe("denied by policy");
});
