import { test, expect } from "bun:test";
import {
  collectWorkspaceVersions,
  ensureShebang,
  generateNpmPackageJson,
  missingInlinedSymbols,
  OPTIONAL_DEP_NAMES,
  OPTIONAL_PEER_DEP_NAMES,
  REQUIRED_INLINED_SYMBOLS,
  resolveOptionalDeps,
  resolveOptionalPeerDeps,
  unresolvedAppSolidImports,
} from "./build-npm.ts";

test("collectWorkspaceVersions: root deps/devDeps win over per-package peers", () => {
  const versions = collectWorkspaceVersions([
    // root
    { devDependencies: { "@ai-sdk/anthropic": "^2.0.83", "@opentui/core": "^0.4.2" } },
    // a package declares a looser peer range — must NOT override the root pin
    { peerDependencies: { "@ai-sdk/anthropic": "^2.0.0" }, dependencies: { ai: "^5.0.0" } },
  ]);
  expect(versions["@ai-sdk/anthropic"]).toBe("^2.0.83");
  expect(versions["@opentui/core"]).toBe("^0.4.2");
  expect(versions.ai).toBe("^5.0.0");
});

test("resolveOptionalDeps: uses workspace versions, pins patched deps, falls back to * for unpinned runtime deps", () => {
  const versions = {
    "@ai-sdk/anthropic": "^2.0.83",
    "@ai-sdk/openai": "^2.0.109",
    "@ai-sdk/deepseek": "^1.0.44",
    "@ai-sdk/openai-compatible": "^1.0.41",
    "@opentui/core": "^0.4.2",
    "@opentui/solid": "^0.4.2",
    "solid-js": "^1.9.13",
    "web-tree-sitter": "0.25.10",
  };
  const opt = resolveOptionalDeps(versions, {
    "@opentui/core@0.4.2": "patches/@opentui%2Fcore@0.4.2.patch",
  });
  // Every advertised optional dep is present.
  for (const name of OPTIONAL_DEP_NAMES) expect(name in opt).toBe(true);
  // Provider SDKs are bundled into vibecodr.js, not installed as npm deps.
  expect(opt["@ai-sdk/anthropic"]).toBeUndefined();
  expect(opt["@ai-sdk/openai"]).toBeUndefined();
  expect(opt["@ai-sdk/deepseek"]).toBeUndefined();
  expect(opt["@ai-sdk/openai-compatible"]).toBeUndefined();
  expect(opt["@opentui/core"]).toBe("0.4.2");
  expect(opt["@opentui/solid"]).toBeUndefined();
  expect(opt["web-tree-sitter"]).toBe("0.25.10");
  // The repo doesn't pin this — fall back to `*`.
  expect(opt["@modelcontextprotocol/sdk"]).toBe("*");
  expect(opt["@huggingface/transformers"]).toBeUndefined();
  // Keys are sorted for a stable diff.
  expect(Object.keys(opt)).toEqual([...Object.keys(opt)].sort());
});

test("resolveOptionalPeerDeps: keeps heavy semantic-memory deps opt-in", () => {
  const peers = resolveOptionalPeerDeps({});
  for (const name of OPTIONAL_PEER_DEP_NAMES) expect(name in peers).toBe(true);
  expect(peers["@huggingface/transformers"]).toBe("*");
});

test("generateNpmPackageJson produces the published shape", () => {
  const pkg = generateNpmPackageJson({
    version: "0.3.0",
    rootPkg: {
      license: "MIT",
      description: "A model-agnostic CLI coding agent for the terminal.",
      engines: { bun: ">=1.2.0" },
      overrides: { "@babel/core": "7.29.6" },
      patchedDependencies: {
        "@opentui/core@0.4.2": "patches/@opentui%2Fcore@0.4.2.patch",
      },
    },
    optionalDependencies: { "@ai-sdk/anthropic": "^2.0.83" },
    optionalPeerDependencies: { "@huggingface/transformers": "*" },
  });
  expect(pkg.name).toBe("vibe-codr");
  expect(pkg.version).toBe("0.3.0");
  expect(pkg.bin).toEqual({ vibecodr: "vibecodr.js", vibe: "vibecodr.js" });
  expect(pkg.engines).toEqual({ bun: ">=1.2.0" });
  expect(pkg.license).toBe("MIT");
  expect(pkg.type).toBe("module");
  expect(pkg.files).toContain("vibecodr.js");
  expect(pkg.files).toContain("patches");
  expect(pkg.optionalDependencies).toEqual({ "@ai-sdk/anthropic": "^2.0.83" });
  expect(pkg.overrides).toBeUndefined();
  expect(pkg.peerDependencies).toEqual({ "@huggingface/transformers": "*" });
  expect(pkg.peerDependenciesMeta).toEqual({ "@huggingface/transformers": { optional: true } });
  expect(pkg.patchedDependencies).toEqual({
    "@opentui/core@0.4.2": "patches/@opentui%2Fcore@0.4.2.patch",
  });
  // Falls back to a git repository URL when root has none.
  expect((pkg.repository as { url: string }).url).toContain("github.com");
});

test("ensureShebang only prepends when missing", () => {
  expect(ensureShebang("console.log(1)")).toBe("#!/usr/bin/env bun\nconsole.log(1)");
  expect(ensureShebang("#!/usr/bin/env bun\ncode")).toBe("#!/usr/bin/env bun\ncode");
});

test("missingInlinedSymbols catches an externalized SDK the module-id grep can't", () => {
  // An INLINED bundle carries the SDKs' internal class exports.
  const inlined = [
    "class AnthropicLanguageModel {}",
    "class OpenAICompatibleChatLanguageModel {}",
  ].join("\n");
  expect(missingInlinedSymbols(inlined)).toEqual([]);

  // The 0ebce43 regression: `--external` drops the SDK source, so the internal
  // symbols vanish — BUT the module ids AND factory names still appear as string
  // literals (they live in defs.ts, always bundled). The OLD guard grepped for
  // those and passed anyway; this predicate must FAIL.
  const externalized = [
    'import "@ai-sdk/anthropic";',
    'import "@ai-sdk/openai-compatible";',
    'const F = { factory: "createAnthropic" };',
    'const G = { factory: "createOpenAICompatible" };',
  ].join("\n");
  expect(externalized).toContain("@ai-sdk/anthropic"); // module ids survive externalizing
  expect(externalized).toContain("createOpenAICompatible"); // factory names survive too
  expect(missingInlinedSymbols(externalized)).toEqual([...REQUIRED_INLINED_SYMBOLS]);
});

test("unresolvedAppSolidImports rejects externalized @opentui/solid runtime imports", () => {
  expect(
    unresolvedAppSolidImports(`
      import { createCliRenderer } from "@opentui/core";
      import { createSignal } from "solid-js";
      import Parser from "web-tree-sitter";
      // Bundled source-path comments may mention @opentui/solid without importing it.
    `),
  ).toEqual([]);
  expect(
    unresolvedAppSolidImports(`
      import { render } from "@opentui/solid";
      const renderer = import("@opentui/solid/renderer");
    `),
  ).toEqual(["@opentui/solid", "@opentui/solid/renderer"]);
});
