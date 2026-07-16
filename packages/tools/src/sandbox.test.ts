import { test, expect } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  annotateDenial,
  bwrapArgs,
  policyForChecks,
  resolveSandboxPolicy,
  type SandboxMode,
  type SandboxNetwork,
  type SandboxPolicy,
  seatbeltProfile,
  wrapCommand,
} from "./sandbox.ts";

/** A fixed, machine-independent policy for the pure builder snapshots. */
function policy(mode: SandboxMode, network: SandboxNetwork): SandboxPolicy {
  return {
    mode,
    network,
    writablePaths: ["/work", "/tmp/x"],
    backend: "seatbelt",
    available: true,
  };
}

// ----------------------------------------------------------- seatbelt snapshots

test("seatbeltProfile: workspace-write × network on", () => {
  expect(seatbeltProfile(policy("workspace-write", "on"), "/work")).toBe(
    [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      '(allow file-write* (subpath "/work"))',
      '(allow file-write* (subpath "/tmp/x"))',
      "(allow network*)",
    ].join("\n"),
  );
});

test("seatbeltProfile: workspace-write × network off omits network (default-deny bites)", () => {
  const p = seatbeltProfile(policy("workspace-write", "off"), "/work");
  expect(p).not.toContain("(allow network*)");
  expect(p).toContain('(allow file-write* (subpath "/work"))');
});

test("seatbeltProfile: read-only grants NO writes (only reads + process)", () => {
  expect(seatbeltProfile(policy("read-only", "on"), "/work")).toBe(
    [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      "(allow network*)",
    ].join("\n"),
  );
  expect(seatbeltProfile(policy("read-only", "off"), "/work")).not.toContain("(allow network*)");
});

// -------------------------------------------------------------- bwrap snapshots

test("bwrapArgs: workspace-write binds each root read-write; network off unshares net", () => {
  expect(bwrapArgs(policy("workspace-write", "off"), "/work")).toEqual([
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    "/work",
    "/work",
    "--bind",
    "/tmp/x",
    "/tmp/x",
    "--unshare-net",
  ]);
});

test("bwrapArgs: network on keeps net; read-only binds nothing writable", () => {
  expect(bwrapArgs(policy("workspace-write", "on"), "/work")).not.toContain("--unshare-net");
  expect(bwrapArgs(policy("read-only", "off"), "/work")).toEqual([
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-net",
  ]);
  expect(bwrapArgs(policy("read-only", "on"), "/work")).toEqual([
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ]);
});

// -------------------------------------------------------- resolveSandboxPolicy

const CFG = {
  mode: "workspace-write" as SandboxMode,
  network: "on" as SandboxNetwork,
  writablePaths: [] as string[],
};

test("resolveSandboxPolicy: win32 is unavailable with a human warning", () => {
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "win32",
    which: () => null,
    env: {},
  });
  expect(p.available).toBe(false);
  expect(p.backend).toBe("none");
  expect(p.warning).toContain("win32");
});

test("resolveSandboxPolicy: darwin picks seatbelt when sandbox-exec is present", () => {
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "darwin",
    which: (b) => (b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
    env: {},
  });
  expect(p).toMatchObject({ available: true, backend: "seatbelt", mode: "workspace-write" });
});

test("resolveSandboxPolicy: darwin without the binary warns + is unavailable", () => {
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "darwin",
    which: () => null,
    env: {},
  });
  expect(p.available).toBe(false);
  expect(p.warning).toContain("sandbox-exec");
});

test("resolveSandboxPolicy: linux picks bwrap / warns when absent", () => {
  const ok = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : null),
    env: {},
    smokeBwrap: () => true,
  });
  expect(ok).toMatchObject({ available: true, backend: "bwrap" });
  const missing = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: () => null,
    env: {},
  });
  expect(missing.available).toBe(false);
  expect(missing.warning).toContain("bwrap");
});

test("resolveSandboxPolicy: linux bwrap present but the userns smoke FAILS → unavailable + userns warning", () => {
  // bwrap on the PATH but a minimal launch fails (unprivileged user namespaces
  // disabled) must degrade to an honest warning, not a confusing EPERM on every
  // sandboxed command. Binary presence alone must NOT report available:true.
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : null),
    env: {},
    smokeBwrap: () => false,
  });
  expect(p.available).toBe(false);
  expect(p.backend).toBe("none");
  expect(p.warning).toContain("user namespace");
});

test("resolveSandboxPolicy: linux bwrap present AND the userns smoke passes → available", () => {
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : null),
    env: {},
    smokeBwrap: () => true,
  });
  expect(p).toMatchObject({ available: true, backend: "bwrap" });
});

test("resolveSandboxPolicy: darwin never runs the bwrap smoke test", () => {
  // The userns gate is Linux-only; darwin availability is unchanged and must not
  // invoke the smoke runner at all (a throwing runner proves it is never called).
  const p = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "darwin",
    which: (b) => (b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
    env: {},
    smokeBwrap: () => {
      throw new Error("smoke must not run on darwin");
    },
  });
  expect(p).toMatchObject({ available: true, backend: "seatbelt" });
});

test("resolveSandboxPolicy: off mode is always available with no backend/warning", () => {
  const p = resolveSandboxPolicy(
    { ...CFG, mode: "off" },
    {
      cwd: "/work",
      platform: "win32",
      which: () => null,
      env: {},
    },
  );
  expect(p).toMatchObject({ mode: "off", available: true, backend: "none" });
  expect(p.warning).toBeUndefined();
});

