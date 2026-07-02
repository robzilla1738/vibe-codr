import { test, expect } from "bun:test";
import { LspConfigSchema } from "@vibe/config";
import { languageForPath, resolveServer, type WhichFn } from "./registry.ts";

/** A which that reports the given commands as present (everything else absent). */
function whichWith(present: string[]): WhichFn {
  return (cmd) => (present.includes(cmd) ? `/usr/bin/${cmd}` : null);
}

const cfg = (partial: Record<string, unknown> = {}) => LspConfigSchema.parse(partial);

test("languageForPath maps extensions to language keys (and ignores the rest)", () => {
  expect(languageForPath("/a/b/foo.py")).toBe("py");
  expect(languageForPath("/a/b/foo.pyi")).toBe("py");
  expect(languageForPath("/a/b/main.go")).toBe("go");
  expect(languageForPath("/a/b/lib.rs")).toBe("rust");
  expect(languageForPath("/a/b/app.cpp")).toBe("cpp");
  expect(languageForPath("/a/b/App.java")).toBe("java");
  // No mapping → undefined (TS/JS is handled by the composite's fast path).
  expect(languageForPath("/a/b/x.ts")).toBeUndefined();
  expect(languageForPath("/a/b/README.md")).toBeUndefined();
  expect(languageForPath("/a/b/Makefile")).toBeUndefined();
});

test("resolveServer picks the FIRST present candidate in preference order", () => {
  // basedpyright present → it wins over pyright/pylsp.
  const both = resolveServer("py", cfg(), whichWith(["basedpyright-langserver", "pyright-langserver"]));
  expect(both?.command).toBe("basedpyright-langserver");
  expect(both?.args).toEqual(["--stdio"]);
  expect(both?.languageId).toBe("python");

  // Only the older pyright present → it's chosen (candidate ordering respected).
  const older = resolveServer("py", cfg(), whichWith(["pyright-langserver"]));
  expect(older?.command).toBe("pyright-langserver");
});

test("resolveServer returns undefined when no candidate binary is present", () => {
  expect(resolveServer("py", cfg(), whichWith([]))).toBeUndefined();
  expect(resolveServer("rust", cfg(), whichWith([]))).toBeUndefined();
});

test("a config command override REPLACES the candidate list (and is which-probed)", () => {
  const c = cfg({ servers: { py: { command: "my-pyright", args: ["--stdio", "--x"] } } });
  const resolved = resolveServer("py", c, whichWith(["my-pyright", "basedpyright-langserver"]));
  expect(resolved?.command).toBe("my-pyright");
  expect(resolved?.args).toEqual(["--stdio", "--x"]);
  // The override binary being ABSENT does NOT silently fall back to defaults —
  // the user's explicit choice is respected (undefined, no server).
  expect(resolveServer("py", c, whichWith(["basedpyright-langserver"]))).toBeUndefined();
});

test("an args-only override tweaks the resolved default's flags", () => {
  const c = cfg({ servers: { py: { args: ["--extra"] } } });
  const resolved = resolveServer("py", c, whichWith(["basedpyright-langserver"]));
  expect(resolved?.command).toBe("basedpyright-langserver");
  expect(resolved?.args).toEqual(["--extra"]);
});

test("disabledLanguages and per-language enabled:false both yield no server", () => {
  const disabled = cfg({ disabledLanguages: ["py"] });
  expect(resolveServer("py", disabled, whichWith(["basedpyright-langserver"]))).toBeUndefined();

  const off = cfg({ servers: { go: { enabled: false } } });
  expect(resolveServer("go", off, whichWith(["gopls"]))).toBeUndefined();
});

test("an override for an unknown language is honored with the lang key as languageId", () => {
  const c = cfg({ servers: { nim: { command: "nimlangserver" } } });
  const resolved = resolveServer("nim", c, whichWith(["nimlangserver"]));
  expect(resolved?.command).toBe("nimlangserver");
  expect(resolved?.languageId).toBe("nim");
});