test("resolveSandboxPolicy: writable roots = cwd + tmp + stateDirs + cfg, absolute + deduped", () => {
  const p = resolveSandboxPolicy(
    { ...CFG, writablePaths: ["/extra", "/work"] },
    {
      cwd: "/work",
      stateDirs: ["/state", "/work"],
      platform: "linux",
      which: () => "/usr/bin/bwrap",
      env: {},
      smokeBwrap: () => true,
    },
  );
  const realTmp = existsSync(tmpdir()) ? realpathSync(tmpdir()) : resolve(tmpdir());
  expect(p.writablePaths).toContain(resolve("/work")); // non-existent → lexical
  expect(p.writablePaths).toContain(realTmp); // existing → realpath-canonicalized
  expect(p.writablePaths).toContain(resolve("/state"));
  expect(p.writablePaths).toContain(resolve("/extra"));
  // "/work" appears once despite arriving from cwd, stateDirs, and cfg.
  expect(p.writablePaths.filter((x) => x === resolve("/work"))).toHaveLength(1);
});

test("resolveSandboxPolicy: VIBE_SANDBOX env overrides config mode both ways", () => {
  // Override tightens an off config to read-only.
  const tightened = resolveSandboxPolicy(
    { ...CFG, mode: "off" },
    {
      cwd: "/work",
      platform: "linux",
      which: () => "/usr/bin/bwrap",
      env: { VIBE_SANDBOX: "read-only" },
      smokeBwrap: () => true,
    },
  );
  expect(tightened.mode).toBe("read-only");
  expect(tightened.available).toBe(true);
  // Override loosens a workspace-write config to off.
  const off = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: () => "/usr/bin/bwrap",
    env: { VIBE_SANDBOX: "off" },
  });
  expect(off.mode).toBe("off");
  // A junk override is ignored (config wins).
  const junk = resolveSandboxPolicy(CFG, {
    cwd: "/work",
    platform: "linux",
    which: () => "/usr/bin/bwrap",
    env: { VIBE_SANDBOX: "nonsense" },
    smokeBwrap: () => true,
  });
  expect(junk.mode).toBe("workspace-write");
});

// ------------------------------------------------------------- policyForChecks

test("policyForChecks: read-only upgrades to workspace-write; others unchanged", () => {
  const ro = policy("read-only", "off");
  const upgraded = policyForChecks(ro);
  expect(upgraded.mode).toBe("workspace-write");
  // Every other field is preserved.
  expect(upgraded.network).toBe("off");
  expect(upgraded.writablePaths).toEqual(ro.writablePaths);
  expect(policyForChecks(policy("workspace-write", "on")).mode).toBe("workspace-write");
  expect(policyForChecks({ ...policy("off", "on"), mode: "off" }).mode).toBe("off");
});

// -------------------------------------------------------------- annotateDenial

test("annotateDenial: appends ONLY on a sandboxed nonzero exit with a denial signature", () => {
  const p = policy("workspace-write", "off");
  // EPERM / Operation not permitted / bwrap: all trip it.
  expect(annotateDenial("uh oh: EPERM", 1, p)).toContain("[vibe sandbox]");
  expect(annotateDenial("open: Operation not permitted", 1, p)).toContain("[vibe sandbox]");
  expect(annotateDenial("bwrap: Creating new namespace failed", 1, p)).toContain("[vibe sandbox]");
  // No signature → untouched.
  expect(annotateDenial("bash: foo: command not found", 127, p)).toBe(
    "bash: foo: command not found",
  );
  // Clean exit → untouched even with the word EPERM present.
  expect(annotateDenial("EPERM", 0, p)).toBe("EPERM");
  // Off / unavailable policy → never annotate.
  expect(annotateDenial("EPERM", 1, { ...p, mode: "off" })).toBe("EPERM");
  expect(annotateDenial("EPERM", 1, { ...p, available: false })).toBe("EPERM");
});

// ---------------------------------------------------------------- wrapCommand

test("wrapCommand: off / unavailable → the unchanged base argv", () => {
  const base = ["bash", "-lc", "echo hi"];
  expect(
    wrapCommand({ ...policy("off", "on"), mode: "off" }, { cwd: "/work", command: "echo hi" }),
  ).toEqual(base);
  expect(
    wrapCommand(
      { ...policy("workspace-write", "on"), available: false },
      { cwd: "/work", command: "echo hi" },
    ),
  ).toEqual(base);
});

test("wrapCommand: seatbelt prefixes sandbox-exec -p <profile>; bwrap prefixes bwrap <args>", () => {
  const sb = wrapCommand(
    { ...policy("workspace-write", "on"), backend: "seatbelt" },
    { cwd: "/work", command: "echo hi" },
  );
  expect(sb.slice(0, 2)).toEqual(["sandbox-exec", "-p"]);
  expect(sb[2]).toContain("(deny default)");
  expect(sb.slice(-3)).toEqual(["bash", "-lc", "echo hi"]);

  const bw = wrapCommand(
    { ...policy("workspace-write", "off"), backend: "bwrap" },
    { cwd: "/work", command: "echo hi" },
  );
  expect(bw[0]).toBe("bwrap");
  expect(bw).toContain("--unshare-net");
  expect(bw.slice(-3)).toEqual(["bash", "-lc", "echo hi"]);
});
